import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { serveAdminUi } from './api.js';

describe('serveAdminUi', () => {
  it('throws when the HTML file cannot be located (no silent degradation in prod)', () => {
    const app = new Hono();
    expect(() => serveAdminUi(app, { htmlPath: '/nonexistent/path/ui.html' })).toThrow(
      /admin UI not found/,
    );
  });

  it('registers /admin and /admin/ when the HTML file exists at the dev path', async () => {
    // vitest runs from src/, so the dev source path is on disk.
    const app = new Hono();
    serveAdminUi(app);
    const root = await app.request('/admin');
    const trailing = await app.request('/admin/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toMatch(/text\/html/);
    expect(trailing.status).toBe(200);
  });

  it('serves the API Keys tab markup', async () => {
    const app = new Hono();
    serveAdminUi(app);
    const res = await app.request('/admin');
    const html = await res.text();
    expect(html).toContain('data-tab="keys"');
    expect(html).toContain('id="panel-keys"');
    expect(html).toContain('id="add-key-form"');
    expect(html).toContain('/admin/api/keys');
  });

  it('serves the Proxy Access tab markup', async () => {
    const app = new Hono();
    serveAdminUi(app);
    const res = await app.request('/admin');
    const html = await res.text();
    expect(html).toContain('data-tab="proxy"');
    expect(html).toContain('id="panel-proxy"');
    expect(html).toContain('/admin/api/proxy-token');
  });

  it('serves the accounts enabled toggle markup', async () => {
    const app = new Hono();
    serveAdminUi(app);
    const res = await app.request('/admin');
    const html = await res.text();
    expect(html).toContain('data-act="toggle-enabled"');
    expect(html).toMatch(/<th[^>]*>\s*enabled\s*<\/th>/i);
  });
});

