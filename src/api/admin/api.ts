import type { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';
import { buildAuthorizationUrl } from '../../oauth/flow.js';
import { addPending } from '../../oauth/state.js';
import { finalizeLogin } from '../../oauth/finalize.js';
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
        hasRefreshToken: store.readActiveRefreshToken(a.id) !== null,
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
      const token = await refresher.getAccessToken(id);
      const acc = store.getAccount(id);
      return c.json({ ok: true, tokenExpiresAt: acc?.tokenExpiresAt ?? null, tokenPreview: token.slice(0, 8) + '…' });
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, 'admin: refresh failed');
      return c.json({ error: 'refresh_failed', message: (err as Error).message }, 502);
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
    addPending({ state, verifier, accountLabel });
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
      const msg = (err as Error).message;
      const status = /unknown/i.test(msg) ? 400 : 502;
      return c.json({ error: 'exchange_failed', message: msg }, status);
    }
  });
}

const UI_CANDIDATES = [
  () => path.join(process.cwd(), 'src', 'api', 'admin', 'ui.html'),
  () => path.join(process.cwd(), 'dist', 'api', 'admin', 'ui.html'),
];

// Serves the static admin SPA. The file is read at boot (single-file
// vanilla HTML — no asset pipeline). `app.get('/admin')` is the public
// entry; the SPA's JS reads the bearer token from localStorage and adds
// the Authorization header to every /admin/api/* call.
export function serveAdminUi(app: Hono): void {
  const htmlPath = UI_CANDIDATES.map((p) => p()).find((p) => existsSync(p));
  if (!htmlPath) {
    logger.warn('admin UI not found (looked in src/api/admin and dist/api/admin)');
    return;
  }
  const html = readFileSync(htmlPath, 'utf8');
  app.get('/admin', (c) => c.html(html));
  app.get('/admin/', (c) => c.html(html));
}
