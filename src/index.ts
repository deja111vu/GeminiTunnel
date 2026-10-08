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

  const { serve } = await import('@hono/node-server').catch(() => ({ serve: null }));

  let server: { close: (cb?: (err?: Error) => void) => void } | null = null;
  if (serve) {
    server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  }

  logger.info({ port: config.port, host: config.host }, 'gemini-tunnel starting');

  // Graceful shutdown ordering matters: stop accepting new connections
  // FIRST, then let in-flight handlers drain, then close the DB. Closing
  // the DB while the HTTP server is still serving would 500 every
  // in-flight request that touches the store. The poller also stops
  // before the store close so its runOnce (which holds the DB) can't
  // race the shutdown.
  const shutdown = (): void => {
    poller.stop();
    if (server) {
      server.close((err) => {
        if (err) logger.warn({ err: err.message }, 'http server close error');
        store.close();
      });
    } else {
      store.close();
    }
    logger.info('gemini-tunnel shutting down');
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
  process.exit(1);
});
