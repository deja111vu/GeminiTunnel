// middleware.ts — keyOrOAuth dispatcher. When a request comes in with
// `x-goog-api-key: <key>`, run it through the key path; otherwise let the
// existing OAuth handler take over.
//
// Note: the `?key=AIza…`-in-query-string guard is NOT in this file. It
// lives in `server.ts` as `rejectKeyInQuery` and is mounted on /v1/*
// unconditionally, before this dispatcher. That way OAuth-only
// deployments (no keyPool/keyClient wired) still get the 400, and the
// rejection runs before any handler that might log the raw URL. We
// intentionally do not duplicate the check here — keeping one source of
// truth for the URL-leak invariant.

import type { Context, Next } from 'hono';
import { runKeyChat } from './keyChat.js';
import { KeyClient } from './keyClient.js';
import { KeyPool } from './keyPool.js';
import { KEY_RE } from './keyConfig.js';
import type { Config } from '../../config.js';

export interface KeyOrOAuthOptions {
  enabled: boolean;
  pool: KeyPool;
  client: KeyClient;
  // keyBadTtlMs is consumed by runKeyChat for the Retry-After fallback,
  // so the middleware has to pass the full slice through.
  config: Pick<Config, 'switchBudget' | 'requestTimeoutMs' | 'keyBadTtlMs'>;
}

export function keyOrOAuth(opts: KeyOrOAuthOptions) {
  const { enabled, pool, client, config } = opts;
  return async (c: Context, next: Next): Promise<Response | void> => {
    const headerKey = c.req.header('x-goog-api-key');
    const trimmed = headerKey?.trim() ?? '';
    if (!trimmed) {
      // No header → fall through to OAuth handler.
      return next();
    }
    if (!KEY_RE.test(trimmed)) {
      return c.json({ error: 'bad_api_key_format' }, 400);
    }
    if (!enabled) {
      return c.json({ error: 'key_path_disabled' }, 400);
    }
    return runKeyChat(c, { pool, client, config });
  };
}
