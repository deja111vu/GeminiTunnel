// middleware.ts — unified dispatch over the enabled upstream pool.
// Spec: docs/superpowers/specs/2026-10-14-unified-upstream-pool-design.md
//
// Behavior:
//   - x-goog-api-key: <pinned> → single-shot through runKeyChat with
//     the pinned key. The revolver is NOT consulted on failure. The
//     pinned key does NOT consume switchBudget. Cooldown/bad tracking
//     on the real KeyPool still applies when the pinned key is in it.
//   - no header → revolver path: for (i=0; i<switchBudget; i++)
//     await pool.pick(); on the kind, dispatch to runKeyChat
//     (apikey branch) or runOAuthChat (oauth branch). On 429/401/
//     403/5xx continue; on fatal 4xx break; on budget exhaustion
//     return upstream_exhausted.
//   - empty pool → 503 no_upstreams_enabled.

import type { Context, MiddlewareHandler } from 'hono';
import { runKeyChat } from './keyChat.js';
import { runOAuthChat } from '../openai/oauthChat.js';
import { KEY_RE, keyIdFor } from './keyConfig.js';
import type { CodeAssistClient } from '../codeassist/client.js';
import type { KeyClient } from './keyClient.js';
import type { KeyPool } from './keyPool.js';
import type { AccountPool } from '../../accounts/pool.js';
import type { Store } from '../../accounts/store.js';
import type { Config } from '../../config.js';
import type { UnifiedPool } from './unifiedPool.js';
import { logger } from '../../logger.js';

export interface UnifiedDispatchDeps {
  pool: UnifiedPool;
  accountPool: AccountPool;
  keyPool: KeyPool;        // real KeyPool instance (Task 3 wires it from UnifiedPool)
  keyClient: KeyClient;
  oauthClient: CodeAssistClient;
  store: Store;
  config: Pick<Config, 'switchBudget' | 'requestTimeoutMs' | 'keyBadTtlMs'>;
}

export function unifiedDispatch(deps: UnifiedDispatchDeps): MiddlewareHandler {
  const { pool, accountPool, keyPool, keyClient, oauthClient, store, config } = deps;
  return async (c: Context): Promise<Response> => {
    const headerKey = c.req.header('x-goog-api-key')?.trim() ?? '';

    if (headerKey) {
      // Single-shot override. The client explicitly named the key.
      if (!KEY_RE.test(headerKey)) {
        return c.json({ error: 'bad_api_key_format' }, 400);
      }
      // Delegate to the key path with the pinned key. runKeyChat
      // handles its own single-shot semantics (no budget consumption
      // on the pinned path). The real KeyPool is passed through so
      // cooldown/bad tracking still applies when the pinned key is
      // known to the pool (pinned-in-pool); pinned-not-in-pool keys
      // silently bypass tracking via the `if (!this.known(key))` guard.
      // upstreamId uses the spec's keyIdFor — operators with several
      // keys need to know which one served the request. Works for
      // pinned-not-in-pool too (pure function on the key string).
      logger.info(
        { upstreamKind: 'apikey', upstreamId: keyIdFor(headerKey), pinned: true },
        'dispatch: pinned-key path',
      );
      return runKeyChat(c, {
        pool: keyPool,
        client: keyClient,
        config,
        pinnedKey: headerKey,
      });
    }

    // Revolver path.
    for (let attempt = 0; attempt < config.switchBudget; attempt++) {
      let upstream;
      try {
        upstream = await pool.pick();
      } catch {
        // pool is empty or every oauth pick failed
        return c.json({ error: 'no_upstreams_enabled' }, 503);
      }
      logger.info(
        {
          upstreamKind: upstream.kind,
          // Spec: account.id for oauth, keyIdFor(key) for apikey.
          // Picker guarantees the revolver key is in the pool, so
          // keyIdFor(upstream.key) is always available.
          upstreamId: upstream.kind === 'apikey' ? keyIdFor(upstream.key) : upstream.account.id,
          pinned: false,
          attempt,
        },
        'dispatch: revolver attempt',
      );
      try {
        if (upstream.kind === 'apikey') {
          return await runKeyChat(c, {
            pool: keyPool,
            client: keyClient,
            config,
            pinnedKey: upstream.key,
          });
        }
        return await runOAuthChat(c, {
          account: upstream.account,
          token: upstream.token,
          store,
          client: oauthClient,
          config,
          pool: accountPool,
        });
      } catch (err) {
        // The handler already applied the appropriate pool mutation
        // (recordRateLimit / recordInvalid / recordIneligible) inside
        // classifyKeyError / classifyUpstreamError. We only need to
        // log and decide whether to continue. To avoid coupling to
        // the handler's internals, we treat any thrown error as
        // "try the next upstream" — fatal 4xx from the OAuth branch
        // surfaces as lastFatalStatus inside runOAuthChat (it does
        // not throw); the apikey branch's classifyKeyError returns
        // 'fatal' which the handler breaks on (also no throw). So
        // a throw here is always a recoverable network/HTTP error.
        logger.warn(
          { err: (err as Error).message, kind: upstream.kind, attempt },
          'dispatch: upstream attempt failed',
        );
        continue;
      }
    }
    return c.json({ error: 'upstream_exhausted', retriable: true }, 502);
  };
}
