import { createApp } from './server.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { createStore } from './accounts/store.js';
import { TokenRefresher } from './accounts/refresher.js';
import { AccountPool } from './accounts/pool.js';
import { CodeAssistClient } from './api/codeassist/client.js';
import { handleChatCompletion } from './api/openai/chat.js';
import { handleListModels } from './api/openai/models.js';
import { handleAdminApi, serveAdminUi } from './api/admin/api.js';
import { QuotaPoller } from './quota/poller.js';

async function main(): Promise<void> {
  const app = createApp();
  const store = createStore(config.dataDir, config.accountsEncryptionKey);
  const refresher = new TokenRefresher(store, config.accountsEncryptionKey);
  const pool = new AccountPool({ store, refresher, cooldownMs: config.cooldownAfter429Ms });
  const client = new CodeAssistClient();

  handleChatCompletion({ app, pool, client, store, config });
  handleListModels({ app });
  serveAdminUi(app);
  handleAdminApi({
    app,
    store,
    refresher,
    encryptionKey: config.accountsEncryptionKey,
    adminToken: config.adminToken,
  });

  const poller = new QuotaPoller({
    store,
    refresher,
    client,
    intervalMs: config.quotaPollIntervalMs,
  });
  poller.start();

  // Graceful shutdown: stop the poller and checkpoint the WAL on
  // SIGINT/SIGTERM so a mid-iteration runOnce doesn't get cut off, and
  // the on-disk WAL file is folded+truncated instead of leaving recent
  // pages in a 0o600 sidecar with no checkpoint marker.
  const shutdown = (): void => {
    poller.stop();
    store.close();
    logger.info('gemini-tunnel shutting down');
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const { serve } = await import('@hono/node-server').catch(() => ({ serve: null }));

  if (serve) {
    serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  }

  logger.info({ port: config.port, host: config.host }, 'gemini-tunnel starting');
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
  process.exit(1);
});
