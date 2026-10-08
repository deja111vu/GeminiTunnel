import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { keyOrOAuth } from './middleware.js';
import { KeyPool } from './keyPool.js';
import { KeyClient } from './keyClient.js';
import type { Config } from '../../config.js';

const K1 = 'AIzaSyA' + 'a'.repeat(36);
const KEYCONFIG: Pick<Config, 'switchBudget' | 'requestTimeoutMs' | 'keyBadTtlMs'> = {
  switchBudget: 2,
  requestTimeoutMs: 5_000,
  keyBadTtlMs: 86_400_000,
};

function makeApp(opts: { enabled: boolean; pool?: KeyPool; client?: KeyClient }) {
  const app = new Hono();
  const pool = opts.pool ?? new KeyPool({ keys: [K1], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
  const client = opts.client ?? new KeyClient({ baseUrl: 'https://generativelanguage.googleapis.com' });
  app.use('/v1/chat/completions', keyOrOAuth({ enabled: opts.enabled, pool, client, config: KEYCONFIG }));
  app.post('/v1/chat/completions', async (c) => c.json({ ok: 'oauth' }));
  return app;
}

const validBody = JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] });

describe('keyOrOAuth middleware', () => {
  it('no header → next() (OAuth)', async () => {
    const app = makeApp({ enabled: true });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: string };
    expect(body.ok).toBe('oauth');
  });

  it('empty header → next() (OAuth)', async () => {
    const app = makeApp({ enabled: true });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': '   ' },
      body: validBody,
    });
    expect(res.status).toBe(200);
  });

  it('valid header → key path (200 with upstream body)', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('{"id":"x","choices":[{"message":{"content":"hi"}}]}',
        { status: 200, headers: { 'content-type': 'application/json' } });
    const pool = new KeyPool({ keys: [K1], cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0 });
    const client = new KeyClient({ baseUrl: 'https://generativelanguage.googleapis.com', fetchImpl: fakeFetch });
    const app = makeApp({ enabled: true, pool, client });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': K1 },
      body: validBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('x');
  });

  it('invalid format → 400 bad_api_key_format', async () => {
    const app = makeApp({ enabled: true });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': 'Bearer xyz' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_api_key_format');
  });

  it('?key=AIza... → 400 key_in_query_string_forbidden', async () => {
    const app = makeApp({ enabled: true });
    const res = await app.request(`/v1/chat/completions?key=${K1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_in_query_string_forbidden');
  });

  it('?key=invalid → next() (no rejection, falls through to OAuth)', async () => {
    // Only well-formed AIza keys are rejected from the query string. A
    // random `?key=foo` is not a security issue and should not 400.
    const app = makeApp({ enabled: true });
    const res = await app.request('/v1/chat/completions?key=foo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    });
    expect(res.status).toBe(200);
  });

  it('Authorization: Bearer AIza... (no x-goog-api-key) → OAuth path', async () => {
    const app = makeApp({ enabled: true });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${K1}` },
      body: validBody,
    });
    expect(res.status).toBe(200);
  });

  it('enabled=false, header present → 400 key_path_disabled', async () => {
    const app = makeApp({ enabled: false });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': K1 },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('key_path_disabled');
  });

  it('enabled=false, ?key=AIza... → still 400 key_in_query_string_forbidden', async () => {
    // The query-string check fires regardless of `enabled`; a key in the
    // URL is a security risk even if the path that would use it is off.
    const app = makeApp({ enabled: false });
    const res = await app.request(`/v1/chat/completions?key=${K1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
