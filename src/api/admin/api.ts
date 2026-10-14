import type { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';
import { buildAuthorizationUrl } from '../../oauth/flow.js';
import { addPending } from '../../oauth/state.js';
import { finalizeLogin, FinalizeError } from '../../oauth/finalize.js';
import { requireAdmin, setAdminCookie, clearAdminCookie } from './auth.js';
import { ApiKeyConflictError, type Store } from '../../accounts/store.js';
import type { RefresherLike } from '../../accounts/pool.js';
import { KEY_RE } from '../gemini/keyConfig.js';
import type { KeyPool } from '../gemini/keyPool.js';
import { getProxyTokenStore, type ProxyTokenStore } from './proxyTokenStore.js';

const StartBody = z.object({ accountLabel: z.string().min(1).max(64).default('default') });
const ExchangeBody = z.object({
  state: z.string().min(1).max(128),
  code: z.string().min(1).max(4096),
});
const LoginBody = z.object({ token: z.string().min(1).max(256) });
const KeyBody = z.object({
  label: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  key: z.string().regex(KEY_RE),
});
const KeyPatchBody = z.object({ enabled: z.boolean() });
// Proxy access token: same URL-safe alphabet as RFC 6750 Bearer (no
// whitespace, no controls, no chars that would break `Authorization`
// header parsing). Min 16 mirrors F1 in config.ts; max 256 leaves room
// for a generated 64-hex token + 4× margin. Server-side generate
// always emits 64 hex chars and satisfies this constraint.
const ProxyTokenBody = z.object({
  key: z
    .string()
    .min(16, 'must be at least 16 chars')
    .max(256, 'must be at most 256 chars')
    .regex(/^[A-Za-z0-9._~+\-/=]+$/, 'must be URL-safe'),
});

function parseRowId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export interface AdminApiDeps {
  app: Hono;
  store: Store;
  refresher: RefresherLike;
  encryptionKey: string;
  adminToken: string;
  keyPool: KeyPool;
  // In-memory mirror of the proxy access token. Optional for test
  // ergonomics (callers can pass `getProxyTokenStore()` explicitly or
  // rely on the default below). The default is the same module
  // singleton that `createApp` reads, so production wiring always
  // has PUT/generate/DELETE write to the same mirror the /v1/*
  // middleware reads on every request. Wiring at boot lives in
  // `src/index.ts` (Step 8.6).
  proxyTokenStore?: ProxyTokenStore;
}

export function handleAdminApi({
  app,
  store,
  refresher,
  encryptionKey,
  adminToken,
  keyPool,
  proxyTokenStore = getProxyTokenStore(),
}: AdminApiDeps): void {
  // Login + logout are NOT under requireAdmin — they're how the user
  // gets a session in the first place. We register them before the
  // `/admin/api/*` guard so the guard doesn't 401 its own bootstrap.
  app.post('/admin/api/login', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = LoginBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (!setAdminCookie(c, adminToken, parsed.data.token)) {
      // Don't differentiate "bad token" from "missing token" at the
      // status level — both are 401. The body just says unauthorized
      // either way, no oracle.
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ ok: true });
  });

  app.post('/admin/api/logout', (c) => {
    clearAdminCookie(c);
    return c.body(null, 204);
  });

  app.use('/admin/api/*', requireAdmin(adminToken));

  // List accounts. Never returns raw tokens — only the metadata + a boolean
  // for "has a refresh token" so the UI can show a useful row without us
  // shipping the secret through every admin page load.
  app.get('/admin/api/accounts', (c) => {
    const accounts = store.listAccounts().map((a) => {
      const { id, email, status, tierId, tierName, cooldownUntil, lastUsedAt, onboardedAt, tokenExpiresAt } = a;
      return {
        id,
        email,
        status,
        tierId,
        tierName,
        cooldownUntil,
        lastUsedAt,
        onboardedAt,
        tokenExpiresAt,
        hasRefreshToken: store.hasRefreshToken(a.id),
        enabled: a.enabled,
      };
    });
    return c.json(accounts);
  });

  app.delete('/admin/api/accounts/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    const acc = store.getAccount(id);
    if (!acc) return c.json({ error: 'not_found' }, 404);
    store.removeAccount(id);
    return c.body(null, 204);
  });

  app.post('/admin/api/accounts/:id/refresh', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    try {
      // forceRefresh, not getAccessToken: the admin "refresh" button must
      // always hit Google (operators click it to recover from a stale
      // cached token), matching what `tunnel refresh` does in the CLI.
      await refresher.forceRefresh(id);
      const acc = store.getAccount(id);
      logger.debug({ id }, 'admin: refresh ok');
      return c.json({ ok: true, tokenExpiresAt: acc?.tokenExpiresAt ?? null });
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, 'admin: refresh failed');
      return c.json({ error: 'refresh_failed' }, 502);
    }
  });

  app.get('/admin/api/accounts/:id/quota', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    const snapshots = store.listLatestQuotaSnapshots(id);
    const events = store.listRecentQuotaEvents(id, Date.now() - 7 * 24 * 60 * 60 * 1000);
    return c.json({ snapshots, events });
  });

  app.post('/admin/api/oauth/start', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = StartBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { url, state, verifier, accountLabel } = buildAuthorizationUrl({
      accountLabel: parsed.data.accountLabel,
    });
    try {
      addPending({ state, verifier, accountLabel });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'admin: oauth/start refused (pending cap)');
      return c.json({ error: 'too_many_in_flight' }, 503);
    }
    return c.json({ url, state });
  });

  app.post('/admin/api/oauth/exchange', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ExchangeBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const acc = await finalizeLogin({
        state: parsed.data.state,
        code: parsed.data.code,
        store,
        encryptionKey,
      });
      return c.json({ id: acc.id, email: acc.email });
    } catch (err) {
      // Log the upstream error server-side; never echo it (could include
      // user-controlled state or upstream Google error text). Map typed
      // errors to status codes without surfacing the raw message.
      // Untyped exceptions are treated as server bugs (500), not as
      // upstream failures (502), so monitoring pages don't chase Google
      // for local regressions like DB corruption or cipher failures.
      if (err instanceof FinalizeError) {
        const status = err.kind === 'unknown_state' ? 400 : 502;
        logger.warn({ kind: err.kind, err: err.message }, 'admin: oauth/exchange failed');
        return c.json({ error: 'exchange_failed' }, status);
      }
      logger.error({ err: (err as Error).message }, 'admin: oauth/exchange internal error');
      return c.json({ error: 'internal_error' }, 500);
    }
  });

  app.get('/admin/api/keys', (c) => c.json(store.listApiKeys()));

  app.post('/admin/api/keys', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = KeyBody.safeParse(raw);
    if (!parsed.success) {
      const keyIssue = parsed.error.issues.find((i) => i.path[0] === 'key');
      return c.json({ error: keyIssue ? 'invalid_key_format' : 'invalid_request' }, 400);
    }
    try {
      // DB first, pool second: a failed insert must not leave the pool
      // holding a key the DB never recorded.
      const row = store.addApiKey(parsed.data.label, parsed.data.key);
      keyPool.addKey(parsed.data.key);
      return c.json(row, 201);
    } catch (err) {
      if (err instanceof ApiKeyConflictError) {
        return c.json({ error: err.conflict }, 409);
      }
      // Never log the request body here — it contains the plaintext key.
      logger.error({ err: (err as Error).message }, 'admin: api key add failed');
      return c.json({ error: 'internal_error' }, 500);
    }
  });

  app.delete('/admin/api/keys/:id?', (c) => {
    const id = parseRowId(c.req.param('id') ?? '');
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    const row = store.getApiKeyWithSecret(id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    store.removeApiKey(id);
    keyPool.removeKey(row.key);
    return c.body(null, 204);
  });
  app.delete('/admin/api/keys/', (c) => c.json({ error: 'invalid_id' }, 400));

  app.patch('/admin/api/keys/:id?', async (c) => {
    const id = parseRowId(c.req.param('id') ?? '');
    if (id === null) return c.json({ error: 'invalid_id' }, 400);
    const raw = await c.req.json().catch(() => null);
    const parsed = KeyPatchBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const row = store.getApiKeyWithSecret(id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const updated = store.setApiKeyEnabled(id, parsed.data.enabled);
    if (parsed.data.enabled) keyPool.addKey(row.key);
    else keyPool.removeKey(row.key);
    return c.json(updated);
  });

  // GET /admin/api/proxy-token — singleton metadata only. Never
  // returns the plaintext: the admin who set it already saw it in
  // the PUT/generate response, and a future rotation is one click.
  app.get('/admin/api/proxy-token', (c) => {
    const meta = store.getClientKey();
    if (!meta) return c.json({ hasSecret: false });
    return c.json({ ...meta, hasSecret: true });
  });

  // PUT /admin/api/proxy-token — admin-pasted key. Validate the
  // format before persisting, then DB-first + mirror-second.
  app.put('/admin/api/proxy-token', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ProxyTokenBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid_key_format' }, 400);
    }
    const meta = store.setClientKey(parsed.data.key);
    proxyTokenStore.set(parsed.data.key);
    logger.info({ keyId: meta.keyId }, 'admin: proxy token set');
    return c.json({ ...meta, hasSecret: true });
  });

  // POST /admin/api/proxy-token/generate — server-side generation.
  // Always emits 64 hex chars (32 bytes from randomBytes), which
  // trivially satisfies ProxyTokenBody. The plaintext is returned
  // exactly once: after this call the admin must copy it (or rotate).
  app.post('/admin/api/proxy-token/generate', (c) => {
    const key = randomBytes(32).toString('hex');
    const meta = store.setClientKey(key);
    proxyTokenStore.set(key);
    logger.info({ keyId: meta.keyId }, 'admin: proxy token generated');
    return c.json({ ...meta, key, hasSecret: true });
  });

  // DELETE /admin/api/proxy-token — idempotent. 204 whether or not
  // a row existed; admin-UI doesn't need to distinguish.
  app.delete('/admin/api/proxy-token', (c) => {
    const existed = store.clearClientKey();
    proxyTokenStore.set(undefined);
    if (existed) logger.info('admin: proxy token cleared');
    return c.body(null, 204);
  });
}

export interface ServeAdminUiOptions {
  // Override the HTML file path (used by tests). In production the file is
  // expected to live next to the compiled module (dist/api/admin/ui.html,
  // copied by the postbuild script) or alongside the source under src/.
  htmlPath?: string;
}

// Serves the static admin SPA. Throws at boot if the HTML file cannot be
// located — a missing SPA is a deployment error, not a runtime condition
// to silently degrade past. The SPA's JS reads the bearer token from
// localStorage and adds the Authorization header to every /admin/api/* call.
export function serveAdminUi(app: Hono, opts: ServeAdminUiOptions = {}): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const htmlPath = opts.htmlPath ?? path.join(__dirname, 'ui.html');
  if (!existsSync(htmlPath)) {
    throw new Error(
      `admin UI not found at ${htmlPath}. ` +
        'Did you run `npm run build`? The postbuild step copies ui.html into dist/.',
    );
  }
  const html = readFileSync(htmlPath, 'utf8');
  // Defense-in-depth: the SPA is server-rendered HTML but it can still
  // be iframed, embedded, or replayed through a browser cache. These
  // headers fail closed against clickjacking, MIME sniffing, and stale
  // auth tokens sitting in shared caches. No CSP was added yet (the
  // SPA ships inline JSON state that would need a hash); tracked as
  // future work.
  const securityHeaders: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  const sendHtml = (c: import('hono').Context): Response => {
    for (const [k, v] of Object.entries(securityHeaders)) c.header(k, v);
    return c.html(html);
  };
  app.get('/admin', sendHtml);
  app.get('/admin/', sendHtml);
}
