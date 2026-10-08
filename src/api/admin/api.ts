import type { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';
import { buildAuthorizationUrl } from '../../oauth/flow.js';
import { addPending } from '../../oauth/state.js';
import { finalizeLogin, FinalizeError } from '../../oauth/finalize.js';
import { requireAdmin } from './auth.js';
import type { Store } from '../../accounts/store.js';
import type { RefresherLike } from '../../accounts/pool.js';

const StartBody = z.object({ accountLabel: z.string().min(1).max(64).default('default') });
const ExchangeBody = z.object({
  state: z.string().min(1).max(128),
  code: z.string().min(1).max(4096),
});

export interface AdminApiDeps {
  app: Hono;
  store: Store;
  refresher: RefresherLike;
  encryptionKey: string;
  adminToken: string;
}

export function handleAdminApi({
  app,
  store,
  refresher,
  encryptionKey,
  adminToken,
}: AdminApiDeps): void {
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
      await refresher.getAccessToken(id);
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
  app.get('/admin', (c) => c.html(html));
  app.get('/admin/', (c) => c.html(html));
}
