import { Hono } from 'hono';
import { logger } from './logger.js';
import { config } from './config.js';
import { timingSafeEqual } from 'node:crypto';

// 4 MiB. The OpenAI-compatible chat body caps (1 MiB content, 256
// messages, 64 tools) easily fit; anything above 4 MiB is either
// abuse or a bug in the client. Reject at the edge so c.req.json()
// never allocates the whole body in V8.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const BEARER_RE = /^Bearer\s+(.+)$/;

// CLIENT_API_KEY (optional): if set, gates /v1/chat/* and /v1/models
// on a bearer token that matches byte-for-byte. If unset, the proxy
// relies on external auth (Cloudflare Access, firewall, mTLS) —
// the documented deployment posture.
function requireClientKey(expected: string | undefined): import('hono').MiddlewareHandler {
  if (!expected) {
    return async (_c, next) => {
      await next();
    };
  }
  const expectedBuf = Buffer.from(expected, 'utf8');
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = BEARER_RE.exec(header);
    if (!match) {
      c.header('WWW-Authenticate', 'Bearer realm="gemini-tunnel"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const provided = Buffer.from(match[1], 'utf8');
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
    return;
  };
}

export function createApp(): Hono {
  const app = new Hono();

  // Edge body cap. Run BEFORE the route handlers so c.req.json() in
  // /v1/chat/completions never sees a 200MB payload. We only trust
  // Content-Length when it's a valid number — chunked transfer
  // encoding is rejected too, so an attacker can't hide a giant
  // body behind missing length.
  app.use('/v1/*', async (c, next) => {
    const cl = c.req.header('content-length');
    if (cl !== undefined) {
      const n = Number(cl);
      if (!Number.isFinite(n) || n < 0) {
        return c.json({ error: 'bad_content_length' }, 400);
      }
      if (n > MAX_BODY_BYTES) {
        return c.json({ error: 'body_too_large', limit: MAX_BODY_BYTES }, 413);
      }
    } else {
      // Reject missing Content-Length on POST. /v1/chat/completions
      // must always send one. Avoids streamed giant bodies slipping
      // through the cap.
      if (c.req.method === 'POST') {
        return c.json({ error: 'content_length_required' }, 411);
      }
    }
    await next();
  });

  // Optional client auth on the OpenAI surface. The middleware is a
  // no-op when CLIENT_API_KEY is not configured.
  const clientAuth = requireClientKey(config.clientApiKey);
  app.use('/v1/*', clientAuth);

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    // Log the route template (e.g. /v1/chat/completions) not the
    // rendered path, so a client probing /v1/chat/completions?token=...
    // does not leave the token in pino output.
    logger.info(
      {
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      'request',
    );
  });

  app.get('/health', (c) => c.json({ status: 'ok', service: 'gemini-tunnel' }));

  return app;
}
