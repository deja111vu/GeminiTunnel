import type { Store } from '../accounts/store.js';
import { popPending } from './state.js';
import { exchangeCode, fetchUserEmail } from './flow.js';
import { encrypt } from '../accounts/encryption.js';
import { logger } from '../logger.js';

export async function finalizeLogin(args: {
  state: string;
  code: string;
  store: Store;
  encryptionKey: string;
}): Promise<{ id: number; email: string; status: string }> {
  const pending = popPending(args.state);
  if (!pending) throw new Error(`unknown or expired state: ${args.state}`);

  const tokens = await exchangeCode({ code: args.code, verifier: pending.verifier });
  if (!tokens.refreshToken) {
    throw new Error(
      'Google did not return a refresh_token (revoke prior consent and retry with prompt=consent)',
    );
  }
  const email = await fetchUserEmail(tokens.accessToken);
  const existing = args.store.getAccountByEmail(email);
  if (existing) {
    args.store.setActiveToken(existing.id, tokens.accessToken, tokens.expiresAt);
    args.store.db
      .prepare('UPDATE accounts SET refresh_token_encrypted=? WHERE id=?')
      .run(encrypt(tokens.refreshToken, args.encryptionKey), existing.id);
    logger.info({ email, id: existing.id }, 're-logged-in existing account');
    return { id: existing.id, email, status: existing.status };
  }
  const acc = args.store.addAccount({
    email,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  });
  logger.info({ email, id: acc.id }, 'new account stored');
  return { id: acc.id, email, status: acc.status };
}
