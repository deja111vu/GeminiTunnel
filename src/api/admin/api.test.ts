import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createStore, type Store } from '../../accounts/store.js';
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

function makeApp(store: Store) {
  const app = new Hono();
  // mock refresher: getAccessToken returns a fake token
  const refresher = { getAccessToken: async (id: number) => `tok-${id}` };
  handleAdminApi({ app, store, refresher: refresher as never, encryptionKey: KEY, adminToken: ADMIN });
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
    const body = (await res.json()) as { ok: boolean; tokenPreview: string };
    expect(body.ok).toBe(true);
    expect(body.tokenPreview).toMatch(/^tok-1…$/);
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

  it('rejects requests without admin bearer', async () => {
    const res = await makeApp(store).request('/admin/api/accounts');
    expect(res.status).toBe(401);
  });
});
