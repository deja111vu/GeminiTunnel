import { describe, it, expect, afterEach, vi } from 'vitest';

const REQUIRED_ENV = {
  ADMIN_TOKEN: 'a'.repeat(64),
  ACCOUNTS_ENCRYPTION_KEY: 'b'.repeat(64),
  GOOGLE_OAUTH_CLIENT_SECRET: 'dummy',
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
});
