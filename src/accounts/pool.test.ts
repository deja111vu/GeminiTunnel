import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, type Store, type Account } from './store.js';
import { AccountPool } from './pool.js';

const KEY = 'a'.repeat(64);

describe('AccountPool', () => {
  let tmp: string;
  let store: Store;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeAccount(email: string, age = 0): Account {
    const a = store.addAccount({ email, refreshToken: `rt-${email}` });
    // Backdate lastUsedAt so the LRU test has stable ordering.
    store.db
      .prepare('UPDATE accounts SET last_used_at=? WHERE id=?')
      .run(Date.now() - age, a.id);
    return store.getAccount(a.id)!;
  }

  function mockRefresher(stub: (id: number) => Promise<string> = async (id) => `tok-${id}`) {
    // forceRefresh isn't exercised by these tests but RefresherLike requires it.
    return {
      getAccessToken: vi.fn(stub),
      forceRefresh: vi.fn(stub),
    };
  }

  it('picks the active account with the oldest lastUsedAt (LRU)', async () => {
    const a = makeAccount('a@e.com', 10_000); // oldest
    makeAccount('b@e.com', 0);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const pick = await pool.pick();
    expect(pick.accountId).toBe(a.id);
    expect(pick.email).toBe('a@e.com');
  });

  it('treats never-used accounts as oldest', async () => {
    const never = makeAccount('never@e.com', 0);
    store.db.prepare('UPDATE accounts SET last_used_at=NULL WHERE id=?').run(never.id);
    makeAccount('recent@e.com', 0);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const pick = await pool.pick();
    expect(pick.email).toBe('never@e.com');
  });

  it('skips accounts on cooldown and returns one that is free', async () => {
    const onCooldown = makeAccount('cd@e.com', 10_000);
    const free = makeAccount('free@e.com', 0);
    store.setCooldown(onCooldown.id, Date.now() + 60_000);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const pick = await pool.pick();
    expect(pick.accountId).toBe(free.id);
  });

  it('skips accounts whose cooldown has expired', async () => {
    const past = makeAccount('past@e.com', 10_000);
    store.setCooldown(past.id, Date.now() - 1);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const pick = await pool.pick();
    expect(pick.accountId).toBe(past.id);
  });

  it('skips invalid and ineligible accounts', async () => {
    const invalid = makeAccount('inv@e.com', 10_000);
    const ineligible = makeAccount('in@e.com', 20_000);
    const active = makeAccount('ok@e.com', 5_000);
    store.setStatus(invalid.id, 'invalid', 'bad token');
    store.setStatus(ineligible.id, 'ineligible', 'no tier');
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const pick = await pool.pick();
    expect(pick.accountId).toBe(active.id);
  });

  it('rotates accounts even when lastUsedAt is identical (LRU tie-break)', async () => {
    // Verifies the in-memory seq tie-break: with Date.now() too coarse to
    // distinguish back-to-back touches, the pool must still hand out a
    // different account on each pick.
    const a = makeAccount('a@e.com', 0);
    const b = makeAccount('b@e.com', 0);
    const c = makeAccount('c@e.com', 0);
    const same = Date.now();
    store.db
      .prepare('UPDATE accounts SET last_used_at=? WHERE id IN (?,?,?)')
      .run(same, a.id, b.id, c.id);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const ids = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const { accountId } = await pool.pick();
      ids.add(accountId);
    }
    expect(ids).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('aggregates refresh errors when all eligible accounts fail', async () => {
    makeAccount('a@e.com', 30_000);
    makeAccount('b@e.com', 20_000);
    const ref = mockRefresher(async () => {
      throw new Error('invalid_grant: revoked');
    });
    const pool = new AccountPool({ store, refresher: ref, cooldownMs: 60_000 });
    await expect(pool.pick()).rejects.toThrow(/no usable account.*invalid_grant/s);
  });

  it('round-robins: each pick rotates to a different account', async () => {
    const a = makeAccount('a@e.com', 30_000);
    const b = makeAccount('b@e.com', 20_000);
    const c = makeAccount('c@e.com', 10_000);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    const ids = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const { accountId } = await pool.pick();
      ids.add(accountId);
    }
    expect(ids).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('throws when no account is pickable', async () => {
    const only = makeAccount('only@e.com', 0);
    store.setStatus(only.id, 'invalid', 'revoked');
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    await expect(pool.pick()).rejects.toThrow(/no.*account/i);
  });

  it('records success by touching last_used_at', async () => {
    const a = makeAccount('a@e.com', 0);
    const before = store.getAccount(a.id)!.lastUsedAt;
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    pool.recordSuccess(a.id);
    const after = store.getAccount(a.id)!.lastUsedAt!;
    expect(after).toBeGreaterThanOrEqual(before ?? 0);
  });

  it('records rate-limit with default cooldownMs and emits a quota event', async () => {
    const a = makeAccount('a@e.com', 0);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    pool.recordRateLimit(a.id, 'gemini-2.5-pro');
    const acc = store.getAccount(a.id)!;
    expect(acc.cooldownUntil).not.toBeNull();
    expect(acc.cooldownUntil!).toBeGreaterThan(Date.now() + 30_000);
    const events = store.listRecentQuotaEvents(a.id, Date.now() - 10_000);
    expect(events.length).toBe(1);
    expect(events[0]!.source).toBe('429');
  });

  it('records explicit cooldown with a custom duration', async () => {
    const a = makeAccount('a@e.com', 0);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    pool.recordCooldown(a.id, 5_000);
    const acc = store.getAccount(a.id)!;
    expect(acc.cooldownUntil).toBeGreaterThan(Date.now());
    expect(acc.cooldownUntil!).toBeLessThan(Date.now() + 10_000);
  });

  it('records invalid status with last error', async () => {
    const a = makeAccount('a@e.com', 0);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    pool.recordInvalid(a.id, 'token revoked');
    const acc = store.getAccount(a.id)!;
    expect(acc.status).toBe('invalid');
    expect(acc.lastError).toBe('token revoked');
  });

  it('records ineligible status with last error', async () => {
    const a = makeAccount('a@e.com', 0);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    pool.recordIneligible(a.id, 'no tier');
    const acc = store.getAccount(a.id)!;
    expect(acc.status).toBe('ineligible');
    expect(acc.lastError).toBe('no tier');
  });

  it('countActive returns only non-cooldown active accounts', async () => {
    const a = makeAccount('a@e.com', 0);
    const b = makeAccount('b@e.com', 0);
    const c = makeAccount('c@e.com', 0);
    store.setStatus(b.id, 'invalid', 'x');
    store.setCooldown(c.id, Date.now() + 60_000);
    const pool = new AccountPool({ store, refresher: mockRefresher(), cooldownMs: 60_000 });
    expect(pool.countActive()).toBe(1);
    // sanity: a is the one
    expect(store.getAccount(a.id)!.status).toBe('active');
  });
});
