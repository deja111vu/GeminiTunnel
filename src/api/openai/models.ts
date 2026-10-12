import type { Hono } from 'hono';

// Hardcoded model list for Phase 7. Phase 9 quota poller can replace this
// with a dynamic list sourced from the active accounts' available models.
// `created` is a fixed build timestamp so OpenAI clients that key their
// model cache on (id, created) don't see "always stale" entries.
//
// Note: gemini-2.5-* models are deprecated for new users as of Oct 2026
// (Google returns 404 "no longer available" for them). The current
// generation is gemini-3.* — see /v1beta/models for the canonical list.
const BUILD_EPOCH = Math.floor(Date.now() / 1000);
const MODELS = [
  { id: 'gemini-3.8-flash', object: 'model', created: BUILD_EPOCH, owned_by: 'google' },
  { id: 'gemini-3.1-pro-preview', object: 'model', created: BUILD_EPOCH, owned_by: 'google' },
];

export function handleListModels({ app }: { app: Hono }): void {
  app.get('/v1/models', (c) =>
    c.json({ object: 'list', data: MODELS }),
  );
}
