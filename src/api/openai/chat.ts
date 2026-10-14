// chat.ts — legacy OAuth chat-completion handler. The upstream-call loop
// lives in runOAuthChat (src/api/openai/oauthChat.ts); this file keeps the
// account-pool revolver that selects which account serves the request, so
// the legacy chat.test.ts (account-switching, F6, 401/403/429 handling)
// keeps working after the unifiedDispatch extraction.
//
// New deployments should mount unifiedDispatch (src/api/gemini/middleware.ts)
// on /v1/chat/completions instead of handleChatCompletion — the dispatcher
// covers OAuth accounts and API keys in a single revolver.

import type { Hono } from 'hono';
import { logger } from '../../logger.js';
import { CodeAssistClient } from '../codeassist/client.js';
import { runOAuthChat } from './oauthChat.js';
import type { AccountPool } from '../../accounts/pool.js';
import type { Store } from '../../accounts/store.js';
import type { Config } from '../../config.js';

export interface ChatHandlerDeps {
  app: Hono;
  pool: AccountPool;
  client: CodeAssistClient;
  store: Store;
  // ponytail: only switchBudget is read per request; cooldownAfter429Ms is
  // consumed at AccountPool construction time, so it's not part of this dep.
  config: Pick<Config, 'switchBudget'>;
}

export function handleChatCompletion({
  app,
  pool,
  client,
  store,
  config,
}: ChatHandlerDeps): void {
  app.post('/v1/chat/completions', async (c) => {
    // runOAuthChat does its own retry budget on the picked account
    // (5xx / 429 / 401 / 403 → continue; fatal 4xx → break). The outer
    // loop here accounts-switches: when runOAuthChat returns a
    // non-success response, we try the next account.
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < config.switchBudget; attempt++) {
      let picked;
      try {
        picked = await pool.pick();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'pool pick failed');
        return c.json({ error: 'no_account_available' }, 503);
      }
      const account = store.getAccount(picked.accountId);
      if (!account) {
        // Account vanished between pick() and getAccount() — skip and retry.
        continue;
      }
      const response = await runOAuthChat(c, {
        account,
        token: picked.token,
        store,
        client,
        config,
        pool,
      });
      if (response.status === 200) return response;
      // 400 = invalid_request (zod failed). Don't retry — same body
      // will fail the same way on every account.
      if (response.status === 400) return response;
      // Fatal 4xx (401/403/404 from upstream) — propagate immediately.
      if (response.status >= 400 && response.status < 500) return response;
      // 5xx / upstream_exhausted — try the next account.
      lastStatus = response.status;
      continue;
    }
    return c.json(
      { error: 'upstream_exhausted', retriable: true },
      { status: (lastStatus ?? 500) as 400 | 401 | 403 | 404 | 500 },
    );
  });
}
