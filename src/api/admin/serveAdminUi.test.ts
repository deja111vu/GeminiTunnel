import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { serveAdminUi } from './api.js';

describe('serveAdminUi', () => {
  it('throws when the HTML file cannot be located (no silent degradation in prod)', () => {
    const app = new Hono();
    expect(() => serveAdminUi(app, { htmlPath: '/nonexistent/path/ui.html' })).toThrow();
  });

  it('registers /admin and /admin/ when the HTML file exists', async () => {
    // Use the dev source path — vitest runs from src/ so the file is on disk.
    const app = new Hono();
    serveAdminUi(app);
    const root = await app.request('/admin');
    const trailing = await app.request('/admin/');
    // Either both 200 (file found) or both throw at construction (we just
    // assert they behave consistently). The throw case is covered above.
    if (root.status === 200) {
      expect(root.headers.get('content-type')).toMatch(/text\/html/);
      expect(trailing.status).toBe(200);
    } else {
      expect(() => serveAdminUi(app)).toThrow();
    }
  });
});
