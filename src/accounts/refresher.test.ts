import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from './store.js';
import { TokenRefresher } from './refresher.js';

// Mock google-auth-library at the module level.
const setCredentialsMock = vi.fn();
const refreshAccessTokenMock = vi.fn();

vi.mock('../oauth/client.js', () => ({
  OAUTH_SCOPES: [],
  REDIRECT_URI: 'http://127.0.0.1:1/callback',
  oauthClient: () => ({
    setCredentials: setCredentialsMock,
    refreshAccessToken: refreshAccessTokenMock,
  }),
}));

const KEY = 'a'.repeat(64);

describe('TokenRefresher', () => {
  let tmp: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-'));
    store = createStore(tmp, KEY);
    setCredentialsMock.mockReset();
    refreshAccessTokenMock.mockReset();
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns cached access_token when still valid', async () => {
    const acc = store.addAccount({
      email: 'a@b.com',
      refreshToken: 'r',
      accessToken: 'cached',
      expiresAt: Date.now() + 600_000,
    });
    const r = new TokenRefresher(store, KEY);
    const tok = await r.getAccessToken(acc.id);
    expect(tok).toBe('cached');
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it('refreshes when token expiring within 60s', async () => {
    const acc = store.addAccount({
      email: 'a@b.com',
      refreshToken: 'r',
      accessToken: 'old',
      expiresAt: Date.now() + 30_000,
    });
    refreshAccessTokenMock.mockResolvedValue({
      credentials: {
        access_token: 'new',
        expiry_date: Date.now() + 3600_000,
        refresh_token: 'r2',
      },
    });
    const r = new TokenRefresher(store, KEY);
    const tok = await r.getAccessToken(acc.id);
    expect(tok).toBe('new');
    expect(setCredentialsMock).toHaveBeenCalledWith({ refresh_token: 'r' });
    const at = store.readActiveAccessToken(acc.id);
    expect(at?.token).toBe('new');
    // rotated refresh token was persisted
    expect(store.readActiveRefreshToken(acc.id)).toBe('r2');
  });

  it('marks account invalid on invalid_grant', async () => {
    const acc = store.addAccount({
      email: 'a@b.com',
      refreshToken: 'r',
      accessToken: 'old',
      expiresAt: Date.now() + 30_000,
    });
    refreshAccessTokenMock.mockRejectedValue(new Error('invalid_grant: token revoked'));
    const r = new TokenRefresher(store, KEY);
    await expect(r.getAccessToken(acc.id)).rejects.toThrow();
    const fresh = store.getAccount(acc.id)!;
    expect(fresh.status).toBe('invalid');
    expect(fresh.lastError).toMatch(/invalid_grant/);
  });
});
