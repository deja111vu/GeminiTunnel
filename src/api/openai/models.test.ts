import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { handleListModels } from './models.js';

describe('handleListModels', () => {
  it('returns the current Gemini model ids', async () => {
    const app = new Hono();
    handleListModels({ app });
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    // gemini-2.5-* was deprecated for new users in Oct 2026 (Google now
    // returns 404 "no longer available"). The current generation is
    // gemini-3.* — pin the two model ids the proxy actually advertises.
    expect(ids).toContain('gemini-3.8-flash');
    expect(ids).toContain('gemini-3.1-pro-preview');
  });
});
