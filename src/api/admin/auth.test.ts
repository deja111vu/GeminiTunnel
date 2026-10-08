import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requireAdmin } from './auth.js';

const TOKEN = 'a'.repeat(64);

describe('requireAdmin', () => {
  let app: Hono;
  beforeEach(() => {
    app = new Hono();
    app.use('/admin/*', requireAdmin(TOKEN));
    app.get('/admin/ping', (c) => c.json({ ok: true }));
  });

  it('returns 401 with WWW-Authenticate when Authorization header is missing', async () => {
    const res = await app.request('/admin/ping');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('returns 401 when header is not a Bearer scheme', async () => {
    const res = await app.request('/admin/ping', { headers: { authorization: 'Basic xyz' } });
    expect(res.status).toBe(401);
  });

  it('returns 403 when token is wrong (does not leak whether the scheme parsed)', async () => {
    const res = await app.request('/admin/ping', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 when Bearer token matches', async () => {
    const res = await app.request('/admin/ping', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 403 when Bearer token differs by a single character (timing-safe compare)', async () => {
    const res = await app.request('/admin/ping', {
      headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}b` },
    });
    expect(res.status).toBe(403);
  });
});
