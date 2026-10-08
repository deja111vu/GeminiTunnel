import type { ContentPart, GenerateContentRequest, GenerateContentResponse } from '../codeassist/types.js';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatMessage,
  ToolCall,
} from './types.js';

// Maps Code Assist finishReason values to the OpenAI finish_reason enum.
const FINISH_REASON_MAP: Record<string, 'stop' | 'length' | 'content_filter'> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  // Anything else falls through to undefined; OpenAI only knows the three
  // above plus 'tool_calls', which we emit when a functionCall is present.
};

// Per-stream metadata threaded through every chunk so the (id, created) pair
// is stable across the whole stream. OpenAI SDKs correlate deltas off these
// and treat differing values as separate streams.
export interface ChunkMeta {
  id: string;
  created: number;
  // The role is emitted only on the first chunk per OpenAI's streaming spec.
  isFirst: boolean;
}

export function toCodeAssistRequest(
  req: ChatCompletionRequest,
  projectId?: string,
): GenerateContentRequest {
  const systemParts: string[] = [];
  const contents: { role: string; parts: ContentPart[] }[] = [];

  for (const m of req.messages ?? []) {
    const text = m.content ?? '';
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    contents.push({ role: m.role, parts: [{ text }] });
  }

  const request: GenerateContentRequest['request'] = { contents };
  if (systemParts.length > 0) {
    request.systemInstruction = { role: 'system', parts: [{ text: systemParts.join('\n\n') }] };
  }
  if (req.tools && req.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
  }
  const genConfig: Record<string, unknown> = {};
  if (typeof req.temperature === 'number') genConfig.temperature = req.temperature;
  if (typeof req.top_p === 'number') genConfig.topP = req.top_p;
  if (typeof req.max_tokens === 'number') genConfig.maxOutputTokens = req.max_tokens;
  if (Object.keys(genConfig).length > 0) request.generationConfig = genConfig;

  const out: GenerateContentRequest = { model: `models/${req.model}`, request };
  if (projectId) out.project = projectId;
  return out;
}

function getCandidate(ca: GenerateContentResponse) {
  return ca.response?.candidates?.[0];
}

function partText(part: ContentPart | undefined): string | undefined {
  return typeof part?.text === 'string' ? part.text : undefined;
}

function partFunctionCall(part: ContentPart | undefined): { name?: string; args?: unknown } | undefined {
  const fc = part?.functionCall as { name?: unknown; args?: unknown } | undefined;
  if (!fc) return undefined;
  return { name: typeof fc.name === 'string' ? fc.name : undefined, args: fc.args };
}

export function fromCodeAssistChunk(
  ca: GenerateContentResponse,
  openaiModel: string,
  meta: ChunkMeta,
): ChatCompletionChunk {
  const candidate = getCandidate(ca);
  const parts = candidate?.content?.parts ?? [];

  const delta: ChatCompletionChunk['choices'][number]['delta'] = {};
  if (meta.isFirst) delta.role = 'assistant';
  const text = parts.map(partText).filter((t): t is string => Boolean(t)).join('');
  if (text) delta.content = text;

  const toolCalls: ToolCall[] = [];
  parts.forEach((p, idx) => {
    const fc = partFunctionCall(p);
    if (!fc) return;
    toolCalls.push({
      index: idx,
      type: 'function',
      function: {
        name: fc.name,
        arguments: fc.args === undefined ? undefined : JSON.stringify(fc.args),
      },
    });
  });
  if (toolCalls.length > 0) delta.tool_calls = toolCalls;

  const finishRaw = candidate?.finishReason;
  const finishReason =
    finishRaw == null
      ? undefined
      : FINISH_REASON_MAP[finishRaw] ??
        (toolCalls.length > 0 ? 'tool_calls' : undefined);

  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: openaiModel,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  };
}

function getUsage(ca: GenerateContentResponse): ChatCompletionUsage | undefined {
  const u = (ca.response as { usageMetadata?: unknown } | undefined)?.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined;
  if (!u) return undefined;
  const prompt = u.promptTokenCount ?? 0;
  const completion = u.candidatesTokenCount ?? 0;
  const total = u.totalTokenCount ?? prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

// Collects all chunks into a single non-streaming response. Used for the
// stream=false branch of /v1/chat/completions.
export function fromCodeAssistStream(
  chunks: AsyncIterable<GenerateContentResponse>,
  openaiModel: string,
  chunkId?: string,
  created?: number,
): Promise<ChatCompletionResponse> {
  return (async () => {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let lastFinish: string | undefined;
    let usage: ChatCompletionUsage | undefined;
    for await (const ch of chunks) {
      const cand = getCandidate(ch);
      for (const p of cand?.content?.parts ?? []) {
        const t = partText(p);
        if (t) content += t;
        const fc = partFunctionCall(p);
        if (fc) {
          toolCalls.push({
            index: toolCalls.length,
            type: 'function',
            function: {
              name: fc.name,
              arguments: fc.args === undefined ? undefined : JSON.stringify(fc.args),
            },
          });
        }
      }
      const fr = cand?.finishReason;
      if (fr) lastFinish = fr;
      // Take the last non-empty usage so we get the final cumulative count.
      const u = getUsage(ch);
      if (u) usage = u;
    }
    const finishReason =
      lastFinish == null
        ? null
        : FINISH_REASON_MAP[lastFinish] ??
          (toolCalls.length > 0 ? 'tool_calls' : null);

    return {
      id: chunkId ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: created ?? Math.floor(Date.now() / 1000),
      model: openaiModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    };
  })();
}
