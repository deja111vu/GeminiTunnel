import type { Store } from '../accounts/store.js';
import type { RefresherLike } from '../accounts/pool.js';
import type { CodeAssistClient } from '../api/codeassist/client.js';
import { logger } from '../logger.js';

// Standard CLI metadata used for loadCodeAssist. The upstream doesn't care
// about specific values as long as the structure matches the protocol —
// we mirror the values gemini-cli sends so quota lookups behave the same.
const CLIENT_METADATA = {
  metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
};

// Bounded concurrency for per-account quota fetches. 8 simultaneous
// requests is high enough that a 200-account fleet finishes a cycle
// quickly, low enough that we don't exhaust upstream sockets.
const POLL_CONCURRENCY = 8;

export interface QuotaPollerDeps {
  store: Store;
  refresher: RefresherLike;
  client: CodeAssistClient;
  intervalMs: number;
}

// Periodically pulls the current quota state for every active account
// and writes one row per model into account_quota_snapshots. Independent
// of the request path — the admin UI reads the latest snapshot, the
// request path still relies on 429 events from Pool.recordRateLimit.
export class QuotaPoller {
  private readonly store: Store;
  private readonly refresher: RefresherLike;
  private readonly client: CodeAssistClient;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Guards against overlapping runs when a cycle is slower than the
  // interval. Without this, slow upstream can stack concurrent runs
  // and exhaust the socket pool.
  private inFlight: Promise<void> | null = null;

  constructor({ store, refresher, client, intervalMs }: QuotaPollerDeps) {
    this.store = store;
    this.refresher = refresher;
    this.client = client;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    // Fire one immediately so a fresh deploy doesn't sit with empty
    // quota for the full interval before the first observation. Route
    // through the inFlight guard so the immediate run cannot overlap
    // an interval tick that fires while it is still running.
    this.scheduleRun();
    this.timer = setInterval(() => this.scheduleRun(), this.intervalMs);
    // Don't keep the event loop alive solely for the poller.
    this.timer.unref?.();
  }

  private scheduleRun(): void {
    if (this.inFlight) {
      logger.debug('quota: previous run still in flight, skipping tick');
      return;
    }
    this.inFlight = this.runOnce().finally(() => {
      this.inFlight = null;
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    const accounts = this.store.listAccounts().filter((a) => a.status === 'active');
    // Run with bounded concurrency so one slow account does not block
    // the whole batch (sequential O(N) was the previous shape).
    await runWithConcurrency(accounts, POLL_CONCURRENCY, (acc) => this.pollOne(acc));
  }

  private async pollOne(acc: { id: number; email: string }): Promise<void> {
    try {
      const token = await this.refresher.getAccessToken(acc.id);
      const lc = await this.client.loadCodeAssist(CLIENT_METADATA, token);
      const project = lc.cloudaicompanionProject;
      if (!project) {
        logger.debug({ id: acc.id, email: acc.email }, 'quota: no project, skipping');
        return;
      }
      const q = await this.client.retrieveUserQuota({ project }, token);
      for (const b of q.buckets ?? []) {
        if (!b.modelId) continue;
        // Skip buckets where the upstream didn't actually report amounts —
        // recording remaining=0/total=0 would falsely flag the account
        // as exhausted in the admin UI.
        if (typeof b.remainingAmount !== 'number' || typeof b.totalAmount !== 'number') {
          logger.debug({ id: acc.id, model: b.modelId }, 'quota: bucket missing amounts, skipping');
          continue;
        }
        const resetAt = b.resetTime ? Date.parse(b.resetTime) : NaN;
        this.store.recordQuotaSnapshot(
          acc.id,
          b.modelId,
          b.remainingAmount,
          b.totalAmount,
          Number.isFinite(resetAt) ? resetAt : undefined,
        );
      }
    } catch (err) {
      // Isolate: one account's failure must not skip the rest.
      logger.warn(
        { id: acc.id, email: acc.email, err: (err as Error).message },
        'quota: poll failed for account',
      );
    }
  }
}

// ponytail: minimal semaphore — no abort/timeout needed, the caller
// already has try/catch on each task. 8-way concurrency is a constant
// (POLL_CONCURRENCY) so a plain windowed loop is enough.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}
