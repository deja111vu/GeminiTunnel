// End-to-end integration test: two accounts, mocked upstream 429 on
// account #1 then 200 on account #2. Verifies that the chat-completion
// handler routes the request through the second account and records
// `cooldownUntil` on the first one so the next pick skips it.
//
// The store, pool, refresher and Hono app are all real. Only the
// upstream fetch is mocked, so the pool's recordRateLimit ->
// setCooldown path is exercised end to end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createStore, type Store } from '../../src/accounts/store.js';
import { AccountPool } from '../../src/accounts/pool.js';
import { CodeAssistClient } from '../../src/api/codeassist/client.js';
import { handleChatCompletion } from '../../src/api/openai/chat.js';
import type { Account } from '../../src/accounts/store.js';
import type { RefresherLike } from '../../src/accounts/pool.js';

const KEY = 'a'.repeat(64);

function sseFrame(text: string, finish?: string): string {
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

describe('integration: /v1/chat/completions with 429 -> account switch', () => {
  let tmp: string;
  let store: Store;
  let refresher: RefresherLike;
  let pool: AccountPool;
  let accounts: { a: Account; b: Account };
  let fetchMock: ReturnType<typeof vi.fn>;
  let app: Hono;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-int-'));
    store = createStore(tmp, KEY);
    accounts = {
      a: store.addAccount({ email: 'a@e.com', refreshToken: 'rt-a' }),
      b: store.addAccount({ email: 'b@e.com', refreshToken: 'rt-b' }),
    };
    // Touch them in order so the LRU tie-breaker is deterministic: a is
    // older than b, so a is picked first. The first attempt must 429
    // and the second must succeed, exercising the switch path.
    store.touchUsed(accounts.a.id);
    store.touchUsed(accounts.b.id);
    store.touchUsed(accounts.b.id); // strictly newer than a
    refresher = {
      getAccessToken: vi.fn(async (id: number) => `tok-${id}`),
      forceRefresh: vi.fn(async (id: number) => `tok-${id}`),
    };
    pool = new AccountPool({ store, refresher, cooldownMs: 60_000 });

    fetchMock = vi.fn();
    const client = new CodeAssistClient({
      baseUrl: 'https://upstream.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    app = new Hono();
    handleChatCompletion({
      app,
      pool,
      client,
      store,
      config: { switchBudget: 3, cooldownAfter429Ms: 60_000 } as never,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('switches from a (429) to b (200) and records cooldownUntil on a', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(sseFrame('hello') + sseFrame(' world', 'STOP'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(json.choices[0]?.message.content).toBe('hello world');

    // Upstream was hit twice (once per picked account).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The first account is now on cooldown; the second is not. This is
    // the load-bearing invariant: the next pick must skip a and use b.
    const a = store.getAccount(accounts.a.id)!;
    const b = store.getAccount(accounts.b.id)!;
    expect(a.cooldownUntil).not.toBeNull();
    expect(a.cooldownUntil!).toBeGreaterThan(Date.now());
    expect(b.cooldownUntil == null || b.cooldownUntil < Date.now()).toBe(true);
  });

  it('exhausts switchBudget and returns no_account_available when every account 429s', async () => {
    // mockImplementation so each call gets a fresh Response — otherwise
    // toHttpError's body read on the first 429 consumes the body, and
    // every subsequent call sees a locked/empty stream.
    fetchMock.mockImplementation(
      () => new Response('rate limited', { status: 429 }) as unknown as Promise<Response>,
    );

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    // Both accounts 429 on the first two attempts, putting them on
    // cooldown. The third pick (switchBudget=3) has no eligible account
    // and pool.pick throws, which the chat handler maps to 503.
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('no_account_available');

    // Both accounts are now on cooldown.
    for (const id of [accounts.a.id, accounts.b.id]) {
      const acc = store.getAccount(id)!;
      expect(acc.cooldownUntil).not.toBeNull();
      expect(acc.cooldownUntil!).toBeGreaterThan(Date.now());
    }
  });
});
