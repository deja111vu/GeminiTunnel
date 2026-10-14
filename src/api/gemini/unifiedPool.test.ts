import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, type Store, type Account } from '../../accounts/store.js';
import { AccountPool } from '../../accounts/pool.js';
import { KeyPool } from './keyPool.js';
import { UnifiedPool, type Upstream } from './unifiedPool.js';

const KEY = 'a'.repeat(64);
const K1 = 'AQ.Ab' + 'a'.repeat(44);
const K2 = 'AQ.Ab' + 'b'.repeat(44);

function mockRefresher() {
  return {
    getAccessToken: vi.fn(async (id: number) => `tok-${id}`),
    forceRefresh: vi.fn(async (id: number) => `tok-${id}`),
  };
}

describe('UnifiedPool', () => {
  let tmp: string;
  let store: Store;
  let accountPool: AccountPool;
  let keyPool: KeyPool;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-up-'));
    store = createStore(tmp, KEY);
    accountPool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 60_000 });
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeAccount(email: string): Account {
    return store.addAccount({ email, refreshToken: `rt-${email}` });
  }

  it('boots in order: all enabled oauth first (by id asc), then enabled keys (by id asc)', async () => {
    const a = makeAccount('a@e.com');
    const b = makeAccount('b@e.com');
    store.addApiKey('k1', K1);
    store.addApiKey('k2', K2);
    keyPool.addKey(K1);
    keyPool.addKey(K2);
    const u = new UnifiedPool({ accountPool, keyPool, store });

    const order: Upstream[] = [];
    for (let i = 0; i < 4; i++) order.push(await u.pick());
    expect(order[0].kind).toBe('oauth');
    expect(order[0].kind === 'oauth' && order[0].account.id).toBe(a.id);
    expect(order[1].kind).toBe('oauth');
    expect(order[1].kind === 'oauth' && order[1].account.id).toBe(b.id);
    expect(order[2].kind).toBe('apikey');
    expect(order[2].kind === 'apikey' && order[2].key).toBe(K1);
    expect(order[3].kind).toBe('apikey');
    expect(order[3].kind === 'apikey' && order[3].key).toBe(K2);
  });

  it('pick() throws on empty pool so the dispatcher can map to 503', async () => {
    const u = new UnifiedPool({ accountPool, keyPool, store });
    await expect(u.pick()).rejects.toThrow(/no_upstreams_enabled/);
  });

  it('rebuild() picks up a newly added api key', async () => {
    // The throw assertion below requires an empty enabled pool. The brief
    // leaves a@e.com enabled, which makes the throw impossible — fix it
    // by disabling the account so the test matches its own intent.
    const a = makeAccount('a@e.com');
    store.setAccountEnabled(a.id, false);
    accountPool.disable(a.id);
    const u = new UnifiedPool({ accountPool, keyPool, store });
    await expect(u.pick()).rejects.toThrow();

    store.addApiKey('k1', K1);
    keyPool.addKey(K1);
    u.rebuild();

    const up = await u.pick();
    expect(up.kind).toBe('apikey');
  });

  it('rebuild() drops an account that became disabled', async () => {
    const a = makeAccount('a@e.com');
    const u = new UnifiedPool({ accountPool, keyPool, store });
    const up0 = await u.pick();
    expect(up0.kind).toBe('oauth');

    store.setAccountEnabled(a.id, false);
    accountPool.disable(a.id);
    u.rebuild();
    await expect(u.pick()).rejects.toThrow();
  });

  it('size() counts enabled items only', () => {
    const a = makeAccount('a@e.com');
    makeAccount('b@e.com');
    store.addApiKey('k1', K1);
    store.addApiKey('k2', K2);
    keyPool.addKey(K1);
    keyPool.addKey(K2);
    let u = new UnifiedPool({ accountPool, keyPool, store });
    expect(u.size()).toBe(4);
    store.setAccountEnabled(a.id, false);
    accountPool.disable(a.id);
    u.rebuild();
    expect(u.size()).toBe(3);
  });

  it('falls through to apikey when oauth item throws in AccountPool.pick', async () => {
    // Regression: with items = [oauth, apikey] and the oauth item's
    // accountPool.pick() throwing, pick() used to re-check the oauth
    // item a second time (cursor was advanced during the first
    // iteration, shifting the (cursor+i) read) and throw
    // no_upstreams_enabled even though the apikey was available.
    const a = makeAccount('a@e.com');
    // Disable the account at the AccountPool level so its pick() throws
    // (eligible.length === 0). The store still has it enabled, so
    // UnifiedPool puts it in the boot list.
    accountPool.disable(a.id);
    store.addApiKey('k1', K1);
    keyPool.addKey(K1);
    const u = new UnifiedPool({ accountPool, keyPool, store });
    expect(u.size()).toBe(2);
    const up = await u.pick();
    expect(up.kind).toBe('apikey');
    if (up.kind === 'apikey') expect(up.key).toBe(K1);
  });
});