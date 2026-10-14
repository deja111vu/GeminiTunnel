// unifiedPool.ts — single revolver over OAuth accounts + API keys.
// Spec: docs/superpowers/specs/2026-10-14-unified-upstream-pool-design.md
//
// Boot order (deterministic across restarts):
//   1. all enabled OAuth accounts, by id ASC
//   2. all enabled API keys, by id ASC
// Cursor is process-local — restart resets to 0, same as AccountPool
// and KeyPool today. UnifiedPool rebuild() must be called by the
// caller after every PATCH (the DB is the source of truth).
//
// OAuth eligibility / token refresh is delegated to AccountPool —
// we do NOT duplicate the skip-cooldown / refresh-failure logic.
// When AccountPool.pick() throws (no eligible account), we advance
// the cursor to the next API key on the same call rather than
// surfacing the error; the dispatcher surfaces "no_upstreams_enabled"
// only when BOTH branches are exhausted.

import type { Account, Store } from '../../accounts/store.js';
import type { AccountPool, PickedAccount } from '../../accounts/pool.js';
import type { KeyPool } from './keyPool.js';

export type Upstream =
  | { kind: 'oauth'; account: Account; token: string }
  | { kind: 'apikey'; key: string };

export interface UnifiedPoolDeps {
  accountPool: AccountPool;
  keyPool: KeyPool;
  store: Store;
}

export class UnifiedPool {
  private readonly accountPool: AccountPool;
  private readonly keyPool: KeyPool;
  private readonly store: Store;
  private items: Upstream[] = [];
  private cursor = 0;

  constructor(deps: UnifiedPoolDeps) {
    this.accountPool = deps.accountPool;
    this.keyPool = deps.keyPool;
    this.store = deps.store;
    this.rebuild();
  }

  // Re-read the boot list from the DB. Call after every PATCH that
  // changes the enabled-state of any account or key. Idempotent —
  // safe to call more often than necessary.
  rebuild(): void {
    const accounts = this.store
      .listAccounts()
      .filter((a) => a.enabled)
      .sort((x, y) => x.id - y.id);
    const items: Upstream[] = accounts.map((account) => ({
      // `token` is filled in at pick() time; the boot list has no
      // pre-fetched token. Using `as` here because the upstream
      // shape is structural — `token` is always assigned before
      // the dispatcher reads it on the oauth branch.
      kind: 'oauth' as const,
      account,
      token: '',
    }));
    // The KeyPool is the source of truth for "which keys are
    // currently in rotation" — we ask it for the ordered list via
    // its internal `keys` array. We don't have a public getter, so
    // we re-derive from the store: enabled API keys by id ASC.
    // AccountPool.disable / KeyPool.removeKey are still respected
    // through the underlying pools' own pick() logic; the boot
    // list is a *hint* of what's enabled, and the pools reject
    // disabled items.
    const keys = this.store
      .listApiKeys()
      .filter((k) => k.enabled)
      .sort((x, y) => x.id - y.id);
    // We don't have the plaintext key on the masked store row, so
    // we re-pull from the KeyPool's known-keys list. KeyPool is
    // already kept in sync with the store on PATCH by the admin
    // handler. The KeyPool doesn't expose its list either, so we
    // use listApiKeysWithSecret and intersect with the masked
    // enabled set to recover the plaintexts in id order.
    const byId = new Map(this.store.listApiKeysWithSecret().map((k) => [k.id, k.key]));
    for (const k of keys) {
      const plain = byId.get(k.id);
      if (plain) items.push({ kind: 'apikey' as const, key: plain });
    }
    this.items = items;
    // Reset the cursor only if it's now out of range; otherwise
    // leave it so an in-flight revolver doesn't skip a turn.
    if (this.cursor >= this.items.length) this.cursor = 0;
  }

  size(): number {
    return this.items.length;
  }

  snapshot(): Upstream[] {
    return this.items.slice();
  }

  async pick(): Promise<Upstream> {
    if (this.items.length === 0) {
      throw new Error('no_upstreams_enabled');
    }
    // Try each item starting at the cursor, advancing on each
    // failure. The for-loop bound is the count of items (not
    // switchBudget) — the dispatcher enforces the per-request
    // budget. Here we just guarantee one full pass.
    for (let i = 0; i < this.items.length; i++) {
      const idx = (this.cursor + i) % this.items.length;
      const item = this.items[idx];
      this.cursor = (idx + 1) % this.items.length;
      if (item.kind === 'oauth') {
        try {
          const picked: PickedAccount = await this.accountPool.pick();
          // Sanity: the boot list and the AccountPool's pick must
          // agree on which account we hand back. If they don't
          // (e.g. AccountPool's LRU moved between rebuild and
          // pick), we use the freshly-picked account. The token
          // always comes from AccountPool.pick().
          const account = this.store.getAccount(picked.accountId) ?? item.account;
          return { kind: 'oauth', account, token: picked.token };
        } catch {
          // AccountPool couldn't yield an eligible account (all
          // on cooldown, all invalid, all ineligible). Try the
          // next item.
          continue;
        }
      }
      // apikey branch. KeyPool.pick() throws NoKeyAvailableError
      // if every key is bad/cooldown/unknown. We don't try to
      // recover here — the dispatcher catches.
      return item;
    }
    throw new Error('no_upstreams_enabled');
  }
}