import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex chars (32 bytes)');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ADMIN_TOKEN: hex32,
  ACCOUNTS_ENCRYPTION_KEY: hex32,
  GOOGLE_OAUTH_CLIENT_ID: z
    .string()
    .default('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  DATA_DIR: z.string().default('./data'),
  UPSTREAM_BASE_URL: z.string().url().default('https://cloudcode-pa.googleapis.com'),
  QUOTA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  COOLDOWN_AFTER_429_MS: z.coerce.number().int().positive().default(60 * 1000),
  SWITCH_BUDGET: z.coerce.number().int().positive().default(4),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  HOST: z.string().default('0.0.0.0'),
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
  });
}

export const config: Config = loadConfig();
