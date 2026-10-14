import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './server.js';
import { KeyPool } from './api/gemini/keyPool.js';
import { KeyClient } from './api/gemini/keyClient.js';
import { AccountPool } from './accounts/pool.js';
import { UnifiedPool } from './api/gemini/unifiedPool.js';
import { CodeAssistClient } from './api/codeassist/client.js';
import { createStore } from './accounts/store.js';
import {
  getProxyTokenStore,
  resetProxyTokenStoreForTests,
} from './api/admin/proxyTokenStore.js';
import type { Config } from './config.js';

const K1 = 'AQ.Ab' + 'a'.repeat(44);
const PROXY_TOKEN = 'p'.repeat(64);

// Helper for tests that exercise the post-bodyCap path. Resets the
// proxy-token singleton and pre-seeds it so the closed-always
// middleware accepts the test Bearer. The `extra` deps (keyPool,
// keyClient, etc.) are forwarded to createApp as-is.
function makeAppWithToken(extra: Parameters<typeof createApp>[0] = {}): ReturnType<typeof createApp> {
  resetProxyTokenStoreForTests();
  const mirror = getProxyTokenStore();
  mirror.set(PROXY_TOKEN);
  return createApp({ ...extra, proxyTokenStore: mirror });
}

describe('server', () => {
  it('GET /health returns ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('gemini-tunnel');
  });

  it('GET /health returns minimal body (no upstreams, no counts)', async () => {
    // Detailed pool state (configured key count, cooldown/bad counters,
    // OAuth account counts) is intentionally NOT exposed on /health —
    // it was a reconnaissance oracle for unauthenticated callers.
    // Detailed state lives behind the admin UI; the public probe is
    // just "is the process up?".
    const keyPool = new KeyPool({ keys: [K1], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
    const keyClient = new KeyClient({ baseUrl: 'https://generativelanguage.googleapis.com' });
    const cfg: Config = {
      ...({} as Config),
      geminiApiKeys: [K1],
      keyCooldownAfter429Ms: 60_000,
      keyBadTtlMs: 86_400_000,
    } as Config;
    const app = createApp({ keyPool, keyClient, config: cfg });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', service: 'gemini-tunnel' });
    expect(body).not.toHaveProperty('upstreams');
  });

  it('GET /health in OAuth-only mode (no keyPool): also returns minimal body', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', service: 'gemini-tunnel' });
  });

  it('rejects oversized POST to /admin/api/* with 413 (F2: login is unauthenticated, must still be capped)', async () => {
    // The /admin/api/login route is intentionally unauthenticated so the
    // operator can bootstrap a session. Without the body cap, an attacker
    // can OOM the process by POSTing a 200MB body to it. The cap MUST
    // cover /admin/api/* as well as /v1/*.
    const app = createApp();
    const res = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('rejects oversized POST to /v1/* with 413', async () => {
    const app = createApp();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('rejects POST with missing Content-Length to /v1/* with 411', async () => {
    // Hono may auto-add content-length: 0 for an empty body; pass a
    // body of empty string to exercise the path.
    const app = createApp();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(411);
  });

  // bodyCap is mounted on /v1/* and /admin/api/*, and gates every
  // method that conventionally carries a request body. Each method
  // is tested for the same invariant — a future refactor that
  // silently drops one of these methods from the gate MUST be caught
  // by these tests, not by a 3am OOM page.
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    it(`rejects ${method} with missing Content-Length to /v1/* with 411`, async () => {
      const app = createApp();
      const res = await app.request('/v1/chat/completions', {
        method,
        headers: { 'content-type': 'application/json' },
        body: '',
      });
      expect(res.status).toBe(411);
    });
  }

  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    it(`rejects ${method} with oversize body to /admin/api/* with 413`, async () => {
      const app = createApp();
      const res = await app.request('/admin/api/login', {
        method,
        headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
        body: '{}',
      });
      expect(res.status).toBe(413);
    });
  }

  it('?key=AQ.Ab... is rejected when key path is not wired (with valid proxy token)', async () => {
    // F3 invariant: a well-formed AQ. key in the URL must 400 even when
    // the dispatcher is not registered (key path not enabled). The
    // proxy sits behind nginx/Cloudflare in production — those log the
    // raw URL, so the 400 must fire before any other handler. The
    // proxy token is set here so the request passes clientAuth; the
    // 400 still has to come from rejectKeyInQuery.
    const app = makeAppWithToken();
    const res = await app.request(`/v1/chat/completions?key=${K1}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '2',
        authorization: `Bearer ${PROXY_TOKEN}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });

  it('?KEY=AQ.Ab... (uppercase) is also rejected — case-sensitivity regression', async () => {
    // URLSearchParams.get('key') is case-sensitive, so a naive
    // `get('key')` check would let `?KEY=AQ.Ab…` through. The edge
    // guard scans every value with KEY_RE, regardless of name, so the
    // bypass is closed.
    const app = makeAppWithToken();
    const res = await app.request(`/v1/chat/completions?KEY=${K1}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '2',
        authorization: `Bearer ${PROXY_TOKEN}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });

  it('?api_key=AQ.Ab... is also rejected — arbitrary parameter names', async () => {
    // Same bypass class, different name. The guard matches on VALUE.
    const app = makeAppWithToken();
    const res = await app.request(`/v1/chat/completions?api_key=${K1}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '2',
        authorization: `Bearer ${PROXY_TOKEN}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });

  it('empty KeyPool + valid x-goog-api-key + valid proxy Bearer -> dispatcher routes the keyed call (no silent fallthrough)', async () => {
    // Spec: "AQ.Ab… (valid format) | irrelevant | proxy uses *that* key as
    // a single shot, ignores pool". The dispatcher must NOT silently
    // fall through to the OAuth handler just because the pool is empty;
    // a client that explicitly named a key gets a single-shot keyed
    // request. We mock keyClient.getJson to make the upstream call
    // observable without a real Google round-trip.
    const keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
    const keyClient = new KeyClient({ baseUrl: 'https://generativelanguage.googleapis.com', timeoutMs: 5_000 });
    vi.spyOn(keyClient, 'getJson').mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // The unified dispatcher (Task 7) requires the FULL dep set: an
    // AccountPool (real, even if unused), a UnifiedPool wrapping it,
    // an OAuth client, and a real Store. An empty store yields an
    // empty UnifiedPool, so the dispatcher would normally have no
    // revolver targets — but the x-goog-api-key header (single-shot
    // contract) bypasses the revolver and goes straight to keyClient.
    const encKey = 'a'.repeat(64);
    const tmp = mkdtempSync(path.join(tmpdir(), 'gt-srv-'));
    const store = createStore(tmp, encKey);
    const accountPool = new AccountPool({
      store,
      refresher: {
        getAccessToken: vi.fn(async (id: number) => `tok-${id}`),
        forceRefresh: vi.fn(async (id: number) => `tok-${id}`),
      },
      cooldownMs: 60_000,
    });
    const unifiedPool = new UnifiedPool({ accountPool, keyPool, store });
    const oauthClient = new CodeAssistClient();
    const streamSpy = vi.spyOn(oauthClient, 'streamGenerateContent');
    const cfg = {
      geminiApiKeys: [],
      keyCooldownAfter429Ms: 60_000,
      keyBadTtlMs: 86_400_000,
      switchBudget: 1,
    } as unknown as Config;
    const app = makeAppWithToken({
      keyPool,
      keyClient,
      pool: accountPool,
      unifiedPool,
      oauthClient,
      store,
      config: cfg,
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(JSON.stringify({ model: 'gemini-2.5-pro', messages: [] }).length),
        'x-goog-api-key': K1,
        authorization: `Bearer ${PROXY_TOKEN}`,
      },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [] }),
    });
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    expect(res.status).toBe(200);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  // Closed-always: with no token set anywhere, every /v1/* request
  // is rejected with 401 — the proxy is never silently open. The
  // bodyCap tests above still pass because bodyCap runs first; the
  // tests below exercise the path AFTER bodyCap has accepted the
  // request.
  describe('clientAuth (proxy token gate)', () => {
    it('returns 401 when no token is configured at all', async () => {
      // createApp() with no proxyTokenStore — the mirror returns
      // undefined forever, so the middleware 401s every /v1/* request.
      const app = createApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: '{}',
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
      expect((await res.json()).error).toBe('unauthorized');
    });

    it('returns 401 when the mirror is wired but empty', async () => {
      // The caller wired the store but no value was seeded.
      // Equivalent to "unset" from seedProxyTokenStore. We
      // explicitly reset the singleton here so the test does not
      // inherit the PROXY_TOKEN that earlier `makeAppWithToken()`
      // tests in the outer describe block seeded via
      // `mirror.set(PROXY_TOKEN)`.
      resetProxyTokenStoreForTests();
      const mirror = getProxyTokenStore();
      const app = createApp({ proxyTokenStore: mirror });
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const app = makeAppWithToken();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: '{}',
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    });

    it('returns 401 when Authorization does not match the Bearer scheme', async () => {
      const app = makeAppWithToken();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
          // Token without "Bearer " prefix — most likely a
          // misconfigured client.
          authorization: PROXY_TOKEN,
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when the Bearer does not match the configured token', async () => {
      const app = makeAppWithToken();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
          authorization: 'Bearer ' + 'q'.repeat(64),
        },
        body: '{}',
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('forbidden');
    });

    it('passes through when the Bearer matches (reaches rejectKeyInQuery -> 400)', async () => {
      const app = makeAppWithToken();
      // /v1/chat/completions with a valid Bearer and a key in the
      // query string: clientAuth passes, rejectKeyInQuery fires 400.
      // This proves the middleware lets the request through.
      const res = await app.request(`/v1/chat/completions?key=${K1}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
          authorization: `Bearer ${PROXY_TOKEN}`,
        },
        body: '{}',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('key_in_query_string_forbidden');
    });

    it('reads the mirror via the getter on every request (admin-UI rotation takes effect without rebuild)', async () => {
      const mirror = getProxyTokenStore();
      const app = createApp({ proxyTokenStore: mirror });
      // First request: mirror empty, 401.
      const r1 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: '{}',
      });
      expect(r1.status).toBe(401);
      // Simulate the admin-UI rotation: the next request MUST see the
      // new value without any middleware re-registration.
      const NEW_TOKEN = 'r'.repeat(64);
      mirror.set(NEW_TOKEN);
      const r2 = await app.request(`/v1/chat/completions?key=${K1}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
          authorization: `Bearer ${NEW_TOKEN}`,
        },
        body: '{}',
      });
      // 400 from rejectKeyInQuery proves clientAuth accepted the new
      // token (it would have 401'd if it had cached the old "no
      // token" state).
      expect(r2.status).toBe(400);
    });
  });
});
