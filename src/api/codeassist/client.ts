import { config } from '../../config.js';
import type {
  ClientMetadata,
  LoadCodeAssistResponse,
  OnboardUserRequest,
  LongRunningOperation,
  RetrieveUserQuotaRequest,
  RetrieveUserQuotaResponse,
  GenerateContentRequest,
  GenerateContentResponse,
} from './types.js';

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CodeAssistClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  // Cap the SSE parse buffer to bound memory from a misbehaving upstream.
  // 1 MiB is far above the largest legitimate event in streamGenerateContent.
  private static readonly MAX_BUF = 1 << 20;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.upstreamBaseUrl).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? config.requestTimeoutMs;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'gemini-tunnel/2.0',
    };
  }

  // ponytail: 4 unary methods share fetch+timeout+ok-check+parse — keep them
  // inlined so each one names its request type, but route through this helper
  // so headers, timeout, and error shape stay consistent.
  private async request<T>(method: string, token: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1internal:${method}`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    return (await res.json()) as T;
  }

  loadCodeAssist(
    metadata: { metadata: ClientMetadata },
    token: string,
  ): Promise<LoadCodeAssistResponse> {
    return this.request<LoadCodeAssistResponse>('loadCodeAssist', token, metadata);
  }

  onboardUser(req: OnboardUserRequest, token: string): Promise<LongRunningOperation> {
    return this.request<LongRunningOperation>('onboardUser', token, req);
  }

  getOperation(name: string, token: string): Promise<LongRunningOperation> {
    return this.request<LongRunningOperation>('getOperation', token, { name });
  }

  retrieveUserQuota(
    req: RetrieveUserQuotaRequest,
    token: string,
  ): Promise<RetrieveUserQuotaResponse> {
    return this.request<RetrieveUserQuotaResponse>('retrieveUserQuota', token, req);
  }

  streamGenerateContent(
    req: GenerateContentRequest,
    token: string,
    signal?: AbortSignal,
  ): AsyncIterable<GenerateContentResponse> {
    const fetchImpl = this.fetchImpl;
    const baseUrl = this.baseUrl;
    const timeoutMs = this.timeoutMs;
    const headers = this.headers(token);

    return (async function* () {
      const res = await fetchImpl(`${baseUrl}/v1internal:streamGenerateContent`, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw await toHttpError(res);
      if (!res.body) throw new Error('no response body');
      const reader = res.body.getReader();
      // Release the upstream socket/stream if the consumer breaks out of the
      // for-await loop (request abort, 4xx/5xx mid-stream, OpenAI adapter cut).
      try {
        const decoder = new TextDecoder();
        let buf = '';

        // Parse events from `buf`. Splits on blank-line boundaries
        // (`\r\n\r\n` or `\n\n`) and yields each `data:` payload as JSON.
        // Returns true if `[DONE]` was seen (caller stops).
        const parseBuffer = (): { events: GenerateContentResponse[]; sawDone: boolean } => {
          const events: GenerateContentResponse[] = [];
          let sawDone = false;
          let idx: number;
          while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
            const event = buf.slice(0, idx);
            // Skip the matched separator (2 or 4 chars).
            const sepLen = /\r\n\r\n/.test(buf.slice(idx, idx + 4)) ? 4 : 2;
            buf = buf.slice(idx + sepLen);
            for (const line of event.split(/\r?\n/)) {
              const m = /^data:\s?(.*)$/.exec(line);
              if (!m) continue;
              const payload = m[1];
              if (payload === '[DONE]') {
                sawDone = true;
                continue;
              }
              try {
                events.push(JSON.parse(payload) as GenerateContentResponse);
              } catch {
                // ignore malformed SSE line
              }
            }
          }
          return { events, sawDone };
        };

        while (true) {
          const { value, done } = await reader.read();
          if (value) {
            buf += decoder.decode(value, { stream: true });
            if (buf.length > CodeAssistClient.MAX_BUF) {
              throw new Error(`SSE buffer exceeded ${CodeAssistClient.MAX_BUF} bytes`);
            }
            const { events, sawDone } = parseBuffer();
            for (const ev of events) yield ev;
            if (sawDone) return;
          }
          if (done) {
            const { events } = parseBuffer();
            for (const ev of events) yield ev;
            return;
          }
        }
      } finally {
        // No-op if already released; cheap if not. Cancels the in-flight
        // reader and the underlying fetch socket on early consumer return.
        await reader.cancel().catch(() => {});
      }
    })();
  }
}

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

// Cap the response body we read into the error so a misbehaving upstream
// can't pin memory in our error path. 64 KiB is enough for any sensible
// upstream error message; the rest is truncated with an indicator.
const MAX_ERROR_BODY = 64 * 1024;

async function toHttpError(res: Response): Promise<HttpError> {
  const body = await readBodyCapped(res, MAX_ERROR_BODY);
  return new HttpError(res.status, body);
}

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
