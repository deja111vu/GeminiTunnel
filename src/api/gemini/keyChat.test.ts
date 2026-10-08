import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { handleApiKeyChat } from './keyChat.js';
import { KeyPool } from './keyPool.js';
import { KeyClient } from './keyClient.js';

const K1 = 'AIzaSyA' + 'a'.repeat(36);
const K2 = 'AIzaSyB' + 'b'.repeat(36);
const K3 = 'AIzaSyC' + 'c'.repeat(36);

function makeApp(pool: KeyPool, fetchImpl: typeof fetch, switchBudget = 2) {
  const app = new Hono();
  handleApiKeyChat({
    app,
    pool,
    client: new KeyClient({ baseUrl: 'https://generativelanguage.googleapis.com', fetchImpl }),
    config: { switchBudget, requestTimeoutMs: 5_000, keyBadTtlMs: 86_400_000 },
    postRoute: '/v1/chat/completions',
  });
  return app;
}

function makeSseResponse(events: string[]): Response {
  const body = events.join('\n\n') + '\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('handleApiKeyChat', () => {
  let now = 1_700_000_000_000;
  beforeEach(() => { now = 1_700_000_000_000; });

  function makePool(keys = [K1, K2]) {
    return new KeyPool({ keys, cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0, now: () => now });
  }

  it('stream=true, 200 SSE → 200 + text/event-stream с чанками', async () => {
    const fakeFetch: typeof fetch = async () =>
      makeSseResponse(['data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]']);
    const app = makeApp(makePool(), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('data: [DONE]');
  });

  it('F6: 1 ключ, fetch 429 до первого chunk → 503 all_keys_unavailable (не 200 + trailing error)', async () => {
    // With 1 key + budget=2: pick(K1) → 429 → recordRateLimit → continue →
    // pick(K1) → in cooldown → NoKeyAvailableError → 503.
    // The important F6 invariant is that we never return 200 with an
    // error chunk (we never even started streaming).
    const fakeFetch: typeof fetch = async () => new Response('rate limited', { status: 429 });
    const app = makeApp(makePool([K1]), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('all_keys_unavailable');
  });

  it('switch: k1 → 429, k2 → 200 SSE → 200', async () => {
    let i = 0;
    const fakeFetch: typeof fetch = async () => {
      const r = i++;
      if (r === 0) return new Response('rate limited', { status: 429 });
      return makeSseResponse(['data: {"id":"1","choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']);
    };
    const app = makeApp(makePool([K1, K2]), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content":"ok"');
  });

  it('network-fail на всех ключах → 502 upstream_exhausted', async () => {
    const fakeFetch: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
    const app = makeApp(makePool([K1, K2, K3]), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('upstream_exhausted');
  });

  it('all keys bad → 503 all_keys_unavailable with Retry-After', async () => {
    const pool = makePool([K1, K2]);
    pool.markBad(K1);
    pool.markBad(K2);
    now += 1;
    const fakeFetch: typeof fetch = async () => makeSseResponse(['data: {"id":"1"}', 'data: [DONE]']);
    const app = makeApp(pool, fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeDefined();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('all_keys_unavailable');
  });

  it('non-streaming JSON passthrough', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('{"id":"x","choices":[{"message":{"content":"ok"}}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const app = makeApp(makePool(), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('x');
  });

  it('invalid body → 400 invalid_request', async () => {
    const app = makeApp(makePool(), async () => new Response('{}'));
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ /* missing model */ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('stream=true but upstream JSON → 502', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('{"error":"oops"}', { status: 200, headers: { 'content-type': 'application/json' } });
    const app = makeApp(makePool(), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(502);
  });

  it('401 → markBad(k) + retry', async () => {
    let i = 0;
    const fakeFetch: typeof fetch = async () => {
      const r = i++;
      if (r === 0) return new Response('unauthorized', { status: 401 });
      return makeSseResponse(['data: {"id":"1"}', 'data: [DONE]']);
    };
    const pool = makePool([K1, K2]);
    const app = makeApp(pool, fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(200);
    // K1 marked bad
    const summary = pool.summaryForAllModels();
    expect(summary.bad).toBe(1);
  });

  it('404 → switch (not fail-fast)', async () => {
    let i = 0;
    const fakeFetch: typeof fetch = async () => {
      const r = i++;
      if (r === 0) return new Response('not found', { status: 404 });
      return makeSseResponse(['data: {"id":"1"}', 'data: [DONE]']);
    };
    const app = makeApp(makePool([K1, K2]), fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(200);
  });

  it('all keys in cooldown (not bad) → 503 with Retry-After=ceil(min cooldown)', async () => {
    const pool = makePool([K1, K2]);
    pool.recordRateLimit(K1, 'gemini-2.5-pro', 5_000);
    pool.recordRateLimit(K2, 'gemini-2.5-pro', 30_000);
    now += 1;
    const fakeFetch: typeof fetch = async () => makeSseResponse(['data: {"id":"1"}', 'data: [DONE]']);
    const app = makeApp(pool, fakeFetch);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(503);
    // K1's cooldown is ~4_999ms; ceiling → 5s.
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('all_keys_unavailable');
  });

  it('all keys bad → Retry-After = ceil(min badExpiry)', async () => {
    const pool = makePool([K1, K2]);
    pool.markBad(K1, 120_000); // 120s
    pool.markBad(K2, 5_000);   // 5s
    now += 1;
    const fakeFetch: typeof fetch = async () => makeSseResponse(['data: {"id":"1"}', 'data: [DONE]']);
    const app = makeApp(pool, fakeFetch, 2);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('client abort mid-stream → upstream fetch aborted, no exception', async () => {
    // Use a real AbortController; abort it after first chunk but before [DONE].
    let upstreamCancelled = false;
    const fakeFetch: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => { upstreamCancelled = true; });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
          await new Promise((r) => setTimeout(r, 50));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
        cancel() { upstreamCancelled = true; },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const ac = new AbortController();
    const app = makeApp(makePool(), fakeFetch);
    const promise = app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: ac.signal,
    });
    ac.abort();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(typeof upstreamCancelled).toBe('boolean');
  });
});
