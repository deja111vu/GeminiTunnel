import { Hono } from 'hono';
import { logger } from './logger.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      'request',
    );
  });

  app.get('/health', (c) => c.json({ status: 'ok', service: 'gemini-tunnel' }));

  return app;
}
