import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { handleListModels } from './models.js';

describe('handleListModels', () => {
  it('returns the three Gemini 2.5 model ids', async () => {
    const app = new Hono();
    handleListModels({ app });
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain('gemini-2.5-pro');
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).toContain('gemini-2.5-flash-lite');
  });
});
