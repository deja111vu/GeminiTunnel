import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createStore, type Store } from '../../accounts/store.js';
import { AccountPool } from '../../accounts/pool.js';
import { KeyPool } from './keyPool.js';
import { UnifiedPool } from './unifiedPool.js';
import { unifiedDispatch } from './middleware.js';
import { HttpError } from '../codeassist/client.js';
import { KeyClient } from './keyClient.js';
import { CodeAssistClient } from '../codeassist/client.js';
import { logger } from '../../logger.js';
import { keyIdFor } from './keyConfig.js';

const KEY = 'a'.repeat(64);
const K1 = 'AQ.Ab' + 'a'.repeat(44);
const K2 = 'AQ.Ab' + 'b'.repeat(44);

describe('unifiedDispatch', () => {
  let tmp: string;
  let store: Store;
  let accountPool: AccountPool;
  let keyPool: KeyPool;
  let keyClient: KeyClient;
  let oauthClient: CodeAssistClient;
  let pool: UnifiedPool;
  let app: Hono;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-ud-'));
    store = createStore(tmp, KEY);
    accountPool = new AccountPool({
      store,
      refresher: { getAccessToken: vi.fn(async (id) => `tok-${id}`), forceRefresh: vi.fn(async (id) => `tok-${id}`) },
      cooldownMs: 60_000,
    });
    keyPool = new KeyPool({ keys: [], cooldownMs: 60_000, badTtlMs: 60_000, jitterMs: 0 });
    keyClient = new KeyClient({ timeoutMs: 5_000 });
    oauthClient = new CodeAssistClient();
    pool = new UnifiedPool({ accountPool, keyPool, store });
    app = new Hono();
    app.post('/v1/chat/completions', unifiedDispatch({
      pool, accountPool, keyPool, keyClient, oauthClient, store,
      config: { switchBudget: 3, requestTimeoutMs: 5_000, keyBadTtlMs: 86_400_000 },
    }));
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('empty pool → 503 no_upstreams_enabled', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_upstreams_enabled');
  });

  it('x-goog-api-key with known-in-pool key uses that key and returns 200', async () => {
    store.addApiKey('k1', K1);
    keyPool.addKey(K1);
    pool.rebuild();
    vi.spyOn(keyClient, 'getJson').mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': K1 },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('x-goog-api-key that 5xx returns 500 to the client, no revolver fallback', async () => {
    store.addApiKey('k1', K1);
    store.addApiKey('k2', K2);
    keyPool.addKey(K1);
    keyPool.addKey(K2);
    pool.rebuild();
    const getJson = vi.spyOn(keyClient, 'getJson').mockRejectedValue(new HttpError(500, 'upstream 500'));
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': K1 },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(500);
    // Pinned path = single shot
    expect(getJson.mock.calls.length).toBe(1);
  });

  it('revolver: oauth-only pool with eligible account → 200 from OAuth path', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    pool.rebuild();
    vi.spyOn(oauthClient, 'streamGenerateContent').mockImplementation(async function* () {
      yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } as never;
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(a.id).toBeGreaterThan(0);
  });

  it('emits upstreamKind/upstreamId/pinned log fields on the apikey revolver path', async () => {
    store.addApiKey('k1', K1);
    keyPool.addKey(K1);
    pool.rebuild();
    vi.spyOn(keyClient, 'getJson').mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const infoSpy = vi.spyOn(logger, 'info');
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const attemptLog = infoSpy.mock.calls.find(
      (c) => typeof c[0] === 'object' && c[0] !== null && (c[0] as Record<string, unknown>).upstreamKind === 'apikey',
    );
    expect(attemptLog).toBeDefined();
    expect((attemptLog![0] as Record<string, unknown>).upstreamId).toBe(keyIdFor(K1));
    expect((attemptLog![0] as Record<string, unknown>).pinned).toBe(false);
  });

  it('emits upstreamKind/upstreamId/pinned log fields on the pinned-key path', async () => {
    store.addApiKey('k1', K1);
    keyPool.addKey(K1);
    pool.rebuild();
    vi.spyOn(keyClient, 'getJson').mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const infoSpy = vi.spyOn(logger, 'info');
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': K1 },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const pinLog = infoSpy.mock.calls.find(
      (c) => typeof c[0] === 'object' && c[0] !== null && (c[0] as Record<string, unknown>).pinned === true,
    );
    expect(pinLog).toBeDefined();
    expect((pinLog![0] as Record<string, unknown>).upstreamKind).toBe('apikey');
    expect((pinLog![0] as Record<string, unknown>).upstreamId).toBe(keyIdFor(K1));
  });
});
