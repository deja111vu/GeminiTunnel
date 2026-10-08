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
import { KeyClient, UpstreamMisconfiguredError } from './keyClient.js';
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
  // 5xx is transient infra (Google side). 404 is fatal: model unknown to
  // Google's backend, switching keys won't change the answer.
  if (err.status >= 500) return 'retry';
  return 'fatal';
}

function retryAfterSeconds(ms: number | null, fallbackMs: number): number {
  const v = ms && ms > 0 ? ms : fallbackMs;
  return Math.max(1, Math.ceil(v / 1000));
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
      // class is blocking. Fall back to 60s — not keyBadTtlMs (24h) — when
      // the pool has no signal; an empty pool is not a 24h outage.
      const badMs = pool.minBadExpiry();
      const coolMs = pool.minCooldownExpiry(model);
      const retryMs = badMs ?? coolMs;
      return c.json(
        { error: 'all_keys_unavailable' },
        {
          status: 503,
          headers: { 'Retry-After': String(retryAfterSeconds(retryMs, 60_000)) },
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
          if (err instanceof UpstreamMisconfiguredError) {
            // Upstream gave us something we can't use; not a key failure.
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
        // First chunk delivered = key is healthy for this model.
        pool.clearCooldown(picked.key, model);
        // Abort plumbing: if the client aborts, Hono doesn't auto-cancel
        // the response body. We listen on the request signal and trigger
        // an explicit return on the upstream generator, which propagates
        // to keyClient.streamChat's finally → reader.cancel() → socket
        // release. Without this, the upstream holds open until timeout.
        const onAbort = () => { void it.return?.(); };
        if (c.req.raw.signal.aborted) onAbort();
        else c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
        const sse = new ReadableStream<Uint8Array>({
          async start(controller) {
            const safeEnqueue = (chunk: Uint8Array): boolean => {
              try {
                controller.enqueue(chunk);
                return true;
              } catch {
                // Controller closed (consumer cancelled mid-flight). Stop pumping.
                return false;
              }
            };
            if (!safeEnqueue(first.value)) return;
            let upstreamErr: HttpError | null = null;
            try {
              while (true) {
                if (c.req.raw.signal.aborted) break;
                const next = await it.next();
                if (next.done) break;
                if (!safeEnqueue(next.value)) break;
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
              try { controller.close(); } catch { /* already closed */ }
            }
          },
          async cancel() {
            c.req.raw.signal.removeEventListener('abort', onAbort);
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
  // Budget exhausted. lastFatalStatus can be any 4xx/5xx; pass through.
  // null = network/connection failure across all keys → 502 Bad Gateway.
  const status: number = lastFatalStatus ?? 502;
  // retriable for null (network) and 5xx; client should retry; 4xx fatal
  // means the request shape is wrong, retrying with the same body won't help.
  const retriable = lastFatalStatus == null || (lastFatalStatus >= 500 && lastFatalStatus < 600);
  return c.json({ error: 'upstream_exhausted', retriable }, status);
}

export interface KeyChatRouteDeps extends KeyChatDeps {
  app: Hono;
  postRoute: string;
}

export function handleApiKeyChat({ app, postRoute, ...deps }: KeyChatRouteDeps): void {
  app.post(postRoute, (c) => runKeyChat(c, deps));
}
