// keyChat.ts — handler for POST /v1/chat/completions when the request is
// authenticated via a Google API key (parallel to the OAuth path in
// src/api/openai/chat.ts). Uses F6 first-chunk pre-pull: we fetch the first
// SSE event before returning the Response, so a 429/401/403 from the
// upstream doesn't ship a 200 with a trailing error chunk. Switches between
// keys on retryable errors (429, 401, 403, 404, 5xx) up to `switchBudget`.

import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { HttpError } from '../codeassist/client.js';
import { KeyClient } from './keyClient.js';
import type { KeyPool } from './keyPool.js';
import type { Config } from '../../config.js';

const MAX_MESSAGES = 256;
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_TOOLS = 64;

const ChatBody = z.object({
  model: z.string().min(1).max(128),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string().max(MAX_CONTENT_CHARS), z.null()]).transform((v) => v ?? ''),
        name: z.string().max(128).optional(),
        tool_call_id: z.string().max(128).optional(),
      }),
    )
    .max(MAX_MESSAGES),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string().max(128),
          description: z.string().max(MAX_CONTENT_CHARS).optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .max(MAX_TOOLS)
    .optional(),
});

export interface KeyChatDeps {
  pool: KeyPool;
  client: KeyClient;
  config: Pick<Config, 'switchBudget' | 'requestTimeoutMs' | 'keyBadTtlMs'>;
}

function classifyKeyError(err: HttpError, key: string, model: string, pool: KeyPool): 'retry' | 'fatal' {
  if (err.status === 429) {
    pool.recordRateLimit(key, model);
    return 'retry';
  }
  if (err.status === 401 || err.status === 403) {
    pool.markBad(key);
    return 'retry';
  }
  if (err.status >= 500 || err.status === 404) return 'retry';
  return 'fatal';
}

function retryAfterSeconds(ms: number | null, fallbackMs: number): number {
  const v = ms && ms > 0 ? ms : fallbackMs;
  return Math.max(1, Math.ceil(v / 1000));
}

// Upstream-misconfigured (e.g. content-type mismatch) is a server-side
// problem, not a key failure. Don't punish the pool.
function firstFailedNonHttpError(err: unknown): boolean {
  return err instanceof Error && /upstream_misconfigured/.test(err.message);
}

// Pure handler. Used by both handleApiKeyChat (route registration) and
// keyOrOAuth middleware (direct invocation — avoids Request body double-read).
export async function runKeyChat(c: Context, { pool, client, config }: KeyChatDeps): Promise<Response> {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
  }
  const body = parsed.data;
  const model = body.model;

  let lastFatalStatus: number | null = null;
  for (let attempt = 0; attempt < config.switchBudget; attempt++) {
    let picked: { key: string };
    try {
      picked = pool.pick(model);
    } catch {
      // NoKeyAvailableError: pool knows whether it's all_bad or all_cooldown.
      // For Retry-After, prefer the actual time-to-expiry of whichever
      // class is blocking; fall back to the configured TTL only when the
      // pool has no signal (empty pool / unknown).
      const badMs = pool.minBadExpiry();
      const coolMs = pool.minCooldownExpiry(model);
      const retryMs = badMs ?? coolMs;
      return c.json(
        { error: 'all_keys_unavailable' },
        {
          status: 503,
          headers: { 'Retry-After': String(retryAfterSeconds(retryMs, config.keyBadTtlMs)) },
        },
      );
    }

    try {
      if (body.stream) {
        // F6: pre-pull first chunk so a 429 before any data doesn't ship 200.
        const stream = client.streamChat({ ...body, stream: true }, picked.key, c.req.raw.signal);
        const it = stream[Symbol.asyncIterator]();
        let first: IteratorResult<Uint8Array>;
        try {
          first = await it.next();
        } catch (err) {
          if (err instanceof HttpError) {
            const action = classifyKeyError(err, picked.key, model, pool);
            if (action === 'fatal') { lastFatalStatus = err.status; break; }
            continue;
          }
          // Non-HttpError (e.g. content-type mismatch → "upstream_misconfigured")
          // is the upstream's fault, not a key failure: don't poison the pool,
          // and surface a 502 (upstream gave us something we can't use).
          if (firstFailedNonHttpError(err)) {
            lastFatalStatus = 502;
            break;
          }
          logger.warn({ err: (err as Error).message, keySuffix: picked.key.slice(-4) }, 'stream first-chunk error');
          continue;
        }
        if (first.done) {
          lastFatalStatus = 502;
          break;
        }
        const sse = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(first.value);
            let upstreamErr: HttpError | null = null;
            try {
              while (true) {
                if (c.req.raw.signal.aborted) break;
                const next = await it.next();
                if (next.done) break;
                controller.enqueue(next.value);
              }
            } catch (err) {
              if (err instanceof HttpError) upstreamErr = err;
              logger.warn(
                { err: (err as Error).message, keySuffix: picked.key.slice(-4) },
                'stream interrupted',
              );
            } finally {
              if (upstreamErr) {
                classifyKeyError(upstreamErr, picked.key, model, pool);
              }
              controller.close();
            }
          },
          async cancel() {
            // AsyncGenerator.return() is async; await it so the upstream
            // socket is released before cancel() resolves.
            await it.return?.();
          },
        });
        return new Response(sse, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }
      // Non-stream.
      const json = (await client.getJson({ ...body, stream: false }, picked.key, c.req.raw.signal)) as Record<string, unknown>;
      pool.clearCooldown(picked.key, model);
      return c.json(json, 200);
    } catch (err) {
      if (err instanceof HttpError) {
        const action = classifyKeyError(err, picked.key, model, pool);
        if (action === 'fatal') { lastFatalStatus = err.status; break; }
        continue;
      }
      // Non-HttpError = network failure (ECONNREFUSED, DNS, abort, etc.).
      // Try the next key. The budget-exhausted fallback below maps this
      // to 502.
      logger.warn(
        { err: (err as Error).message, keySuffix: picked.key.slice(-4) },
        'upstream call failed without status',
      );
      continue;
    }
  }
  // Budget exhausted. lastFatalStatus can be 4xx or 5xx; pass through.
  // null = network/connection failure across all keys → 502 Bad Gateway.
  const status: number = lastFatalStatus ?? 502;
  return c.json(
    { error: 'upstream_exhausted', retriable: lastFatalStatus == null },
    { status: status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 },
  );
}

export interface KeyChatRouteDeps extends KeyChatDeps {
  app: Hono;
  postRoute: string;
}

export function handleApiKeyChat({ app, postRoute, ...deps }: KeyChatRouteDeps): void {
  app.post(postRoute, (c) => runKeyChat(c, deps));
}
