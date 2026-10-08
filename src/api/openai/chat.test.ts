import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createStore, type Store } from '../../accounts/store.js';
import { AccountPool } from '../../accounts/pool.js';
import { CodeAssistClient } from '../codeassist/client.js';
import { handleChatCompletion } from './chat.js';

const KEY = 'a'.repeat(64);

function sseEvent(text: string, finish?: string): string {
  const body = {
    response: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          ...(finish ? { finishReason: finish } : {}),
        },
      ],
    },
  };
  let s = `data: ${JSON.stringify(body)}\n\n`;
  if (finish) s += 'data: [DONE]\n\n';
  return s;
}

function makeFixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
  const store = createStore(tmp, KEY);
  const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt-a' });
  const b = store.addAccount({ email: 'b@e.com', refreshToken: 'rt-b' });
  const refresher = { getAccessToken: vi.fn(async (id: number) => `tok-${id}`) };
  const pool = new AccountPool({ store, refresher: refresher as never, cooldownMs: 60_000 });
  return { tmp, store, refresher, pool, accounts: { a, b } };
}

function makeApp(pool: AccountPool, store: Store, fetchImpl: typeof fetch) {
  const app = new Hono();
  const client = new CodeAssistClient({
    baseUrl: 'https://upstream.test',
    fetchImpl,
  });
  handleChatCompletion({
    app,
    pool,
    client,
    store,
    config: { switchBudget: 3, cooldownAfter429Ms: 60_000 } as never,
  });
  return app;
}

describe('handleChatCompletion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('returns 200 and aggregated JSON for non-streaming success', async () => {
    const fx = makeFixture();
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(sseEvent('hello') + sseEvent(' world', 'STOP'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { choices: { message: { content: string }; finish_reason: string }[] };
      expect(json.choices[0]?.message.content).toBe('hello world');
      expect(json.choices[0]?.finish_reason).toBe('stop');
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it('switches to next account on 429 and sets cooldown on the first', async () => {
    const fx = makeFixture();
    try {
      // First account → 429; second account → 200 SSE.
      fetchMock
        .mockResolvedValueOnce(new Response('rate-limited', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(sseEvent('fallback ok', 'STOP'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const firstAcc = fx.store.getAccount(fx.accounts.a.id)!;
      expect(firstAcc.cooldownUntil).toBeGreaterThan(Date.now());
      const events = fx.store.listRecentQuotaEvents(fx.accounts.a.id, Date.now() - 10_000);
      expect(events.length).toBe(1);
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it('marks account invalid on 401 and falls through to next', async () => {
    const fx = makeFixture();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(
          new Response(sseEvent('ok', 'STOP'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'q' }],
        }),
      });
      expect(res.status).toBe(200);
      const a = fx.store.getAccount(fx.accounts.a.id)!;
      expect(a.status).toBe('invalid');
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it('marks account ineligible on 403', async () => {
    const fx = makeFixture();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
        .mockResolvedValueOnce(
          new Response(sseEvent('ok', 'STOP'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'q' }],
        }),
      });
      const a = fx.store.getAccount(fx.accounts.a.id)!;
      expect(a.status).toBe('ineligible');
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it('returns 500 when switch budget is exhausted', async () => {
    const fx = makeFixture();
    try {
      fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'q' }],
        }),
      });
      expect(res.status).toBe(500);
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it('streams SSE with x-gemini-tunnel-account header', async () => {
    const fx = makeFixture();
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(sseEvent('hi', 'STOP'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          stream: true,
          messages: [{ role: 'user', content: 'q' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gemini-tunnel-account')).toMatch(/.+@e\.com/);
      const text = await res.text();
      expect(text).toContain('"object":"chat.completion.chunk"');
      expect(text).toContain('"finish_reason":"stop"');
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it('returns 400 on invalid body', async () => {
    const fx = makeFixture();
    try {
      const app = makeApp(fx.pool, fx.store, fetchMock as unknown as typeof fetch);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ not_a_real_field: true }),
      });
      expect(res.status).toBe(400);
    } finally {
      fx.store.close();
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});
