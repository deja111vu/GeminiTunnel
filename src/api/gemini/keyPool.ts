// keyPool.ts — round-robin pool of Google API keys for the Gemini Developer API.
// Per-model cooldown: a key can be in cooldown for one model but available
// for another (matches Google's per-key per-model rate limits).
// Per-key "bad" state with TTL after 401/403.
// Startup jitter: each key gets a random nextAvailableAfter (0..jitterMs)
// to prevent thundering herd on a fresh boot.

export type NoKeyReason = 'all_bad' | 'all_cooldown' | 'unknown';

export class NoKeyAvailableError extends Error {
  constructor(
    public readonly reason: NoKeyReason,
    public readonly retryAfterMs: number | null,
  ) {
    super(`no_api_key_available: ${reason}`);
  }
}

export interface KeyPoolOptions {
  keys: string[];
  cooldownMs: number;
  badTtlMs: number;
  jitterMs?: number; // default 30_000
  now?: () => number;
  // Per-key cap on the number of distinct `model` strings kept in
  // `cooldownByModel`. Defaults to 1000. Bounded so a caller that
  // (ab)uses 429 responses to force `recordRateLimit` with unique
  // model names cannot grow the Map without limit. When the cap is
  // reached, the entry with the smallest `until` is evicted (i.e. the
  // one that would have expired soonest anyway).
  maxModelsPerKey?: number;
}

export interface PickedKey {
  key: string;
}

export interface KeyPoolSummary {
  configured: number;
  cooldown: number;
  bad: number;
}

// Deterministic string comparator: < / > / ===, no locale sensitivity so
// test runs and CI agree on tie-break ordering.
function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class KeyPool {
  private readonly keys: readonly string[];
  private readonly cooldownMs: number;
  private readonly badTtlMs: number;
  private readonly jitterMs: number;
  private readonly maxModelsPerKey: number;
  private readonly now: () => number;
  // Monotonic counter for round-robin tie-break.
  private nextSeq = 1;
  private readonly seqByKey = new Map<string, number>();
  // Per-model cooldown: key -> (model -> untilMs)
  private readonly cooldownByModel = new Map<string, Map<string, number>>();
  // Per-key bad: key -> untilMs
  private readonly badUntil = new Map<string, number>();
  // Per-key startup jitter: key -> availableAtMs
  private readonly nextAvailableAfter = new Map<string, number>();

  constructor(opts: KeyPoolOptions) {
    this.keys = Object.freeze([...opts.keys]);
    this.cooldownMs = opts.cooldownMs;
    this.badTtlMs = opts.badTtlMs;
    this.jitterMs = opts.jitterMs ?? 30_000;
    this.maxModelsPerKey = opts.maxModelsPerKey ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    if (this.keys.length > 0) {
      this.initJitter();
    }
  }

  private initJitter(): void {
    const t = this.now();
    for (const k of this.keys) {
      this.nextAvailableAfter.set(k, t + Math.floor(Math.random() * this.jitterMs));
    }
  }

  pick(model?: string): PickedKey {
    const t = this.now();
    const candidates: { key: string; seq: number }[] = [];
    let anyBadOrJitter = false;
    for (const k of this.keys) {
      // Bad?
      const badUntil = this.badUntil.get(k);
      if (badUntil !== undefined && badUntil > t) { anyBadOrJitter = true; continue; }
      // Startup jitter?
      const avail = this.nextAvailableAfter.get(k);
      if (avail !== undefined && avail > t) { anyBadOrJitter = true; continue; }
      // Per-model cooldown?
      if (model !== undefined) {
        const modelMap = this.cooldownByModel.get(k);
        const until = modelMap?.get(model);
        if (until !== undefined && until > t) continue;
      }
      const seq = this.seqByKey.get(k) ?? 0;
      candidates.push({ key: k, seq });
    }
    if (candidates.length === 0) {
      const bad = this.minBadExpiry();
      const cool = model !== undefined ? this.minCooldownExpiry(model) : null;
      // Prefer the longer wait (bad > cooldown) so the client doesn't retry
      // too soon. If only cooldown applies, use it. If only bad, use that.
      let retryAfterMs: number | null = null;
      let reason: NoKeyReason;
      if (anyBadOrJitter && bad !== null) {
        retryAfterMs = bad;
        reason = 'all_bad';
      } else if (cool !== null) {
        retryAfterMs = cool;
        reason = 'all_cooldown';
      } else if (bad !== null) {
        retryAfterMs = bad;
        reason = 'all_bad';
      } else {
        reason = 'unknown';
      }
      throw new NoKeyAvailableError(reason, retryAfterMs);
    }
    // Sort by seq ascending (oldest pick first), then by key for determinism.
    candidates.sort((a, b) => a.seq - b.seq || cmpKey(a.key, b.key));
    const chosen = candidates[0];
    this.seqByKey.set(chosen.key, this.nextSeq++);
    return { key: chosen.key };
  }

  recordRateLimit(key: string, model: string, durationMs?: number): void {
    const t = this.now();
    const newUntil = t + (durationMs ?? this.cooldownMs);
    let m = this.cooldownByModel.get(key);
    if (!m) {
      m = new Map();
      this.cooldownByModel.set(key, m);
    }
    // Take the later of the existing `until` and `newUntil` so a fresh 429
    // doesn't shorten an already-active window — matches Google's behaviour
    // where Retry-After is the *minimum* remaining time.
    const existing = m.get(model);
    m.set(model, existing !== undefined && existing > newUntil ? existing : newUntil);
    // Bound the per-key per-model Map. Without this, a caller that forces
    // a 429 on each request with a unique `model` string would grow the
    // Map without limit. Evict the entry with the smallest `until` (i.e.
    // the one that would expire soonest anyway) until we're under the cap.
    while (m.size > this.maxModelsPerKey) {
      let victimKey: string | null = null;
      let victimUntil = Number.POSITIVE_INFINITY;
      for (const [mk, mu] of m) {
        if (mu < victimUntil) {
          victimUntil = mu;
          victimKey = mk;
        }
      }
      if (victimKey === null) break;
      m.delete(victimKey);
    }
  }

  clearCooldown(key: string, model: string): void {
    this.cooldownByModel.get(key)?.delete(model);
  }

  markBad(key: string, durationMs?: number): void {
    const t = this.now();
    this.badUntil.set(key, t + (durationMs ?? this.badTtlMs));
    // A "bad" key overrides any per-model cooldown for that key — when the
    // bad TTL expires, the key should be available again, not stuck on an
    // older cooldown entry that the caller never cleared.
    this.cooldownByModel.delete(key);
  }

  summaryForModel(model: string): KeyPoolSummary {
    const t = this.now();
    let bad = 0;
    let cooldown = 0;
    for (const k of this.keys) {
      const badUntil = this.badUntil.get(k);
      if (badUntil !== undefined && badUntil > t) bad++;
      const modelMap = this.cooldownByModel.get(k);
      const until = modelMap?.get(model);
      if (until !== undefined && until > t) cooldown++;
    }
    return { configured: this.keys.length, cooldown, bad };
  }

  // Aggregate cooldown across ALL models for /health visibility.
  // Counts each key at most once (a key in cooldown for any model is "in cooldown").
  summaryForAllModels(): KeyPoolSummary {
    const t = this.now();
    let bad = 0;
    let cooldown = 0;
    for (const k of this.keys) {
      const badUntil = this.badUntil.get(k);
      if (badUntil !== undefined && badUntil > t) bad++;
      const modelMap = this.cooldownByModel.get(k);
      if (modelMap) {
        for (const [, until] of modelMap) {
          if (until > t) { cooldown++; break; }
        }
      }
    }
    return { configured: this.keys.length, cooldown, bad };
  }

  // Min time-to-expiry across all bad keys (ms), or null if no bad keys.
  minBadExpiry(): number | null {
    const t = this.now();
    let min: number | null = null;
    for (const [, until] of this.badUntil) {
      if (until > t) {
        const left = until - t;
        if (min === null || left < min) min = left;
      }
    }
    return min;
  }

  // Min time-to-expiry across all keys in cooldown for `model` (ms), or null.
  minCooldownExpiry(model: string): number | null {
    const t = this.now();
    let min: number | null = null;
    for (const k of this.keys) {
      const modelMap = this.cooldownByModel.get(k);
      const until = modelMap?.get(model);
      if (until !== undefined && until > t) {
        const left = until - t;
        if (min === null || left < min) min = left;
      }
    }
    return min;
  }
}
