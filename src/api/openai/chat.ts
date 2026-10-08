import type { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { CodeAssistClient, HttpError } from '../codeassist/client.js';
import type { GenerateContentRequest } from '../codeassist/types.js';
import { toCodeAssistRequest, fromCodeAssistChunk, fromCodeAssistStream } from './converter.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from './types.js';
import type { AccountPool } from '../../accounts/pool.js';
import type { Store } from '../../accounts/store.js';
import type { Config } from '../../config.js';

const ChatBody = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.union([z.string(), z.null()]).transform((v) => v ?? ''),
      name: z.string().optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  })).optional(),
}) as z.ZodType<ChatCompletionRequest>;

export interface ChatHandlerDeps {
  app: Hono;
  pool: AccountPool;
  client: CodeAssistClient;
  store: Store;
  config: Pick<Config, 'switchBudget' | 'cooldownAfter429Ms'>;
}

// Handle a 4xx/5xx upstream response by mapping the status to the right
// AccountPool action. Returns true if the caller should retry with the
// next account (5xx or transient); false if the error is terminal.
function handleUpstreamError(
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
  if (err.status >= 500) {
    // Don't poison the account on transient upstream errors; just try the next.
    return 'retry';
  }
  return 'fatal';
}

// Stream upstream chunks through to the client, translating each one. The
// `signal` is wired to the AbortSignal of the inbound Hono request, so a
// client disconnect also cancels the upstream fetch.
async function* streamWithCancel<T>(
  it: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  for await (const item of it) {
    if (signal.aborted) return;
    yield item;
  }
}

function chunkToSse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function handleChatCompletion({
  app,
  pool,
  client,
  store,
  config,
}: ChatHandlerDeps): void {
  app.post('/v1/chat/completions', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ChatBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const model = body.model;

    // Project lookup is best-effort; Code Assist runs without one too.
    // The project comes from loadCodeAssist() and is cached separately;
    // for Phase 7 we leave it unset.
    const project: string | undefined = undefined;
    void store; // store is wired for future use (quota attribution, etc.)

    const caReq: GenerateContentRequest = toCodeAssistRequest(body, project);

    // Try up to switchBudget accounts. Each attempt is independent: if one
    // 429s/401s/403s/5xxs we record it and pick the next. The first account
    // whose stream begins successfully is the one we keep streaming from.
    let lastFatal: { status: number; body: string } | null = null;
    for (let attempt = 0; attempt < config.switchBudget; attempt++) {
      let picked: Awaited<ReturnType<AccountPool['pick']>>;
      try {
        picked = await pool.pick();
      } catch (err) {
        // No eligible account at all.
        logger.warn({ err: (err as Error).message }, 'pool pick failed');
        return c.json({ error: 'no_account_available' }, 503);
      }

      try {
        const upstream = client.streamGenerateContent(caReq, picked.token, c.req.raw.signal);
        if (body.stream) {
          const sse = new ReadableStream<Uint8Array>({
            async start(controller) {
              const enc = new TextEncoder();
              try {
                for await (const chunk of streamWithCancel(upstream, c.req.raw.signal)) {
                  const oa = fromCodeAssistChunk(chunk, model);
                  controller.enqueue(enc.encode(chunkToSse(oa)));
                }
                controller.enqueue(enc.encode('data: [DONE]\n\n'));
              } catch (err) {
                logger.warn(
                  { err: (err as Error).message, account: picked.email },
                  'stream interrupted',
                );
              } finally {
                controller.close();
              }
            },
          });
          return new Response(sse, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'x-gemini-tunnel-account': picked.email,
            },
          });
        }
        // stream=false: drain to JSON.
        const response: ChatCompletionResponse = await fromCodeAssistStream(upstream, model);
        return c.json(response, 200, { 'x-gemini-tunnel-account': picked.email });
      } catch (err) {
        if (err instanceof HttpError) {
          const action = handleUpstreamError(err, picked.accountId, model, pool);
          if (action === 'fatal') {
            lastFatal = { status: err.status, body: err.body };
            break;
          }
          // 4xx mapped action + 5xx: try the next account.
          continue;
        }
        // Network / abort / unknown: don't poison the account; try next.
        logger.warn(
          { err: (err as Error).message, account: picked.email },
          'upstream call failed without status',
        );
        continue;
      }
    }
    return c.json(
      { error: 'upstream_exhausted', last: lastFatal },
      (lastFatal ? lastFatal.status : 500) as 500,
    );
  });
}
