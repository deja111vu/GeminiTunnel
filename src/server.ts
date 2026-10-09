import { Hono } from 'hono';
import { logger } from './logger.js';
import { config } from './config.js';
import { timingSafeEqual } from 'node:crypto';
import { KEY_RE } from './api/gemini/keyConfig.js';
import { keyOrOAuth } from './api/gemini/middleware.js';
import type { KeyClient } from './api/gemini/keyClient.js';
import type { KeyPool } from './api/gemini/keyPool.js';
import type { AccountPool } from './accounts/pool.js';
import type { Store } from './accounts/store.js';
import type { Config } from './config.js';

// 4 MiB. The OpenAI-compatible chat body caps (1 MiB content, 256
// messages, 64 tools) easily fit; anything above 4 MiB is either
// abuse or a bug in the client. Reject at the edge so c.req.json()
// never allocates the whole body in V8.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const BEARER_RE = /^Bearer\s+(.+)$/;

// Edge guard against API keys in the query string. Mounted on /v1/*
// unconditionally — NOT gated on keyPool/keyClient presence — so the
// rejection fires even in OAuth-only deployments. A `?key=AIza…` in a
// request URL is logged by every reverse proxy, CDN, and browser in
// the path; the proxy must 400 it before any of those see the response
// path. By design, only well-formed AIza values are rejected; a
// truncated or random `?key=foo` falls through (the regex is public,
// and shorter prefixes carry no information).
function rejectKeyInQuery() {
  return async (c: import('hono').Context, next: import('hono').Next): Promise<Response | void> => {
    const url = new URL(c.req.url);
    const queryKey = url.searchParams.get('key');
    if (queryKey !== null && KEY_RE.test(queryKey)) {
      return c.json({ error: 'key_in_query_string_forbidden' }, 400);
    }
    return next();
  };
}

// Reusable body-cap middleware. Mounted on /v1/* (auth-required) and
// /admin/api/* (login is unauthenticated, so it MUST also be capped).
// We only trust Content-Length when it's a valid number; chunked
// transfer encoding is rejected on POST so an attacker can't hide a
// giant body behind missing length.
function bodyCap(c: import('hono').Context, next: import('hono').Next): Promise<Response> | Promise<void> {
  const cl = c.req.header('content-length');
  if (cl !== undefined) {
    const n = Number(cl);
    if (!Number.isFinite(n) || n < 0) {
      return Promise.resolve(c.json({ error: 'bad_content_length' }, 400));
    }
    if (n > MAX_BODY_BYTES) {
      return Promise.resolve(c.json({ error: 'body_too_large', limit: MAX_BODY_BYTES }, 413));
    }
  } else if (c.req.method === 'POST') {
    return Promise.resolve(c.json({ error: 'content_length_required' }, 411));
  }
  return next();
}

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

export interface CreateAppDeps {
  // The OAuth deps remain optional so existing callers (and tests) that
  // pass nothing continue to work — the proxy can run with neither
  // path enabled (admin-only / health-only mode).
  pool?: AccountPool;
  store?: Store;
  // The API-key path. When `keyPool` is provided, the middleware is
  // registered and `/health` exposes the keyPool summary. When both
  // are present, the keyOrOAuth dispatcher sits between clientAuth
  // and the OAuth handler.
  keyPool?: KeyPool;
  keyClient?: KeyClient;
  // Optional override for the config (used by tests); defaults to the
  // module-level singleton.
  config?: Config;
}

export function createApp(deps: CreateAppDeps = {}): Hono {
  const app = new Hono();
  const cfg = deps.config ?? config;

  // Edge body cap. Run BEFORE the route handlers so c.req.json() in
  // any POST handler never sees a 200MB payload. /admin/api/login is
  // intentionally unauthenticated (bootstrap), so it MUST also be
  // protected by this cap — without it an attacker can OOM the process
  // with a single huge POST to the login endpoint.
  app.use('/v1/*', bodyCap);
  app.use('/admin/api/*', bodyCap);

  // Optional client auth on the OpenAI surface. The middleware is a
  // no-op when CLIENT_API_KEY is not configured.
  const clientAuth = requireClientKey(cfg.clientApiKey);
  app.use('/v1/*', clientAuth);

  // Reject `?key=AIza...` in the query string unconditionally — even
  // when the key path is disabled. The dispatcher below does the same
  // for the routes it owns; this guard exists so OAuth-only deployments
  // (no keyPool/keyClient wired) still get the 400, and so the
  // rejection runs before any handler that might log the raw URL.
  app.use('/v1/*', rejectKeyInQuery());

  // API-key path dispatcher. Always register when keyPool+keyClient are
  // present, regardless of `keyPathEnabled`, so `?key=AIza...` and
  // malformed headers are rejected with 400 instead of falling through.
  if (deps.keyPool && deps.keyClient) {
    app.use(
      '/v1/chat/completions',
      keyOrOAuth({
        enabled: cfg.keyPathEnabled,
        pool: deps.keyPool,
        client: deps.keyClient,
        config: cfg,
      }),
    );
  }

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

  // /health is intentionally minimal: only `status` and `service`. The
  // previous `upstreams.{oauth,apiKey}` blocks disclosed pool sizes and
  // per-pool cooldown/bad counts to any unauthenticated caller that
  // could reach the endpoint — a reconnaissance oracle for the AIza
  // key path. Detailed pool state is now in the admin UI (which is
  // already authenticated) and is not surfaced here.
  app.get('/health', (c) => c.json({ status: 'ok', service: 'gemini-tunnel' }));

  return app;
}
