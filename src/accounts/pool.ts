import type { Store, Account } from './store.js';

export interface RefresherLike {
  getAccessToken: (accountId: number) => Promise<string>;
}

export interface PickedAccount {
  accountId: number;
  email: string;
  token: string;
}

export interface AccountPoolOptions {
  store: Store;
  refresher: RefresherLike;
  cooldownMs: number;
}

export class AccountPool {
  private readonly store: Store;
  private readonly refresher: RefresherLike;
  private readonly cooldownMs: number;

  constructor({ store, refresher, cooldownMs }: AccountPoolOptions) {
    this.store = store;
    this.refresher = refresher;
    this.cooldownMs = cooldownMs;
  }

  // Pick the most-eligible active account.
  // Eligibility: status=active AND (cooldownUntil is null OR cooldownUntil < now).
  // Tie-breaker: oldest lastUsedAt first (LRU); null counts as oldest.
  // Falls back to the next candidate if the chosen one throws on token refresh.
  async pick(): Promise<PickedAccount> {
    const now = Date.now();
    const all = this.store.listAccounts();
    const eligible = all
      .filter((a) => a.status === 'active')
      .filter((a) => a.cooldownUntil == null || a.cooldownUntil < now)
      .sort((a, b) => {
        const at = a.lastUsedAt ?? 0;
        const bt = b.lastUsedAt ?? 0;
        // null/0 sort as oldest; among non-null, smaller timestamp first.
        if (at === 0 && bt === 0) return a.id - b.id;
        if (at === 0) return -1;
        if (bt === 0) return 1;
        return at - bt;
      });

    if (eligible.length === 0) {
      throw new Error('no active account available (all on cooldown, invalid, or ineligible)');
    }

    let lastErr: unknown;
    for (const acc of eligible) {
      try {
        const token = await this.refresher.getAccessToken(acc.id);
        // Mark as used so the next pick rotates to a different account.
        // ponytail: caller can also call recordSuccess() for an explicit
        // success marker; we touch here so pick() is self-contained.
        this.store.touchUsed(acc.id);
        return { accountId: acc.id, email: acc.email, token };
      } catch (err) {
        // Token refresh marks the account invalid inside the refresher; try the next.
        lastErr = err;
      }
    }
    throw new Error(
      `no usable account: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  recordSuccess(accountId: number): void {
    this.store.touchUsed(accountId);
  }

  recordCooldown(accountId: number, durationMs?: number): void {
    this.store.setCooldown(accountId, Date.now() + (durationMs ?? this.cooldownMs));
  }

  recordRateLimit(accountId: number, model: string, durationMs?: number): void {
    const until = Date.now() + (durationMs ?? this.cooldownMs);
    this.store.setCooldown(accountId, until);
    this.store.recordQuotaEvent(accountId, model, '429', until);
  }

  recordInvalid(accountId: number, lastError?: string): void {
    this.store.setStatus(accountId, 'invalid', lastError);
  }

  recordIneligible(accountId: number, lastError?: string): void {
    this.store.setStatus(accountId, 'ineligible', lastError);
  }

  countActive(): number {
    const now = Date.now();
    return this.store.listAccounts().filter(
      (a: Account) =>
        a.status === 'active' && (a.cooldownUntil == null || a.cooldownUntil < now),
    ).length;
  }
}
