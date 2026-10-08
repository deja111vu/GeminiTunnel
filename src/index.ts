import { createApp } from './server.js';
import { config } from './config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  // bootstrap modules here in future phases
  const app = createApp();
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
