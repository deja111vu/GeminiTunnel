import { describe, it, expect, vi } from 'vitest';
import { CodeAssistClient } from './client.js';

describe('CodeAssistClient.streamGenerateContent', () => {
  it('yields parsed SSE chunks', async () => {
    const sseBody = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hi"}]},"index":0}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":" there"}]},"index":0,"finishReason":"STOP"}]}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = async () =>
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    const c = new CodeAssistClient({
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const chunks: unknown[] = [];
    for await (const ch of c.streamGenerateContent({ model: 'gemini-2.5-pro', request: { contents: [] } }, 'tok')) {
      chunks.push(ch);
    }
    expect(chunks.length).toBe(2);
  });

  it('handles CRLF-separated SSE events from real servers', async () => {
    const sseBody =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hi"}]},"index":0}]}}\r\n\r\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":" there"}]},"index":0,"finishReason":"STOP"}]}}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';
    const fetchMock = async () =>
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    const c = new CodeAssistClient({
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const chunks: { text?: string }[] = [];
    for await (const ch of c.streamGenerateContent(
      { model: 'm', request: { contents: [] } },
      'tok',
    )) {
      chunks.push(ch.response?.candidates?.[0]?.content?.parts?.[0] as { text?: string });
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.text).toBe('Hi');
    expect(chunks[1]?.text).toBe(' there');
  });

  it('releases upstream reader when consumer breaks early', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"response":{"candidates":[]}}\r\n\r\n'),
        );
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const fetchMock = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    const c = new CodeAssistClient({
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    for await (const _ch of c.streamGenerateContent(
      { model: 'm', request: { contents: [] } },
      'tok',
    )) {
      break; // consumer bails after first chunk
    }
    // Give the async cancellation a tick to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelCalled).toBe(true);
  });

  it('throws HttpError on non-2xx for unary methods', async () => {
    const fetchMock = async () =>
      new Response('nope', { status: 401, headers: { 'Content-Type': 'text/plain' } });
    const c = new CodeAssistClient({
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      c.loadCodeAssist({ metadata: { ideType: 'IDE', platform: 'PLAT', pluginType: 'PLUGIN' } }, 'tok'),
    ).rejects.toMatchObject({ status: 401, body: 'nope' });
  });

  it('uses Authorization Bearer token in headers', async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const c = new CodeAssistClient({
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await c.loadCodeAssist({ metadata: { ideType: 'IDE', platform: 'PLAT', pluginType: 'PLUGIN' } }, 'my-token');
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-token');
    expect(calledUrl).toBe('https://example.test/v1internal:loadCodeAssist');
  });
});
