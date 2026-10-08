import { describe, it, expect } from 'vitest';
import { toCodeAssistRequest, fromCodeAssistChunk } from './converter.js';
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

describe('fromCodeAssistChunk', () => {
  it('maps a text delta to delta.content', () => {
    const out: ChatCompletionChunk = fromCodeAssistChunk(chunk([{ text: 'hi' }]), 'gemini-2.5-pro');
    expect(out.object).toBe('chat.completion.chunk');
    expect(out.model).toBe('gemini-2.5-pro');
    expect(out.choices[0]?.delta.content).toBe('hi');
    expect(out.choices[0]?.delta.role).toBe('assistant');
  });

  it('maps functionCall to delta.tool_calls', () => {
    const out = fromCodeAssistChunk(
      chunk([{ functionCall: { name: 'search', args: { q: 'cats' } } }]),
      'm',
    );
    const tc = out.choices[0]?.delta.tool_calls?.[0];
    expect(tc?.type).toBe('function');
    expect(tc?.function?.name).toBe('search');
    expect(tc?.function?.arguments).toBe('{"q":"cats"}');
  });

  it('translates finishReason STOP to "stop"', () => {
    const out = fromCodeAssistChunk(chunk([], 'STOP'), 'm');
    expect(out.choices[0]?.finish_reason).toBe('stop');
  });

  it('translates finishReason MAX_TOKENS to "length"', () => {
    const out = fromCodeAssistChunk(chunk([], 'MAX_TOKENS'), 'm');
    expect(out.choices[0]?.finish_reason).toBe('length');
  });

  it('translates finishReason SAFETY/RECITATION to "content_filter"', () => {
    expect(fromCodeAssistChunk(chunk([], 'SAFETY'), 'm').choices[0]?.finish_reason).toBe(
      'content_filter',
    );
    expect(fromCodeAssistChunk(chunk([], 'RECITATION'), 'm').choices[0]?.finish_reason).toBe(
      'content_filter',
    );
  });

  it('leaves finish_reason undefined when not present', () => {
    const out = fromCodeAssistChunk(chunk([{ text: 'x' }]), 'm');
    expect(out.choices[0]?.finish_reason).toBeUndefined();
  });

  it('emits an id of the form chatcmpl-<timestamp>', () => {
    const out = fromCodeAssistChunk(chunk([{ text: 'x' }]), 'm');
    expect(out.id).toMatch(/^chatcmpl-\d+$/);
  });

  it('returns an empty delta when no content and no finishReason', () => {
    const out = fromCodeAssistChunk(chunk([]), 'm');
    expect(out.choices[0]?.delta).toEqual({ role: 'assistant' });
  });
});
