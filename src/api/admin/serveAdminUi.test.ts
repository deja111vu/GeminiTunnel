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
});

