import type { Store } from '../accounts/store.js';
import { popPending } from './state.js';
import { exchangeCode, fetchUserEmail } from './flow.js';
import { encrypt } from '../accounts/encryption.js';
import { logger } from '../logger.js';

// Typed error so callers can distinguish a client-side flow problem
// (bad/expired state → 400) from an upstream Google failure (502).
// The user-supplied state never appears in the response body — callers
// are expected to map `kind` to a status and return a generic message.
export type FinalizeErrorKind = 'unknown_state' | 'upstream';
export class FinalizeError extends Error {
  constructor(public readonly kind: FinalizeErrorKind, message: string) {
    super(message);
    this.name = 'FinalizeError';
  }
}

export async function finalizeLogin(args: {
  state: string;
  code: string;
  store: Store;
  encryptionKey: string;
}): Promise<{ id: number; email: string; status: string }> {
  const pending = popPending(args.state);
  if (!pending) {
    // Note: we intentionally do NOT include args.state in the error so the
    // route handler can't echo it back; it carries user-controlled content.
    throw new FinalizeError('unknown_state', 'unknown or expired state');
  }

  let tokens: { refreshToken: string | null; accessToken: string; expiresAt: number };
  try {
    tokens = await exchangeCode({ code: args.code, verifier: pending.verifier });
  } catch (err) {
    throw new FinalizeError('upstream', `exchange failed: ${(err as Error).message}`);
  }
  if (!tokens.refreshToken) {
    throw new FinalizeError(
      'upstream',
      'Google did not return a refresh_token (revoke prior consent and retry with prompt=consent)',
    );
  }
  let email: string;
  try {
    email = await fetchUserEmail(tokens.accessToken);
  } catch (err) {
    throw new FinalizeError('upstream', `userinfo failed: ${(err as Error).message}`);
  }
  const existing = args.store.getAccountByEmail(email);
  if (existing) {
    // Atomic write: the new access_token and the freshly issued
    // refresh_token must land together. A crash between the two writes
    // would re-use the prior refresh_token and Google would reject it
    // with invalid_grant.
    const refreshToken = tokens.refreshToken;
    const accessToken = tokens.accessToken;
    const expiresAt = tokens.expiresAt;
    const txn = args.store.db.transaction(() => {
      args.store.setActiveToken(existing.id, accessToken, expiresAt);
      args.store.db
        .prepare('UPDATE accounts SET refresh_token_encrypted=? WHERE id=?')
        .run(encrypt(refreshToken, args.encryptionKey), existing.id);
    });
    txn();
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
