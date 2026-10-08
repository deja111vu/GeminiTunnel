// keyPool.ts — round-robin pool of Google API keys for the Gemini Developer API.
// Per-model cooldown: a key can be in cooldown for one model but available
// for another (matches Google's per-key per-model rate limits).
// Per-key "bad" state with TTL after 401/403.
// Startup jitter: each key gets a random nextAvailableAfter (0..jitterMs)
// to prevent thundering herd on a fresh boot.

export interface KeyPoolOptions {
  keys: string[];
  cooldownMs: number;
  badTtlMs: number;
  jitterMs?: number; // default 30_000
  now?: () => number;
}

export interface PickedKey {
  key: string;
}

export interface KeyPoolSummary {
  configured: number;
  cooldown: number;
  bad: number;
}

export class KeyPool {
  private readonly keys: readonly string[];
  private readonly cooldownMs: number;
  private readonly badTtlMs: number;
  private readonly jitterMs: number;
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
    for (const k of this.keys) {
      // Bad?
      const badUntil = this.badUntil.get(k);
      if (badUntil !== undefined && badUntil > t) continue;
      // Startup jitter?
      const avail = this.nextAvailableAfter.get(k);
      if (avail !== undefined && avail > t) continue;
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
      throw new Error('no_api_key_available');
    }
    // Sort by seq ascending (oldest pick first), then by key for determinism.
    candidates.sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
    const chosen = candidates[0];
    this.seqByKey.set(chosen.key, this.nextSeq++);
    return { key: chosen.key };
  }

  recordRateLimit(key: string, model: string, durationMs?: number): void {
    const t = this.now();
    const until = t + (durationMs ?? this.cooldownMs);
    let m = this.cooldownByModel.get(key);
    if (!m) {
      m = new Map();
      this.cooldownByModel.set(key, m);
    }
    m.set(model, until);
  }

  clearCooldown(key: string, model: string): void {
    this.cooldownByModel.get(key)?.delete(model);
  }

  markBad(key: string, durationMs?: number): void {
    const t = this.now();
    this.badUntil.set(key, t + (durationMs ?? this.badTtlMs));
  }

  summary(): KeyPoolSummary {
    const t = this.now();
    let bad = 0;
    for (const [, until] of this.badUntil) {
      if (until > t) bad++;
    }
    return { configured: this.keys.length, cooldown: 0, bad };
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
