import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from './store.js';

const KEY = 'a'.repeat(64);

describe('store schema', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('opens DB and creates required tables', () => {
    const store = createStore(tmp, KEY);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('accounts');
    expect(names).toContain('account_quota_events');
    expect(names).toContain('account_quota_snapshots');
    store.close();
  });
});

describe('store CRUD', () => {
  let tmp: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('addAccount encrypts refresh_token and stores tier', () => {
    const acc = store.addAccount({
      email: 'a@example.com',
      refreshToken: 'refresh-raw',
      tierId: 'PAID',
      tierName: 'pro',
    });
    expect(acc.id).toBeGreaterThan(0);
    expect(acc.email).toBe('a@example.com');
    expect(acc.tierId).toBe('PAID');
    expect(acc.tierName).toBe('pro');
    const row = store.db
      .prepare('SELECT refresh_token_encrypted FROM accounts WHERE id=?')
      .get(acc.id) as { refresh_token_encrypted: Buffer };
    // stored as Buffer (BLOB), not plaintext
    expect(Buffer.isBuffer(row.refresh_token_encrypted)).toBe(true);
    expect(row.refresh_token_encrypted.toString('binary')).not.toContain('refresh-raw');
  });

  it('roundtrips refresh_token via readActiveRefreshToken', () => {
    const acc = store.addAccount({ email: 'rt@e.com', refreshToken: 'secret-token' });
    expect(store.readActiveRefreshToken(acc.id)).toBe('secret-token');
  });

  it('listAccounts returns all added', () => {
    store.addAccount({ email: 'x@e.com', refreshToken: 'r1' });
    store.addAccount({ email: 'y@e.com', refreshToken: 'r2' });
    expect(store.listAccounts()).toHaveLength(2);
  });

  it('removeAccount removes by id', () => {
    const acc = store.addAccount({ email: 'z@e.com', refreshToken: 'r' });
    store.removeAccount(acc.id);
    expect(store.listAccounts()).toHaveLength(0);
  });

  it('getAccountByEmail returns the right account', () => {
    const a = store.addAccount({ email: 'find@e.com', refreshToken: 'r' });
    expect(store.getAccountByEmail('find@e.com')?.id).toBe(a.id);
    expect(store.getAccountByEmail('missing@e.com')).toBeNull();
  });

  it('setStatus and setCooldown work', () => {
    const acc = store.addAccount({ email: 's@e.com', refreshToken: 'r' });
    store.setStatus(acc.id, 'invalid', 'invalid_grant');
    store.setCooldown(acc.id, Date.now() + 60_000);
    const fetched = store.getAccount(acc.id)!;
    expect(fetched.status).toBe('invalid');
    expect(fetched.lastError).toBe('invalid_grant');
    expect(fetched.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('setActiveToken encrypts and readActiveAccessToken decrypts', () => {
    const acc = store.addAccount({ email: 't@e.com', refreshToken: 'r' });
    const exp = Date.now() + 600_000;
    store.setActiveToken(acc.id, 'access-raw', exp);
    const at = store.readActiveAccessToken(acc.id);
    expect(at?.token).toBe('access-raw');
    expect(at?.expiresAt).toBe(exp);
  });

  it('touchUsed updates last_used_at', () => {
    const acc = store.addAccount({ email: 'u@e.com', refreshToken: 'r' });
    expect(store.getAccount(acc.id)!.lastUsedAt).toBeNull();
    store.touchUsed(acc.id);
    expect(store.getAccount(acc.id)!.lastUsedAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('recordQuotaEvent + listRecentQuotaEvents', () => {
    const acc = store.addAccount({ email: 'q@e.com', refreshToken: 'r' });
    store.recordQuotaEvent(acc.id, 'gemini-2.5-pro', '429', Date.now() + 60_000);
    const since = Date.now() - 1000;
    const events = store.listRecentQuotaEvents(acc.id, since);
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe('gemini-2.5-pro');
    expect(events[0].source).toBe('429');
  });

  it('recordQuotaSnapshot + listLatestQuotaSnapshots returns latest per model', () => {
    const acc = store.addAccount({ email: 'q2@e.com', refreshToken: 'r' });
    store.recordQuotaSnapshot(acc.id, 'gemini-2.5-pro', 80, 100, Date.now() + 60_000, 1000);
    store.recordQuotaSnapshot(acc.id, 'gemini-2.5-pro', 50, 100, Date.now() + 60_000, 2000);
    store.recordQuotaSnapshot(acc.id, 'gemini-2.5-flash', 950, 1000, undefined, 2000);
    const snaps = store.listLatestQuotaSnapshots(acc.id);
    expect(snaps).toHaveLength(2);
    const pro = snaps.find((s) => s.model === 'gemini-2.5-pro');
    const flash = snaps.find((s) => s.model === 'gemini-2.5-flash');
    expect(pro?.remaining).toBe(50);
    expect(flash?.remaining).toBe(950);
  });
});
