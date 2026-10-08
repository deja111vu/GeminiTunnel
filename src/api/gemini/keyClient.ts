// keyClient.ts — fetch wrapper for the Gemini Developer API (OpenAI-compat
// endpoint at /v1beta/openai/chat/completions). Auth uses
// `Authorization: Bearer <key>` per the official OpenAI-compat docs
// (https://ai.google.dev/gemini-api/docs/openai). `x-goog-api-key` is the
// header for the *native* Gemini API, not the OpenAI-compat layer.
// Reuses HttpError from codeassist/client.ts; the body-cap helper is a small
// local copy because exporting it from codeassist/client.ts would widen the
// module's public surface for a single consumer.

import { HttpError } from '../codeassist/client.js';

const ENDPOINT = '/v1beta/openai/chat/completions';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY = 64 * 1024;

async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        out += decoder.decode(value, { stream: true });
        if (out.length > cap) {
          await reader.cancel().catch(() => {});
          return out.slice(0, cap) + '…truncated';
        }
      }
      if (done) {
        out += decoder.decode(undefined, { stream: false });
        return out;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface KeyClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class KeyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: KeyClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(key: string): Record<string, string> {
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'gemini-tunnel/2.0',
    };
  }

  async getJson(body: unknown, key: string, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: this.headers(key),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    return await res.json();
  }

  async *streamChat(
    body: unknown,
    key: string,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: this.headers(key),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    if (!res.body) throw new Error('no response body');
    // If client asked for stream but upstream returned JSON, treat as misconfig.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/event-stream')) {
      const text = await readBodyCapped(res, 64 * 1024);
      throw new Error(`upstream_misconfigured: expected text/event-stream, got ${ct}: ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) yield value;
        if (done) return;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

async function toHttpError(res: Response): Promise<HttpError> {
  const body = await readBodyCapped(res, 64 * 1024);
  return new HttpError(res.status, body);
}
