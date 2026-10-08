import { describe, it, expect } from 'vitest';
import { createApp } from './server.js';

describe('server', () => {
  it('GET /health returns ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('gemini-tunnel');
  });
});
