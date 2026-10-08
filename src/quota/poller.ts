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

  constructor({ store, refresher, client, intervalMs }: QuotaPollerDeps) {
    this.store = store;
    this.refresher = refresher;
    this.client = client;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        logger.error({ err: (err as Error).message }, 'quota: runOnce crashed');
      });
    }, this.intervalMs);
    // Don't keep the event loop alive solely for the poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    for (const acc of this.store.listAccounts()) {
      if (acc.status !== 'active') continue;
      try {
        const token = await this.refresher.getAccessToken(acc.id);
        const lc = await this.client.loadCodeAssist(CLIENT_METADATA, token);
        const project = lc.cloudaicompanionProject;
        if (!project) {
          logger.debug({ id: acc.id, email: acc.email }, 'quota: no project, skipping');
          continue;
        }
        const q = await this.client.retrieveUserQuota({ project }, token);
        for (const b of q.buckets ?? []) {
          if (!b.modelId) continue;
          const resetAt = b.resetTime ? Date.parse(b.resetTime) : NaN;
          this.store.recordQuotaSnapshot(
            acc.id,
            b.modelId,
            b.remainingAmount ?? 0,
            b.totalAmount ?? 0,
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
}
