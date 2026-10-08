// middleware.ts — keyOrOAuth dispatcher. When a request comes in with
// `x-goog-api-key: <key>`, run it through the key path; otherwise let the
// existing OAuth handler take over. Always register this middleware (even
// when the key path is disabled) so `?key=AIza...` and a malformed header
// are rejected with 400 instead of being silently ignored.

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
    // Reject ?key= in the query string outright — keys in URLs land in
    // access logs, browser history, and referer headers. Always 400, even
    // when key path is disabled.
    //
    // Asymmetric by design: only `?key=AIza...` (well-formed) returns
    // 400. A truncated `?key=AIza` falls through to the next handler.
    // The regex is public so this is not an information leak, and a
    // shorter prefix has zero value to a legitimate client.
    const url = new URL(c.req.url);
    const queryKey = url.searchParams.get('key');
    if (queryKey !== null && KEY_RE.test(queryKey)) {
      return c.json({ error: 'key_in_query_string_forbidden' }, 400);
    }

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
