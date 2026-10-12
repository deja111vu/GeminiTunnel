import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createStore, type Store } from '../../accounts/store.js';
import { KeyPool } from '../gemini/keyPool.js';
import { handleAdminApi } from './api.js';

const KEY = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);

const getTokenMock = vi.fn();
const fetchMock = vi.fn();
vi.mock('../../oauth/client.js', () => ({
  OAUTH_SCOPES: ['openid'],
  REDIRECT_URI: 'http://127.0.0.1:1/callback',
  oauthClient: () => ({ getToken: getTokenMock }),
}));

function makeApp(
  store: Store,
  keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 }),
) {
  const app = new Hono();
  // mock refresher: both methods are now part of the RefresherLike contract
  // (the admin refresh endpoint calls forceRefresh after d15a927).
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
    keyPool,
  });
  return app;
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
}

describe('handleAdminApi', () => {
  let tmp: string;
  let store: Store;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
    getTokenMock.mockReset();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    // @ts-expect-error restore
    globalThis.fetch = undefined;
  });

  it('GET /admin/api/accounts returns [] when empty', async () => {
    const res = await makeApp(store).request('/admin/api/accounts', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual([]);
  });

  it('GET /admin/api/accounts returns masked (no token) list', async () => {
    store.addAccount({ email: 'a@e.com', refreshToken: 'rt-a' });
    const res = await makeApp(store).request('/admin/api/accounts', { headers: adminHeaders() });
    const body = (await res.json()) as { email: string; hasRefreshToken: boolean }[];
    expect(body.length).toBe(1);
    expect(body[0]!.email).toBe('a@e.com');
    expect(body[0]!.hasRefreshToken).toBe(true);
  });

  it('DELETE /admin/api/accounts/:id removes the account', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    const res = await makeApp(store).request(`/admin/api/accounts/${a.id}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(204);
    expect(store.getAccount(a.id)).toBeNull();
  });

  it('DELETE /admin/api/accounts/:id returns 404 for unknown id', async () => {
    const res = await makeApp(store).request('/admin/api/accounts/9999', {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('POST /admin/api/accounts/:id/refresh delegates to refresher and returns ok', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    const res = await makeApp(store).request(`/admin/api/accounts/${a.id}/refresh`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tokenExpiresAt: number | null };
    expect(body.ok).toBe(true);
    expect(body.tokenExpiresAt).toBeNull();
  });

  it('GET /admin/api/accounts/:id/quota returns snapshots and events', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    store.recordQuotaSnapshot(a.id, 'gemini-2.5-pro', 50, 100, Date.now() + 1000);
    store.recordQuotaEvent(a.id, 'gemini-2.5-pro', '429', Date.now() + 1000);
    const res = await makeApp(store).request(`/admin/api/accounts/${a.id}/quota`, {
      headers: adminHeaders(),
    });
    const body = (await res.json()) as {
      snapshots: { model: string }[];
      events: { source: string }[];
    };
    expect(body.snapshots.length).toBe(1);
    expect(body.snapshots[0]!.model).toBe('gemini-2.5-pro');
    expect(body.events.length).toBe(1);
    expect(body.events[0]!.source).toBe('429');
  });

  it('POST /admin/api/oauth/start returns URL and state', async () => {
    const res = await makeApp(store).request('/admin/api/oauth/start', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ accountLabel: 'work' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; state: string };
    expect(body.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(body.state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('POST /admin/api/oauth/exchange finalizes login and stores account', async () => {
    getTokenMock.mockResolvedValue({
      tokens: {
        access_token: 'at',
        refresh_token: 'rt',
        expiry_date: Date.now() + 3600_000,
        token_type: 'Bearer',
      },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: 'me@e.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // First: start the flow to register pending state.
    const start = await makeApp(store).request('/admin/api/oauth/start', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ accountLabel: 'work' }),
    });
    const { state } = (await start.json()) as { state: string };

    // Then: exchange.
    const res = await makeApp(store).request('/admin/api/oauth/exchange', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ state, code: 'c' }),
    });
    expect(res.status).toBe(200);
    const acc = store.getAccountByEmail('me@e.com');
    expect(acc).toBeTruthy();
  });

  it('POST /admin/api/oauth/exchange returns 400 for unknown state', async () => {
    const res = await makeApp(store).request('/admin/api/oauth/exchange', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ state: 'nope', code: 'c' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /admin/api/oauth/exchange returns 500 (not 502) for an untyped internal error', async () => {
    const { finalizeLogin } = await import('../../oauth/finalize.js');
    const spy = vi
      .spyOn(await import('../../oauth/finalize.js'), 'finalizeLogin')
      .mockRejectedValue(new Error('ciphertext too short')); // not a FinalizeError
    const res = await makeApp(store).request('/admin/api/oauth/exchange', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ state: 'any', code: 'c' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('internal_error');
    expect(body.error).not.toBe('exchange_failed'); // not 502 upstream
    spy.mockRestore();
  });

  it('rejects requests without admin bearer', async () => {
    const res = await makeApp(store).request('/admin/api/accounts');
    expect(res.status).toBe(401);
  });

  it('POST /admin/api/login sets HttpOnly+Secure+SameSite=Strict cookie on success', async () => {
    // F18: localStorage is replaced by an HttpOnly cookie so an XSS
    // payload can't exfil the admin token. The cookie must also be
    // Secure (HTTPS only) and SameSite=Strict (CSRF defense).
    const res = await makeApp(store).request('/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/admin/i);
    // The token value must not be in the body (no echo).
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /admin/api/login returns 401 on wrong token', async () => {
    const res = await makeApp(store).request('/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong'.padEnd(64, 'x') }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('requireAdmin accepts a request that authenticates via cookie', async () => {
    // After login, the SPA stores nothing — it relies on the browser
    // auto-sending the cookie. Simulate that by forwarding the Set-Cookie
    // header back as Cookie.
    const login = await makeApp(store).request('/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    const cookieValue = /gemini-tunnel-admin=([^;]+)/.exec(setCookie)?.[1] ?? '';
    const res = await makeApp(store).request('/admin/api/accounts', {
      headers: { cookie: `gemini-tunnel-admin=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual([]);
  });

  it('POST /admin/api/logout clears the cookie', async () => {
    const logout = await makeApp(store).request('/admin/api/logout', { method: 'POST' });
    expect(logout.status).toBe(204);
    const setCookie = logout.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/gemini-tunnel-admin=;/); // empty value
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('POST /admin/api/oauth/exchange returns a generic error body that does not echo upstream or user-supplied input', async () => {
    // finalizeLogin throws a message containing user-controlled state and an
    // upstream error string. Neither should leak in the response.
    const spy = vi
      .spyOn(await import('../../oauth/finalize.js'), 'finalizeLogin')
      .mockRejectedValue(new Error('unknown or expired state: <script>alert(1)</script>'));
    const res = await makeApp(store).request('/admin/api/oauth/exchange', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ state: 'attacker-input', code: 'c' }),
    });
    // Untyped Error → 500 (internal), not 502 (upstream) — the distinction
    // matters for monitoring and on-call pages.
    expect(res.status).toBe(500);
    const body = (await res.text()).toLowerCase();
    expect(body).not.toContain('attacker-input');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('unknown or expired state');
    spy.mockRestore();
  });

  it('POST /admin/api/accounts/:id/refresh does not return a token preview (no secret material in body)', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    const res = await makeApp(store).request(`/admin/api/accounts/${a.id}/refresh`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('tokenPreview');
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('accessTokenPreview');
  });

  const K1 = 'AQ.Ab' + 'a'.repeat(44); // 49 chars — a valid Google Auth key example (40..∞ allowed)
  const K2 = 'AQ.Ab' + 'b'.repeat(44);

  it('GET /admin/api/keys returns [] when empty', async () => {
    const res = await makeApp(store).request('/admin/api/keys', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('POST /admin/api/keys creates a row, adds to the pool, returns 201 without the key', async () => {
    const keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
    const app = makeApp(store, keyPool);
    const res = await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'prod-a', key: K1 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.label).toBe('prod-a');
    expect(body.keyId).toHaveLength(8);
    expect(body).not.toHaveProperty('key');
    expect(JSON.stringify(body)).not.toContain(K1);
    expect(keyPool.pick().key).toBe(K1);
  });

  it('GET after POST returns metadata only (no plaintext anywhere)', async () => {
    const app = makeApp(store);
    await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'a', key: K1 }),
    });
    const res = await app.request('/admin/api/keys', { headers: adminHeaders() });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(K1);
    expect(text).toContain('keyId');
  });

  it('logger is never called with the plaintext key', async () => {
    const loggerMod = await import('../../logger.js');
    const spy = vi.spyOn(loggerMod.logger, 'info').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn').mockImplementation(() => undefined);
    try {
      const app = makeApp(store);
      await app.request('/admin/api/keys', {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({ label: 'a', key: K1 }),
      });
      await app.request('/admin/api/keys', { headers: adminHeaders() });
      for (const fn of [spy, errSpy, warnSpy]) {
        for (const call of fn.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(K1);
        }
      }
    } finally {
      spy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore();
    }
  });

  it('POST rejects an empty label (400 invalid_request)', async () => {
    const res = await makeApp(store).request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: '   ', key: K1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('POST rejects a label with illegal characters (400 invalid_request)', async () => {
    const res = await makeApp(store).request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'has space', key: K1 }),
    });
    expect(res.status).toBe(400);
  });

  it('POST rejects a malformed key (400 invalid_key_format)', async () => {
    const res = await makeApp(store).request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'a', key: 'not-a-google-key' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_key_format');
  });

  it('POST rejects a duplicate label (409 label_taken)', async () => {
    const app = makeApp(store);
    await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'dup', key: K1 }),
    });
    const res = await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'dup', key: K2 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('label_taken');
  });

  it('POST rejects a duplicate key (409 key_already_registered)', async () => {
    const app = makeApp(store);
    await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'a', key: K1 }),
    });
    const res = await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'b', key: K1 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('key_already_registered');
  });

  it('DELETE removes the row and purges the key from the pool', async () => {
    const keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
    const app = makeApp(store, keyPool);
    const created = await (await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'a', key: K1 }),
    })).json();
    const res = await app.request('/admin/api/keys/' + created.id, {
      method: 'DELETE', headers: adminHeaders(),
    });
    expect(res.status).toBe(204);
    expect(store.listApiKeys()).toHaveLength(0);
    expect(() => keyPool.pick()).toThrow();
  });

  it('DELETE returns 404 for an unknown id', async () => {
    const res = await makeApp(store).request('/admin/api/keys/999', {
      method: 'DELETE', headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE rejects non-canonical ids (hex / exp / blank) with 400', async () => {
    // Number('0x1A') === 26, Number('1e2') === 100, Number('') === 0.
    // A loose Number() check would let DELETE /admin/api/keys/0x1A
    // delete row 26. Pin the strict digit rule.
    const app = makeApp(store);
    for (const id of ['abc', '0x1A', '1e2', '', '1.5', '-1']) {
      const res = await app.request('/admin/api/keys/' + id, {
        method: 'DELETE', headers: adminHeaders(),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_id');
    }
  });

  it('PATCH enabled:false drops the key from the pool; true restores it', async () => {
    const keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
    const app = makeApp(store, keyPool);
    const created = await (await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'a', key: K1 }),
    })).json();
    const off = await app.request('/admin/api/keys/' + created.id, {
      method: 'PATCH', headers: adminHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect((await off.json()).enabled).toBe(false);
    expect(() => keyPool.pick()).toThrow();
    const on = await app.request('/admin/api/keys/' + created.id, {
      method: 'PATCH', headers: adminHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect((await on.json()).enabled).toBe(true);
    expect(keyPool.pick().key).toBe(K1);
  });

  it('PATCH returns 404 for an unknown id', async () => {
    const res = await makeApp(store).request('/admin/api/keys/999', {
      method: 'PATCH', headers: adminHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH returns 400 when enabled is not a boolean', async () => {
    const app = makeApp(store);
    const created = await (await app.request('/admin/api/keys', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ label: 'a', key: K1 }),
    })).json();
    const res = await app.request('/admin/api/keys/' + created.id, {
      method: 'PATCH', headers: adminHeaders(),
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('GET /admin/api/keys requires admin auth', async () => {
    const res = await makeApp(store).request('/admin/api/keys');
    expect([401, 403]).toContain(res.status);
  });
});
