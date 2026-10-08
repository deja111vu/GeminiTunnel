import type { Hono } from 'hono';

// Hardcoded model list for Phase 7. Phase 9 quota poller can replace this
// with a dynamic list sourced from the active accounts' available models.
const MODELS = [
  { id: 'gemini-2.5-pro', object: 'model', created: 0, owned_by: 'google' },
  { id: 'gemini-2.5-flash', object: 'model', created: 0, owned_by: 'google' },
  { id: 'gemini-2.5-flash-lite', object: 'model', created: 0, owned_by: 'google' },
];

export function handleListModels({ app }: { app: Hono }): void {
  app.get('/v1/models', (c) =>
    c.json({ object: 'list', data: MODELS }),
  );
}
