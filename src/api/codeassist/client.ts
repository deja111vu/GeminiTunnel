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

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.upstreamBaseUrl).replace(/\/$/, '');
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

  async loadCodeAssist(
    metadata: { metadata: ClientMetadata },
    token: string,
  ): Promise<LoadCodeAssistResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ metadata: metadata.metadata }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    return (await res.json()) as LoadCodeAssistResponse;
  }

  async onboardUser(req: OnboardUserRequest, token: string): Promise<LongRunningOperation> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1internal:onboardUser`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    return (await res.json()) as LongRunningOperation;
  }

  async getOperation(name: string, token: string): Promise<LongRunningOperation> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1internal:getOperation`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    return (await res.json()) as LongRunningOperation;
  }

  async retrieveUserQuota(
    req: RetrieveUserQuotaRequest,
    token: string,
  ): Promise<RetrieveUserQuotaResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toHttpError(res);
    return (await res.json()) as RetrieveUserQuotaResponse;
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
      const decoder = new TextDecoder();
      let buf = '';

      // Parse and yield events from `buf`. Splits on `\n\n` boundaries and
      // yields each `data:` payload as a parsed JSON object. Returns true if
      // a `[DONE]` sentinel was seen (caller stops).
      const parseBuffer = (): { events: GenerateContentResponse[]; sawDone: boolean } => {
        const events: GenerateContentResponse[] = [];
        let sawDone = false;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split('\n')) {
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
          const { events, sawDone } = parseBuffer();
          for (const ev of events) yield ev;
          if (sawDone) return;
        }
        if (done) {
          // Flush any remaining buffered data after the stream closes.
          const { events } = parseBuffer();
          for (const ev of events) yield ev;
          return;
        }
      }
    })();
  }
}

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

async function toHttpError(res: Response): Promise<HttpError> {
  const body = await res.text().catch(() => '');
  return new HttpError(res.status, body);
}
