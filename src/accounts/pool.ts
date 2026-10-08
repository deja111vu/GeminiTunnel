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
  // Monotonic counter used as a tie-breaker when last_used_at values are
  // equal (Date.now() resolution is too coarse to distinguish back-to-back
  // touches on a fast machine; without this, stable sort hands account id=1
  // to every pick). Start at 1 so 0 stays a sentinel for "never picked in
  // this pool instance" and untouched accounts sort BEFORE the just-touched
  // one (a picked id has seq>=1, an untouched id has seq=0).
  private nextPickSeq = 1;
  private readonly pickSeqById = new Map<number, number>();

  constructor({ store, refresher, cooldownMs }: AccountPoolOptions) {
    this.store = store;
    this.refresher = refresher;
    this.cooldownMs = cooldownMs;
  }

  // Pick the most-eligible active account.
  // Eligibility: status=active AND (cooldownUntil is null OR cooldownUntil < now).
  // Tie-breaker: oldest lastUsedAt first (LRU); among equal timestamps,
  // the account with the smallest in-memory pick seq (i.e. picked least
  // recently by this pool instance).
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
        if (at !== bt) return at - bt;
        return (this.pickSeqById.get(a.id) ?? 0) - (this.pickSeqById.get(b.id) ?? 0);
      });

    if (eligible.length === 0) {
      throw new Error('no active account available (all on cooldown, invalid, or ineligible)');
    }

    const errors: string[] = [];
    for (const acc of eligible) {
      try {
        const token = await this.refresher.getAccessToken(acc.id);
        const seq = this.nextPickSeq++;
        this.pickSeqById.set(acc.id, seq);
        this.store.touchUsed(acc.id);
        return { accountId: acc.id, email: acc.email, token };
      } catch (err) {
        // Token refresh marks the account invalid inside the refresher; try the next.
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(`no usable account: ${errors.join(' | ')}`);
  }

  recordSuccess(accountId: number): void {
    this.store.touchUsed(accountId);
  }

  recordCooldown(accountId: number, durationMs?: number): void {
    this.store.setCooldown(accountId, Date.now() + (durationMs ?? this.cooldownMs));
  }

  recordRateLimit(accountId: number, model: string, durationMs?: number): void {
    const until = Date.now() + (durationMs ?? this.cooldownMs);
    // Atomic: cooldown + event must commit together so the Phase 8 quota UI
    // and the cooldown protection can't disagree on what happened.
    const txn = this.store.db.transaction(() => {
      this.store.setCooldown(accountId, until);
      this.store.recordQuotaEvent(accountId, model, '429', until);
    });
    txn();
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
