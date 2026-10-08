import type { Store } from './store.js';
import { oauthClient } from '../oauth/client.js';
import { logger } from '../logger.js';
import { encrypt } from './encryption.js';

const REFRESH_LEEWAY_MS = 60_000;

export class TokenRefresher {
  constructor(
    private store: Store,
    private encryptionKey: string,
    private leewayMs: number = REFRESH_LEEWAY_MS,
  ) {}

  async getAccessToken(accountId: number): Promise<string> {
    const acc = this.store.getAccount(accountId);
    if (!acc) throw new Error(`account ${accountId} not found`);
    if (acc.status === 'invalid' || acc.status === 'ineligible') {
      throw new Error(`account ${acc.email} status=${acc.status}; re-login required`);
    }
    const cached = this.store.readActiveAccessToken(accountId);
    if (cached && cached.expiresAt - Date.now() > this.leewayMs) {
      return cached.token;
    }

    const refreshToken = this.store.readActiveRefreshToken(accountId);
    if (!refreshToken) {
      this.store.setStatus(accountId, 'invalid', 'no_refresh_token');
      throw new Error('no refresh token');
    }
    try {
      const client = oauthClient();
      client.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) throw new Error('no access_token from refresh');
      const expiresAt = credentials.expiry_date ?? Date.now() + 55 * 60 * 1000;
      this.store.setActiveToken(accountId, credentials.access_token, expiresAt);
      if (credentials.refresh_token && credentials.refresh_token !== refreshToken) {
        const stmt = this.store.db.prepare(
          'UPDATE accounts SET refresh_token_encrypted=? WHERE id=?',
        );
        stmt.run(encrypt(credentials.refresh_token, this.encryptionKey), accountId);
      }
      logger.info({ accountId, email: acc.email }, 'refreshed access_token');
      return credentials.access_token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = /invalid_grant|invalid_client|consent|revoked/i.test(msg)
        ? msg
        : `refresh_error: ${msg}`;
      this.store.setStatus(accountId, 'invalid', reason);
      logger.warn({ accountId, email: acc.email, err: reason }, 'refresh failed');
      throw err;
    }
  }
}
