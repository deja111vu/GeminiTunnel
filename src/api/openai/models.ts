import type { Hono } from 'hono';

// Hardcoded model list for Phase 7. Phase 9 quota poller can replace this
// with a dynamic list sourced from the active accounts' available models.
// `created` is a fixed build timestamp so OpenAI clients that key their
// model cache on (id, created) don't see "always stale" entries.
const BUILD_EPOCH = Math.floor(Date.now() / 1000);
const MODELS = [
  { id: 'gemini-2.5-pro', object: 'model', created: BUILD_EPOCH, owned_by: 'google' },
  { id: 'gemini-2.5-flash', object: 'model', created: BUILD_EPOCH, owned_by: 'google' },
  { id: 'gemini-2.5-flash-lite', object: 'model', created: BUILD_EPOCH, owned_by: 'google' },
];

export function handleListModels({ app }: { app: Hono }): void {
  app.get('/v1/models', (c) =>
    c.json({ object: 'list', data: MODELS }),
  );
}
