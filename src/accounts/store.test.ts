import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from './store.js';
import { keyIdFor } from '../api/gemini/keyConfig.js';

const K1 = 'AQ.Ab' + 'a'.repeat(44); // 49 chars — a valid Google Auth key example (40..∞ allowed)
const K2 = 'AQ.Ab' + 'b'.repeat(44);

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
    expect(names).toContain('proxy_client_key');
    store.close();
  });

  // Unix permission bits are no-ops on Windows NTFS, so this guard keeps the
  // suite green on Windows while still asserting on Linux/macOS deploys.
  const itIfUnix = process.platform === 'win32' ? it.skip : it;

  itIfUnix('applies 0o700 to data dir and 0o600 to data.db', () => {
    const store = createStore(tmp, KEY);
    store.addAccount({ email: 'p@e.com', refreshToken: 'rt' });
    store.close();
    const dirMode = statSync(tmp).mode & 0o777;
    const dbMode = statSync(path.join(tmp, 'data.db')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(dbMode).toBe(0o600);
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

  it('hasRefreshToken answers from a column check, never decrypts', async () => {
    // Spy on decrypt to prove hasRefreshToken does not touch the AES layer.
    const enc = await import('./encryption.js');
    const spy = vi.spyOn(enc, 'decrypt');
    const a = store.addAccount({ email: 'h@e.com', refreshToken: 'secret' });
    expect(store.hasRefreshToken(a.id)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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

describe('account enabled', () => {
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

  it('defaults enabled to true on new accounts', () => {
    const acc = store.addAccount({ email: 'a@example.com', refreshToken: 'rt' });
    expect(acc.enabled).toBe(true);
  });

  it('setAccountEnabled updates the row and reflects in getAccount/listAccounts', () => {
    const acc = store.addAccount({ email: 'a@example.com', refreshToken: 'rt' });
    const updated = store.setAccountEnabled(acc.id, false);
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
    expect(store.getAccount(acc.id)!.enabled).toBe(false);
    const list = store.listAccounts();
    expect(list.find((a) => a.id === acc.id)!.enabled).toBe(false);
  });

  it('setAccountEnabled(true) re-enables a previously disabled account', () => {
    const acc = store.addAccount({ email: 'a@example.com', refreshToken: 'rt' });
    store.setAccountEnabled(acc.id, false);
    const re = store.setAccountEnabled(acc.id, true);
    expect(re!.enabled).toBe(true);
    expect(store.getAccount(acc.id)!.enabled).toBe(true);
  });

  it('setAccountEnabled returns null for a missing id (no throw)', () => {
    expect(store.setAccountEnabled(999, false)).toBeNull();
  });
});

describe('api_keys CRUD', () => {
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

  it('addApiKey stores metadata; listApiKeys returns it without a key field', () => {
    const added = store.addApiKey('prod-a', K1);
    expect(added.label).toBe('prod-a');
    expect(added.keyId).toBe(keyIdFor(K1));
    expect(added.enabled).toBe(true);
    expect(added.disabledAt).toBeNull();
    const list = store.listApiKeys();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('key');
    expect(JSON.stringify(list)).not.toContain(K1);
  });

  it('listApiKeysWithSecret returns the decrypted key', () => {
    store.addApiKey('a', K1);
    const list = store.listApiKeysWithSecret();
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe(K1);
  });

  it('getApiKeyWithSecret returns the row with key; null for unknown id', () => {
    const added = store.addApiKey('a', K1);
    const row = store.getApiKeyWithSecret(added.id);
    expect(row?.key).toBe(K1);
    expect(store.getApiKeyWithSecret(999)).toBeNull();
  });

  it('duplicate label throws ApiKeyConflictError(label_taken)', () => {
    store.addApiKey('dup', K1);
    expect(() => store.addApiKey('dup', K2)).toThrowError(/label_taken/);
  });

  it('duplicate key throws ApiKeyConflictError(key_already_registered)', () => {
    store.addApiKey('a', K1);
    expect(() => store.addApiKey('b', K1)).toThrowError(/key_already_registered/);
  });

  it('removeApiKey deletes the row; second call returns false', () => {
    const added = store.addApiKey('a', K1);
    expect(store.removeApiKey(added.id)).toBe(true);
    expect(store.listApiKeys()).toHaveLength(0);
    expect(store.removeApiKey(added.id)).toBe(false);
  });

  it('setApiKeyEnabled(false) sets disabledAt; true clears it', () => {
    const added = store.addApiKey('a', K1);
    const off = store.setApiKeyEnabled(added.id, false);
    expect(off?.enabled).toBe(false);
    expect(off?.disabledAt).not.toBeNull();
    const on = store.setApiKeyEnabled(added.id, true);
    expect(on?.enabled).toBe(true);
    expect(on?.disabledAt).toBeNull();
  });

  it('setApiKeyEnabled returns null for unknown id', () => {
    expect(store.setApiKeyEnabled(999, false)).toBeNull();
  });

  it('seedApiKeysFromEnv inserts boot: rows and returns the count', () => {
    expect(store.seedApiKeysFromEnv([K1, K2])).toBe(2);
    expect(store.listApiKeys().map((k) => k.label)).toEqual(['boot:0', 'boot:1']);
  });

  it('seedApiKeysFromEnv is a no-op when the table is non-empty', () => {
    store.addApiKey('manual', K1);
    expect(store.seedApiKeysFromEnv([K2])).toBe(0);
    expect(store.listApiKeys()).toHaveLength(1);
  });

  it('seedApiKeysFromEnv([]) is a no-op', () => {
    expect(store.seedApiKeysFromEnv([])).toBe(0);
    expect(store.listApiKeys()).toHaveLength(0);
  });

  it('api_keys survives a close/reopen cycle (persisted)', () => {
    store.addApiKey('persisted', K1);
    store.close();
    store = createStore(tmp, KEY);
    const list = store.listApiKeys();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('persisted');
  });
});

describe('proxy_client_key singleton', () => {
  let tmp: string;
  let store: ReturnType<typeof createStore>;
  const SECRET = 'a'.repeat(64);
  const ROTATED = 'b'.repeat(64);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('getClientKey returns null when no row exists', () => {
    expect(store.getClientKey()).toBeNull();
    expect(store.getClientKeyWithSecret()).toBeNull();
  });

  it('setClientKey inserts; getClientKey returns metadata without the secret', () => {
    const meta = store.setClientKey(SECRET);
    expect(meta.keyId).toBe(keyIdFor(SECRET));
    expect(meta.createdAt).toBeGreaterThan(0);
    expect(meta.updatedAt).toBe(meta.createdAt);
    const fetched = store.getClientKey();
    expect(fetched).not.toBeNull();
    expect(fetched).not.toHaveProperty('key');
    expect(JSON.stringify(fetched)).not.toContain(SECRET);
  });

  it('getClientKeyWithSecret decrypts the stored key', () => {
    store.setClientKey(SECRET);
    const withSecret = store.getClientKeyWithSecret();
    expect(withSecret?.key).toBe(SECRET);
    expect(withSecret?.keyId).toBe(keyIdFor(SECRET));
  });

  it('setClientKey twice rotates in place: createdAt preserved, updatedAt moves forward', async () => {
    const first = store.setClientKey(SECRET);
    // Sleep 2ms so updatedAt is strictly greater than createdAt.
    await new Promise((r) => setTimeout(r, 5));
    const second = store.setClientKey(ROTATED);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.keyId).toBe(keyIdFor(ROTATED));
    const list = store.db
      .prepare('SELECT COUNT(*) AS n FROM proxy_client_key')
      .get() as { n: number };
    expect(list.n).toBe(1);
    expect(store.getClientKeyWithSecret()?.key).toBe(ROTATED);
  });

  it('clearClientKey removes the row; second call returns false', () => {
    store.setClientKey(SECRET);
    expect(store.clearClientKey()).toBe(true);
    expect(store.getClientKey()).toBeNull();
    expect(store.clearClientKey()).toBe(false);
  });

  it('CHECK(id=1) rejects a hand-inserted second row', () => {
    store.setClientKey(SECRET);
    expect(() =>
      store.db
        .prepare(
          'INSERT INTO proxy_client_key (id, key_id, key_ciphertext, created_at, updated_at) VALUES (2, ?, ?, ?, ?)',
        )
        .run('x', Buffer.from('x'), Date.now(), Date.now()),
    ).toThrowError(/CHECK/);
  });

  it('seedClientKeyFromEnv inserts the env value when the table is empty', () => {
    expect(store.seedClientKeyFromEnv(SECRET)).toBe(true);
    expect(store.getClientKeyWithSecret()?.key).toBe(SECRET);
  });

  it('seedClientKeyFromEnv is a no-op when the row already exists', () => {
    store.setClientKey(SECRET);
    expect(store.seedClientKeyFromEnv(ROTATED)).toBe(false);
    expect(store.getClientKeyWithSecret()?.key).toBe(SECRET);
  });

  it('seedClientKeyFromEnv(undefined) is a no-op', () => {
    expect(store.seedClientKeyFromEnv(undefined)).toBe(false);
    expect(store.getClientKey()).toBeNull();
  });

  it('proxy_client_key survives a close/reopen cycle (persisted)', () => {
    store.setClientKey(SECRET);
    store.close();
    store = createStore(tmp, KEY);
    expect(store.getClientKeyWithSecret()?.key).toBe(SECRET);
  });
});
