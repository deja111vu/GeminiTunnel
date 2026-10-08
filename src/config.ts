import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex chars (32 bytes)');

// UPSTREAM_BASE_URL must be https. Localhost http is allowed for tests
// (the API code in src/api/codeassist/client.ts also accepts http for
// the test fixtures on 127.0.0.1/::1). Plain http to any other host is
// rejected because every upstream secret in flight (Bearer access_token)
// would traverse the wire unencrypted. Embedded credentials
// (https://user:pass@host/) are also rejected — they would silently
// ship the operator's secrets to whatever host is in the URL.
const urlSchema = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        const parsed = new URL(u);
        if (parsed.username || parsed.password) return false;
        if (parsed.protocol === 'https:') return true;
        // Allow http only to loopback — used by integration tests.
        return (
          parsed.protocol === 'http:' &&
          (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost')
        );
      } catch {
        return false;
      }
    },
    { message: 'must be https (or http to loopback only), no embedded credentials' },
  );

// GOOGLE_OAUTH_CLIENT_SECRET: real Google secrets start with "GOCSPX-"
// and are ~35 chars. Reject placeholders and obvious garbage so a fresh
// .env from the example file can't boot into a half-working state.
const oauthSecret = z
  .string()
  .min(20, 'must be at least 20 chars (real GOCSPX- secrets are ~35)')
  .refine((s) => !/^(your_|<.+>).*$/i.test(s), 'placeholder value not allowed; paste the real secret');

// CLIENT_API_KEY: optional. When set, /v1/chat/* and /v1/models require
// Authorization: Bearer <key> to match. When unset, the proxy relies on
// external auth (Cloudflare Access, firewall, mTLS) — that's the
// default for the published VPS-deploy use case.
const clientKey = z
  .string()
  .min(16, 'CLIENT_API_KEY must be at least 16 chars when set')
  .optional();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ADMIN_TOKEN: hex32,
  ACCOUNTS_ENCRYPTION_KEY: hex32,
  GOOGLE_OAUTH_CLIENT_ID: z
    .string()
    .default('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'),
  GOOGLE_OAUTH_CLIENT_SECRET: oauthSecret,
  DATA_DIR: z.string().default('./data'),
  UPSTREAM_BASE_URL: urlSchema.default('https://cloudcode-pa.googleapis.com'),
  QUOTA_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5 * 60 * 1000),
  COOLDOWN_AFTER_429_MS: z.coerce.number().int().positive().default(60 * 1000),
  SWITCH_BUDGET: z.coerce.number().int().positive().default(4),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  HOST: z.string().default('0.0.0.0'),
  CLIENT_API_KEY: clientKey,
});

export type Config = Readonly<{
  port: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  adminToken: string;
  accountsEncryptionKey: string;
  googleOauthClientId: string;
  googleOauthClientSecret: string;
  dataDir: string;
  upstreamBaseUrl: string;
  quotaPollIntervalMs: number;
  cooldownAfter429Ms: number;
  switchBudget: number;
  requestTimeoutMs: number;
  host: string;
  clientApiKey: string | undefined;
}>;

function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Config validation failed: ${errors}`);
  }
  const {
    PORT,
    LOG_LEVEL,
    ADMIN_TOKEN,
    ACCOUNTS_ENCRYPTION_KEY,
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    DATA_DIR,
    UPSTREAM_BASE_URL,
    QUOTA_POLL_INTERVAL_MS,
    COOLDOWN_AFTER_429_MS,
    SWITCH_BUDGET,
    REQUEST_TIMEOUT_MS,
    HOST,
    CLIENT_API_KEY,
  } = parsed.data;
  return Object.freeze({
    port: PORT,
    logLevel: LOG_LEVEL,
    adminToken: ADMIN_TOKEN,
    accountsEncryptionKey: ACCOUNTS_ENCRYPTION_KEY,
    googleOauthClientId: GOOGLE_OAUTH_CLIENT_ID,
    googleOauthClientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    dataDir: DATA_DIR,
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    quotaPollIntervalMs: QUOTA_POLL_INTERVAL_MS,
    cooldownAfter429Ms: COOLDOWN_AFTER_429_MS,
    switchBudget: SWITCH_BUDGET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    host: HOST,
    clientApiKey: CLIENT_API_KEY,
  });
}

export const config: Config = loadConfig();
