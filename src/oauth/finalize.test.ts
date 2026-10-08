import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../accounts/store.js';
import { addPending, clearPending } from './state.js';
import { finalizeLogin, FinalizeError } from './finalize.js';

// Mock google-auth-library at the module level.
const getTokenMock = vi.fn();

vi.mock('./client.js', () => ({
  OAUTH_SCOPES: [],
  REDIRECT_URI: 'http://127.0.0.1:1/callback',
  oauthClient: () => ({
    getToken: getTokenMock,
  }),
}));

const KEY = 'a'.repeat(64);

describe('finalizeLogin', () => {
  let tmp: string;
  let store: ReturnType<typeof createStore>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
    clearPending();
    getTokenMock.mockReset();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    // @ts-expect-error restore
    globalThis.fetch = undefined;
  });

  it('exchanges code, fetches email, stores new account', async () => {
    addPending({ state: 'st', verifier: 'ver', accountLabel: 'work' });
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

    const acc = await finalizeLogin({ state: 'st', code: 'c', store, encryptionKey: KEY });
    expect(acc.email).toBe('me@e.com');
    expect(getTokenMock).toHaveBeenCalledWith({
      code: 'c',
      codeVerifier: 'ver',
      redirect_uri: 'http://127.0.0.1:1/callback',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    const stored = store.getAccountByEmail('me@e.com');
    expect(stored).toBeTruthy();
    expect(store.readActiveRefreshToken(stored!.id)).toBe('rt');
  });

  it('throws on unknown state', async () => {
    await expect(
      finalizeLogin({ state: 'unknown', code: 'c', store, encryptionKey: KEY }),
    ).rejects.toThrow(/unknown/);
  });

  it('throws FinalizeError(kind=unknown_state) so the route can map to 400', async () => {
    try {
      // Use a recognisable state string so we can confirm it never reaches
      // the error message (would be reflected to the client by the route).
      await finalizeLogin({
        state: 'attacker-controlled-state',
        code: 'c',
        store,
        encryptionKey: KEY,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FinalizeError);
      expect((err as FinalizeError).kind).toBe('unknown_state');
      expect((err as Error).message).not.toContain('attacker-controlled-state');
    }
  });

  it('throws FinalizeError(kind=upstream) when exchangeCode fails', async () => {
    addPending({ state: 'st3', verifier: 'ver3', accountLabel: 'l' });
    getTokenMock.mockRejectedValue(new Error('bad client secret'));
    try {
      await finalizeLogin({ state: 'st3', code: 'c', store, encryptionKey: KEY });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FinalizeError);
      expect((err as FinalizeError).kind).toBe('upstream');
    }
  });

  it('updates existing account when re-logged-in', async () => {
    const existing = store.addAccount({
      email: 'me@e.com',
      refreshToken: 'old-rt',
      accessToken: 'old-at',
      expiresAt: Date.now() - 1000,
    });
    addPending({ state: 'st2', verifier: 'ver2', accountLabel: 'work' });
    getTokenMock.mockResolvedValue({
      tokens: {
        access_token: 'new-at',
        refresh_token: 'new-rt',
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
    const out = await finalizeLogin({ state: 'st2', code: 'c', store, encryptionKey: KEY });
    expect(out.id).toBe(existing.id);
    expect(store.readActiveRefreshToken(existing.id)).toBe('new-rt');
  });
});
