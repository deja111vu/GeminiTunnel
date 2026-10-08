import { describe, it, expect } from 'vitest';
import { toCodeAssistRequest, fromCodeAssistChunk, fromCodeAssistStream } from './converter.js';
import type { ChatCompletionRequest, ChatCompletionChunk } from './types.js';
import type { GenerateContentResponse, Candidate, ContentPart } from '../codeassist/types.js';

describe('toCodeAssistRequest', () => {
  it('places model as models/<name> and carries project', () => {
    const req: ChatCompletionRequest = {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = toCodeAssistRequest(req, 'proj-123');
    expect(out.model).toBe('models/gemini-2.5-pro');
    expect(out.project).toBe('proj-123');
    expect(out.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('lifts system messages to systemInstruction and preserves order of the rest', () => {
    const req: ChatCompletionRequest = {
      model: 'm',
      messages: [
        { role: 'system', content: 'you are a tutor' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    };
    const out = toCodeAssistRequest(req);
    expect(out.request.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'you are a tutor' }],
    });
    expect(out.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'q1' }] },
      { role: 'assistant', parts: [{ text: 'a1' }] },
      { role: 'user', parts: [{ text: 'q2' }] },
    ]);
  });

  it('concatenates multiple system messages into a single systemInstruction', () => {
    const req: ChatCompletionRequest = {
      model: 'm',
      messages: [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second' },
        { role: 'user', content: 'q' },
      ],
    };
    const out = toCodeAssistRequest(req);
    expect(out.request.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'first\n\nsecond' }],
    });
    expect(out.request.contents).toEqual([{ role: 'user', parts: [{ text: 'q' }] }]);
  });

  it('maps tools to functionDeclarations', () => {
    const req: ChatCompletionRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'web search',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ],
    };
    const out = toCodeAssistRequest(req);
    expect(out.request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'search',
            description: 'web search',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('passes through generationConfig (temperature, topP, maxOutputTokens)', () => {
    const req: ChatCompletionRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 256,
    };
    const out = toCodeAssistRequest(req);
    expect(out.request.generationConfig).toEqual({
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 256,
    });
  });

  it('emits empty contents when no messages', () => {
    const out = toCodeAssistRequest({ model: 'm', messages: [] });
    expect(out.request.contents).toEqual([]);
  });
});

function chunk(
  parts: ContentPart[] | undefined,
  finishReason?: string,
): GenerateContentResponse {
  const candidate: Candidate = {};
  if (parts) candidate.content = { role: 'model', parts };
  if (finishReason) candidate.finishReason = finishReason;
  return { response: { candidates: [candidate] } };
}

const META_FIRST = { id: 'chatcmpl-test', created: 1_700_000_000, isFirst: true };
const META_NEXT = { id: 'chatcmpl-test', created: 1_700_000_000, isFirst: false };

describe('fromCodeAssistChunk', () => {
  it('maps a text delta to delta.content and sets role only on first chunk', () => {
    const first: ChatCompletionChunk = fromCodeAssistChunk(
      chunk([{ text: 'hi' }]),
      'gemini-2.5-pro',
      META_FIRST,
    );
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.model).toBe('gemini-2.5-pro');
    expect(first.choices[0]?.delta.content).toBe('hi');
    expect(first.choices[0]?.delta.role).toBe('assistant');

    const next = fromCodeAssistChunk(chunk([{ text: ' there' }]), 'gemini-2.5-pro', META_NEXT);
    expect(next.choices[0]?.delta.role).toBeUndefined();
    expect(next.choices[0]?.delta.content).toBe(' there');
  });

  it('uses the same (id, created) across all chunks of a stream', () => {
    const a = fromCodeAssistChunk(chunk([{ text: 'a' }]), 'm', META_FIRST);
    const b = fromCodeAssistChunk(chunk([{ text: 'b' }]), 'm', META_NEXT);
    expect(a.id).toBe(b.id);
    expect(a.created).toBe(b.created);
  });

  it('maps functionCall to delta.tool_calls', () => {
    const out = fromCodeAssistChunk(
      chunk([{ functionCall: { name: 'search', args: { q: 'cats' } } }]),
      'm',
      META_FIRST,
    );
    const tc = out.choices[0]?.delta.tool_calls?.[0];
    expect(tc?.type).toBe('function');
    expect(tc?.function?.name).toBe('search');
    expect(tc?.function?.arguments).toBe('{"q":"cats"}');
  });

  it('translates finishReason STOP to "stop"', () => {
    const out = fromCodeAssistChunk(chunk([], 'STOP'), 'm', META_FIRST);
    expect(out.choices[0]?.finish_reason).toBe('stop');
  });

  it('translates finishReason MAX_TOKENS to "length"', () => {
    const out = fromCodeAssistChunk(chunk([], 'MAX_TOKENS'), 'm', META_FIRST);
    expect(out.choices[0]?.finish_reason).toBe('length');
  });

  it('translates finishReason SAFETY/RECITATION to "content_filter"', () => {
    expect(fromCodeAssistChunk(chunk([], 'SAFETY'), 'm', META_FIRST).choices[0]?.finish_reason).toBe(
      'content_filter',
    );
    expect(
      fromCodeAssistChunk(chunk([], 'RECITATION'), 'm', META_FIRST).choices[0]?.finish_reason,
    ).toBe('content_filter');
  });

  it('leaves finish_reason undefined when not present', () => {
    const out = fromCodeAssistChunk(chunk([{ text: 'x' }]), 'm', META_FIRST);
    expect(out.choices[0]?.finish_reason).toBeUndefined();
  });

  it('returns an empty delta when no content and no finishReason', () => {
    const first = fromCodeAssistChunk(chunk([]), 'm', META_FIRST);
    expect(first.choices[0]?.delta).toEqual({ role: 'assistant' });
    const next = fromCodeAssistChunk(chunk([]), 'm', META_NEXT);
    expect(next.choices[0]?.delta).toEqual({});
  });
});

describe('fromCodeAssistStream', () => {
  function asyncIterFrom<T>(arr: T[]): AsyncIterable<T> {
    return (async function* () {
      for (const x of arr) yield x;
    })();
  }

  it('aggregates text into the message and includes usage when present', async () => {
    const chunks = [
      chunk([{ text: 'hel' }]),
      chunk([{ text: 'lo' }], 'STOP'),
    ];
    // Attach usage to the second chunk (cumulative).
    (chunks[1]!.response as { usageMetadata?: unknown }).usageMetadata = {
      promptTokenCount: 11,
      candidatesTokenCount: 22,
      totalTokenCount: 33,
    };
    const out = await fromCodeAssistStream(
      asyncIterFrom(chunks),
      'gemini-2.5-pro',
      'chatcmpl-x',
      1700000000,
    );
    expect(out.choices[0]?.message.content).toBe('hello');
    expect(out.choices[0]?.finish_reason).toBe('stop');
    expect(out.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 22,
      total_tokens: 33,
    });
  });

  it('omits usage when upstream does not send it', async () => {
    const out = await fromCodeAssistStream(
      asyncIterFrom([chunk([{ text: 'x' }], 'STOP')]),
      'm',
      'id',
      1,
    );
    expect(out.usage).toBeUndefined();
  });
});
