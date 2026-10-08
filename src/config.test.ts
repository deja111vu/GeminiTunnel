import { describe, it, expect, afterEach, vi } from 'vitest';

const REQUIRED_ENV = {
  ADMIN_TOKEN: 'a'.repeat(64),
  ACCOUNTS_ENCRYPTION_KEY: 'b'.repeat(64),
  // Real GOCSPX- secrets are ~35 chars; 25 here passes the min-20 +
  // placeholder check without using the literal "GOCSPX-" prefix (which
  // is reserved for real Google-issued values).
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-FAKE-TEST-SECRET-1234567890',
};

describe('config', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('uses defaults when no env set', async () => {
    vi.resetModules();
    delete process.env.PORT;
    delete process.env.LOG_LEVEL;
    process.env.ADMIN_TOKEN = REQUIRED_ENV.ADMIN_TOKEN;
    process.env.ACCOUNTS_ENCRYPTION_KEY = REQUIRED_ENV.ACCOUNTS_ENCRYPTION_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    const { config } = await import('./config.js');
    expect(config.port).toBe(8000);
    expect(config.logLevel).toBe('info');
  });

  it('errors on missing required ADMIN_TOKEN', async () => {
    vi.resetModules();
    process.env.ADMIN_TOKEN = '';
    process.env.ACCOUNTS_ENCRYPTION_KEY = REQUIRED_ENV.ACCOUNTS_ENCRYPTION_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    await expect(import('./config.js')).rejects.toThrow(/ADMIN_TOKEN/);
  });

  it('errors on short encryption key', async () => {
    vi.resetModules();
    process.env.ADMIN_TOKEN = REQUIRED_ENV.ADMIN_TOKEN;
    process.env.ACCOUNTS_ENCRYPTION_KEY = 'short';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    await expect(import('./config.js')).rejects.toThrow(/encryption/i);
  });

  it('rejects UPSTREAM_BASE_URL with embedded credentials', async () => {
    // F11 follow-up: a URL like https://user:pass@evil.com/ would pass
    // the https-only check but ship the operator's secrets in every
    // fetch to that host. The refinement must also reject parsed.username
    // || parsed.password.
    vi.resetModules();
    process.env.ADMIN_TOKEN = REQUIRED_ENV.ADMIN_TOKEN;
    process.env.ACCOUNTS_ENCRYPTION_KEY = REQUIRED_ENV.ACCOUNTS_ENCRYPTION_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    process.env.UPSTREAM_BASE_URL = 'https://attacker:secret@evil.com/';
    await expect(import('./config.js')).rejects.toThrow(/credential/i);
  });

  it('parses GEMINI_API_KEYS CSV into array, dedupes, drops invalid', async () => {
    vi.resetModules();
    process.env.ADMIN_TOKEN = REQUIRED_ENV.ADMIN_TOKEN;
    process.env.ACCOUNTS_ENCRYPTION_KEY = REQUIRED_ENV.ACCOUNTS_ENCRYPTION_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    const validKey = 'AIzaSyA' + 'a'.repeat(36);
    process.env.GEMINI_API_KEYS = `${validKey},${validKey},invalid,short`;
    const { config } = await import('./config.js');
    expect(config.geminiApiKeys).toEqual([validKey]);
    expect(config.keyPathEnabled).toBe(true);
  });

  it('keyPathEnabled=false when GEMINI_API_KEYS empty/unset', async () => {
    vi.resetModules();
    process.env.ADMIN_TOKEN = REQUIRED_ENV.ADMIN_TOKEN;
    process.env.ACCOUNTS_ENCRYPTION_KEY = REQUIRED_ENV.ACCOUNTS_ENCRYPTION_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GEMINI_API_KEYS;
    const { config } = await import('./config.js');
    expect(config.geminiApiKeys).toEqual([]);
    expect(config.keyPathEnabled).toBe(false);
  });

  it('uses defaults for KEY_COOLDOWN_AFTER_429_MS and KEY_BAD_TTL_MS', async () => {
    vi.resetModules();
    process.env.ADMIN_TOKEN = REQUIRED_ENV.ADMIN_TOKEN;
    process.env.ACCOUNTS_ENCRYPTION_KEY = REQUIRED_ENV.ACCOUNTS_ENCRYPTION_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = REQUIRED_ENV.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GEMINI_API_KEYS;
    delete process.env.KEY_COOLDOWN_AFTER_429_MS;
    delete process.env.KEY_BAD_TTL_MS;
    const { config } = await import('./config.js');
    expect(config.keyCooldownAfter429Ms).toBe(60_000);
    expect(config.keyBadTtlMs).toBe(86_400_000);
  });
});
