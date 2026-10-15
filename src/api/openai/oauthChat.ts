// oauthChat.ts — extracted from handleChatCompletion in chat.ts.
//
// Takes a pre-fetched OAuth token (UnifiedPool already awaits
// AccountPool.pick()'s token refresh) and runs the upstream request
// loop. Same switchBudget semantics as runKeyChat. Streaming
// behavior is unchanged.

import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { CodeAssistClient, HttpError } from '../codeassist/client.js';
import type { GenerateContentRequest, GenerateContentResponse } from '../codeassist/types.js';
import {
  toCodeAssistRequest,
  fromCodeAssistChunk,
  fromCodeAssistStream,
  type ChunkMeta,
} from './converter.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from './types.js';
import type { Account } from '../../accounts/store.js';
import type { Store } from '../../accounts/store.js';
import type { Config } from '../../config.js';
import type { AccountPool } from '../../accounts/pool.js';

// Same body-shape caps as chat.ts (the original handler). Bound at
// the trust boundary so a single client can't pin memory in the JSON
// parser, zod validator, or Code Assist request body.
const MAX_MESSAGES = 256;
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_TOOLS = 64;

const ChatBody = z.object({
  model: z.string().min(1).max(128),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z
          .union([z.string().max(MAX_CONTENT_CHARS), z.null()])
          .transform((v) => v ?? ''),
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
          name: z.string().min(1).max(128),
          description: z.string().max(MAX_CONTENT_CHARS).optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .max(MAX_TOOLS)
    .optional(),
}) as z.ZodType<ChatCompletionRequest>;

export interface OAuthChatDeps {
  account: Account;
  token: string;
  store: Store;
  client: CodeAssistClient;
  config: Pick<Config, 'switchBudget'>;
  // The pool is required for classifyUpstreamError's record* calls,
  // but it is not consulted inside runOAuthChat itself (the
  // caller pre-picked the account).
  pool: AccountPool;
}

// Map an upstream HttpError to an AccountPool action + a retry decision.
// 429/401/403/5xx are recoverable (next upstream); other 4xx is fatal.
function classifyUpstreamError(
  err: HttpError,
  accountId: number,
  model: string,
  pool: AccountPool,
): 'retry' | 'fatal' {
  if (err.status === 429) {
    pool.recordRateLimit(accountId, model);
    return 'retry';
  }
  if (err.status === 401) {
    pool.recordInvalid(accountId, `401: ${err.body.slice(0, 120)}`);
    return 'retry';
  }
  if (err.status === 403) {
    pool.recordIneligible(accountId, `403: ${err.body.slice(0, 120)}`);
    return 'retry';
  }
  if (err.status >= 500) return 'retry';
  return 'fatal';
}

function chunkToSse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export async function runOAuthChat(
  c: Context,
  { account, token, store, client, config, pool }: OAuthChatDeps,
): Promise<Response> {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
  }
  const body = parsed.data;
  const model = body.model;

  const project: string | undefined = undefined;
  void store;

  const caReq: GenerateContentRequest = toCodeAssistRequest(body, project);

  const chunkId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const meta: ChunkMeta = { id: chunkId, created, isFirst: true };

  let lastFatalStatus: number | null = null;
  for (let attempt = 0; attempt < config.switchBudget; attempt++) {
    try {
      const upstream = client.streamGenerateContent(caReq, token, c.req.raw.signal);
      if (body.stream) {
        const it = upstream[Symbol.asyncIterator]();
        let first: IteratorResult<GenerateContentResponse>;
        try {
          first = await it.next();
        } catch (err) {
          if (err instanceof HttpError) {
            const action = classifyUpstreamError(err, account.id, model, pool);
            if (action === 'fatal') {
              lastFatalStatus = err.status;
              break;
            }
            continue;
          }
          logger.warn(
            { err: (err as Error).message, account: account.email },
            'stream first-chunk error',
          );
          continue;
        }
        if (first.done) {
          lastFatalStatus = 502;
          break;
        }
        const firstMeta: ChunkMeta = { id: chunkId, created, isFirst: true };
        const head = chunkToSse(fromCodeAssistChunk(first.value, model, firstMeta));
        const sse = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(head));
            let upstreamErr: HttpError | null = null;
            try {
              while (true) {
                if (c.req.raw.signal.aborted) break;
                const next = await it.next();
                if (next.done) break;
                const m: ChunkMeta = { id: chunkId, created, isFirst: false };
                controller.enqueue(enc.encode(chunkToSse(fromCodeAssistChunk(next.value, model, m))));
              }
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
            } catch (err) {
              if (err instanceof HttpError) upstreamErr = err;
              logger.warn(
                { err: (err as Error).message, account: account.email },
                'stream interrupted',
              );
            } finally {
              if (upstreamErr) {
                classifyUpstreamError(upstreamErr, account.id, model, pool);
                controller.enqueue(
                  enc.encode(
                    chunkToSse({
                      id: chunkId,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [],
                      error: { code: upstreamErr.status, message: 'upstream_error' },
                    }),
                  ),
                );
              }
              controller.close();
            }
          },
          cancel() {
            it.return?.();
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
      const response: ChatCompletionResponse = await fromCodeAssistStream(
        upstream,
        model,
        chunkId,
        created,
      );
      return c.json(response, 200);
    } catch (err) {
      if (err instanceof HttpError) {
        const action = classifyUpstreamError(err, account.id, model, pool);
        if (action === 'fatal') {
          lastFatalStatus = err.status;
          break;
        }
        continue;
      }
      logger.warn(
        { err: (err as Error).message, account: account.email },
        'upstream call failed without status',
      );
      continue;
    }
  }
  return c.json(
    { error: 'upstream_exhausted', retriable: lastFatalStatus == null },
    { status: (lastFatalStatus ?? 500) as 400 | 401 | 403 | 404 | 500 },
  );
}
