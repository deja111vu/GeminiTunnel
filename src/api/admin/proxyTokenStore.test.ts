import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  getProxyTokenStore,
  resetProxyTokenStoreForTests,
  seedProxyTokenStore,
  type ProxyTokenStore,
} from './proxyTokenStore.js';
import { createStore, type Store } from '../../accounts/store.js';

const KEY = 'a'.repeat(64);
const ENV_TOKEN = 'b'.repeat(64);

describe('proxyTokenStore', () => {
  beforeEach(() => {
    resetProxyTokenStoreForTests();
  });

  it('get() returns undefined on a fresh singleton', () => {
    expect(getProxyTokenStore().get()).toBeUndefined();
  });

  it('set() then get() roundtrips the value', () => {
    const s = getProxyTokenStore();
    s.set('a'.repeat(64));
    expect(s.get()).toBe('a'.repeat(64));
  });

  it('set(undefined) clears the value', () => {
    const s = getProxyTokenStore();
    s.set('a'.repeat(64));
    s.set(undefined);
    expect(s.get()).toBeUndefined();
  });

  it('getProxyTokenStore returns the same instance across calls', () => {
    expect(getProxyTokenStore()).toBe(getProxyTokenStore());
  });

  it('resetProxyTokenStoreForTests() forces a new instance', () => {
    const first = getProxyTokenStore();
    first.set('a'.repeat(64));
    resetProxyTokenStoreForTests();
    const second = getProxyTokenStore();
    expect(second).not.toBe(first);
    expect(second.get()).toBeUndefined();
  });
});

describe('seedProxyTokenStore', () => {
  let tmp: string;
  let store: Store;
  let mirror: ProxyTokenStore;

  beforeEach(() => {
    resetProxyTokenStoreForTests();
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-seed-'));
    store = createStore(tmp, KEY);
    mirror = getProxyTokenStore();
  });

  afterEach(() => {
    // Close the SQLite handle before rmSync — on Windows the file
    // lock would otherwise block the recursive remove and leak
    // /tmp entries across runs.
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns source=db and loads the mirror when the DB already has a row', () => {
    const expected = 'c'.repeat(64);
    store.setClientKey(expected);
    const result = seedProxyTokenStore(store, ENV_TOKEN, mirror);
    expect(result).toEqual({ source: 'db', keyId: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(mirror.get()).toBe(expected);
    // Env is shadowed by the DB value — the mirror must NOT see the
    // env value when the DB has its own.
    expect(mirror.get()).not.toBe(ENV_TOKEN);
  });

  it('returns source=env and loads the mirror when the DB is empty and the env var is set', () => {
    const result = seedProxyTokenStore(store, ENV_TOKEN, mirror);
    expect(result).toEqual({ source: 'env' });
    expect(mirror.get()).toBe(ENV_TOKEN);
    // The env value is in memory only — the DB is still empty, so the
    // next call to seedProxyTokenStore with a different env will pick
    // up the new env (the DB is the only "sticky" source).
    expect(store.getClientKey()).toBeNull();
  });

  it('returns source=unset and leaves the mirror empty when neither DB nor env has a value', () => {
    const result = seedProxyTokenStore(store, undefined, mirror);
    expect(result).toEqual({ source: 'unset' });
    expect(mirror.get()).toBeUndefined();
  });

  it('returns source=unset and leaves the mirror empty when env is the empty string', () => {
    // The env validator rejects empty strings, but a defensive check
    // here documents that "no value" means "no value" — we do NOT
    // treat "" as a usable token.
    const result = seedProxyTokenStore(store, '', mirror);
    expect(result.source).toBe('unset');
    expect(mirror.get()).toBeUndefined();
  });

  it('overwrites a previously-set mirror value (idempotent at boot, but writes the resolved value)', () => {
    // If a previous boot set the mirror, the next seed must still
    // resolve to the DB/env source. This pins the boot ordering:
    // the mirror is the OUTPUT of seeding, not a precondition.
    mirror.set('z'.repeat(64));
    store.setClientKey('c'.repeat(64));
    const result = seedProxyTokenStore(store, ENV_TOKEN, mirror);
    expect(result.source).toBe('db');
    expect(mirror.get()).toBe('c'.repeat(64));
  });

  it('treats an empty DB key as "no row" and falls through to the env value', () => {
    // The public setClientKey() rejects empty keys, so a real DB
    // row with an empty key can only appear via direct SQL or a
    // future code path that bypasses the validator. The mirror
    // MUST NOT take the empty value: requireClientKey's
    // `if (!expected)` matches '' and would silently close the
    // proxy while the seed reports source='db' — a misleading boot
    // log. Simulate the corruption with a mock store.
    const mockStore = {
      getClientKeyWithSecret: () => ({ key: '', keyId: 'deadbeef' }),
    };
    const result = seedProxyTokenStore(mockStore, ENV_TOKEN, mirror);
    expect(result.source).toBe('env');
    expect(mirror.get()).toBe(ENV_TOKEN);
  });

  it('reports source=unset and leaves the mirror empty when DB key is empty AND env is unset', () => {
    const mockStore = {
      getClientKeyWithSecret: () => ({ key: '', keyId: 'deadbeef' }),
    };
    const result = seedProxyTokenStore(mockStore, undefined, mirror);
    expect(result).toEqual({ source: 'unset' });
    expect(mirror.get()).toBeUndefined();
  });
});
