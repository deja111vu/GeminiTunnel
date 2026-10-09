import { describe, it, expect } from 'vitest';
import { createApp } from './server.js';
import { KeyPool } from './api/gemini/keyPool.js';
import { KeyClient } from './api/gemini/keyClient.js';
import type { Config } from './config.js';

const K1 = 'AIzaSyA' + 'a'.repeat(36);

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
      keyPathEnabled: true,
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

  it('?key=AIza... is rejected in OAuth-only mode (no keyPool wired)', async () => {
    // F3 invariant: a well-formed AIza in the URL must 400 even when
    // the dispatcher is not registered (OAuth-only deployment). The
    // proxy sits behind nginx/Cloudflare in production — those log the
    // raw URL, so the 400 must fire before any other handler.
    const app = createApp();
    const res = await app.request(`/v1/chat/completions?key=${K1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });

  it('?KEY=AIza... (uppercase) is also rejected — case-sensitivity regression', async () => {
    // URLSearchParams.get('key') is case-sensitive, so a naive
    // `get('key')` check would let `?KEY=AIza…` through. The edge
    // guard scans every value with KEY_RE, regardless of name, so the
    // bypass is closed.
    const app = createApp();
    const res = await app.request(`/v1/chat/completions?KEY=${K1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });

  it('?api_key=AIza... is also rejected — arbitrary parameter names', async () => {
    // Same bypass class, different name. The guard matches on VALUE.
    const app = createApp();
    const res = await app.request(`/v1/chat/completions?api_key=${K1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });
});
