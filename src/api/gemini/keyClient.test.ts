import { describe, it, expect } from 'vitest';
import { KeyClient } from './keyClient.js';
import { HttpError } from '../codeassist/client.js';

const KEY = 'AIzaSyA' + 'a'.repeat(36);

function makeFetch(responses: Array<{ status: number; body: string; contentType?: string }>): typeof fetch {
  let i = 0;
  return async () => {
    if (i >= responses.length) throw new Error('out of mocked responses');
    const r = responses[i++];
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  };
}

describe('KeyClient', () => {
  it('getJson returns parsed JSON on 200', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 200, body: '{"id":"x"}' }]),
    });
    const result = await client.getJson({ model: 'gemini-2.5-pro', messages: [] }, KEY);
    expect(result).toEqual({ id: 'x' });
  });

  it('getJson with empty body throws (caller must handle JSON parse error)', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 200, body: '' }]),
    });
    await expect(client.getJson({}, KEY)).rejects.toThrow();
  });

  it('getJson throws HttpError on 429', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 429, body: '{"error":"rate limited"}' }]),
    });
    await expect(client.getJson({ model: 'gemini-2.5-pro', messages: [] }, KEY)).rejects.toBeInstanceOf(HttpError);
  });

  it('getJson throws HttpError(401) on 401', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 401, body: 'unauthorized' }]),
    });
    try {
      await client.getJson({ model: 'gemini-2.5-pro', messages: [] }, KEY);
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
    }
  });

  it('error body is capped at 64 KiB', async () => {
    const big = 'x'.repeat(200_000);
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 500, body: big }]),
    });
    try {
      await client.getJson({}, KEY);
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).body.length).toBeLessThanOrEqual(64 * 1024 + 20);
    }
  });

  it('streamChat sends x-goog-api-key header', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (_url, init) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = h;
      return new Response('data: {"x":1}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: fakeFetch,
    });
    const it = client.streamChat({ model: 'gemini-2.5-pro', messages: [], stream: true }, KEY);
    for await (const _chunk of it) break;
    expect(capturedHeaders['x-goog-api-key']).toBe(KEY);
  });

  it('streamChat yields SSE chunks verbatim', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 200, body: 'data: {"x":1}\n\ndata: {"x":2}\n\n', contentType: 'text/event-stream' }]),
    });
    const out: string[] = [];
    for await (const chunk of client.streamChat({ model: 'gemini-2.5-pro', messages: [], stream: true }, KEY)) {
      out.push(new TextDecoder().decode(chunk));
    }
    expect(out.join('')).toContain('data: {"x":1}');
    expect(out.join('')).toContain('data: {"x":2}');
  });

  it('streamChat with non-UTF-8 bytes in body does not throw (graceful skip)', async () => {
    // 0xC3 0x28 is an invalid UTF-8 sequence; TextDecoder (fatal:false default)
    // replaces with U+FFFD, so passthrough is safe.
    const bytes = new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3A, 0x20, 0xC3, 0x28, 0x0A, 0x0A]); // "data: " + invalid + "\n\n"
    const fakeFetch: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: fakeFetch,
    });
    const out: string[] = [];
    for await (const chunk of client.streamChat({ model: 'gemini-2.5-pro', messages: [], stream: true }, KEY)) {
      out.push(new TextDecoder().decode(chunk));
    }
    expect(out.join('')).toContain('data: ');
  });

  it('streamChat throws HttpError on 429', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 429, body: 'rate limited' }]),
    });
    await expect((async () => { for await (const _ of client.streamChat({ model: 'gemini-2.5-pro', messages: [], stream: true }, KEY)) {} })()).rejects.toBeInstanceOf(HttpError);
  });

  it('streamChat throws when Content-Type is application/json (stream:true)', async () => {
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: makeFetch([{ status: 200, body: '{}', contentType: 'application/json' }]),
    });
    await expect((async () => {
      for await (const _ of client.streamChat({ model: 'gemini-2.5-pro', messages: [], stream: true }, KEY)) {}
    })()).rejects.toThrow(/stream|json/i);
  });

  it('uses POST to /v1beta/openai/chat/completions', async () => {
    let capturedUrl = '';
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response('{}', { status: 200 });
    };
    const client = new KeyClient({
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: fakeFetch,
    });
    await client.getJson({ model: 'gemini-2.5-pro', messages: [] }, KEY);
    expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });
});
