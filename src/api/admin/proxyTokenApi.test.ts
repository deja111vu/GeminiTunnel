import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createStore, type Store } from '../../accounts/store.js';
import { KeyPool } from '../gemini/keyPool.js';
import { handleAdminApi } from './api.js';
import {
  getProxyTokenStore,
  resetProxyTokenStoreForTests,
  type ProxyTokenStore,
} from './proxyTokenStore.js';

const KEY = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const GENERATED_LEN = 64; // randomBytes(32).toString('hex')

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
}

function makeApp(store: Store, proxyTokenStore: ProxyTokenStore) {
  const app = new Hono();
  const refresher = {
    getAccessToken: async (id: number) => `tok-${id}`,
    forceRefresh: async (id: number) => `tok-${id}`,
  };
  handleAdminApi({
    app,
    store,
    refresher: refresher as never,
    encryptionKey: KEY,
    adminToken: ADMIN,
    keyPool: new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 }),
    proxyTokenStore,
  });
  return app;
}

describe('admin /admin/api/proxy-token', () => {
  let tmp: string;
  let store: Store;
  let mirror: ProxyTokenStore;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
    // Use a fresh mirror per test (not the singleton) so tests don't
    // bleed into each other or into the real runtime singleton.
    mirror = getProxyTokenStore();
    resetProxyTokenStoreForTests();
    mirror = getProxyTokenStore();
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET returns hasSecret=false when no key is set', async () => {
    const res = await makeApp(store, mirror).request('/admin/api/proxy-token', {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasSecret: false });
  });

  it('PUT with valid key persists to DB and updates mirror', async () => {
    const pasted = 'x'.repeat(64);
    const res = await makeApp(store, mirror).request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ key: pasted }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasSecret: boolean; keyId: string; createdAt: number; updatedAt: number };
    expect(body.hasSecret).toBe(true);
    expect(body.keyId).toMatch(/^[0-9a-f]{8}$/);
    // DB is the source of truth; mirror follows.
    expect(store.getClientKeyWithSecret()?.key).toBe(pasted);
    expect(mirror.get()).toBe(pasted);
  });

  it('PUT rejects keys shorter than 16 chars (F1 contract)', async () => {
    const res = await makeApp(store, mirror).request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ key: 'too-short' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json())).toEqual({ error: 'invalid_key_format' });
    expect(store.getClientKey()).toBeNull();
    expect(mirror.get()).toBeUndefined();
  });

  it('PUT rejects keys with non-URL-safe characters', async () => {
    const res = await makeApp(store, mirror).request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ key: 'has spaces and 漢字 ' + 'a'.repeat(40) }),
    });
    expect(res.status).toBe(400);
    expect(store.getClientKey()).toBeNull();
  });

  it('PUT preserves createdAt on rotation; only updatedAt moves', async () => {
    const app = makeApp(store, mirror);
    const first = await app.request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ key: 'a'.repeat(64) }),
    });
    const firstBody = (await first.json()) as { createdAt: number; updatedAt: number };
    await new Promise((r) => setTimeout(r, 5));
    const second = await app.request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ key: 'b'.repeat(64) }),
    });
    const secondBody = (await second.json()) as { createdAt: number; updatedAt: number };
    expect(secondBody.createdAt).toBe(firstBody.createdAt);
    expect(secondBody.updatedAt).toBeGreaterThan(firstBody.updatedAt);
    expect(store.getClientKeyWithSecret()?.key).toBe('b'.repeat(64));
    expect(mirror.get()).toBe('b'.repeat(64));
  });

  it('POST /generate returns a 64-hex key, persists to DB and mirror', async () => {
    const res = await makeApp(store, mirror).request('/admin/api/proxy-token/generate', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; hasSecret: boolean };
    expect(body.key).toMatch(/^[0-9a-f]{64}$/);
    expect(body.hasSecret).toBe(true);
    expect(store.getClientKeyWithSecret()?.key).toBe(body.key);
    expect(mirror.get()).toBe(body.key);
  });

  it('GET after generate returns metadata only (no plaintext leak)', async () => {
    const app = makeApp(store, mirror);
    await app.request('/admin/api/proxy-token/generate', { method: 'POST', headers: adminHeaders() });
    const get = await app.request('/admin/api/proxy-token', { headers: adminHeaders() });
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('key');
    expect(body.hasSecret).toBe(true);
  });

  it('DELETE clears DB and mirror; second call is still 204', async () => {
    const app = makeApp(store, mirror);
    await app.request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ key: 'a'.repeat(64) }),
    });
    expect(mirror.get()).toBe('a'.repeat(64));
    const r1 = await app.request('/admin/api/proxy-token', { method: 'DELETE', headers: adminHeaders() });
    expect(r1.status).toBe(204);
    expect(store.getClientKey()).toBeNull();
    expect(mirror.get()).toBeUndefined();
    const r2 = await app.request('/admin/api/proxy-token', { method: 'DELETE', headers: adminHeaders() });
    expect(r2.status).toBe(204);
  });

  it('endpoints require admin auth', async () => {
    const app = makeApp(store, mirror);
    const get = await app.request('/admin/api/proxy-token');
    expect(get.status).toBe(401);
    const put = await app.request('/admin/api/proxy-token', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'a'.repeat(64) }),
    });
    expect(put.status).toBe(401);
    const gen = await app.request('/admin/api/proxy-token/generate', { method: 'POST' });
    expect(gen.status).toBe(401);
    const del = await app.request('/admin/api/proxy-token', { method: 'DELETE' });
    expect(del.status).toBe(401);
  });
});
