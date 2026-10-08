import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../config.js', () => ({
  config: {
    dataDir: '',
    accountsEncryptionKey: 'a'.repeat(64),
    adminToken: 'b'.repeat(64),
    googleOauthClientId: 'cid',
    googleOauthClientSecret: 'csec',
    port: 8000,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.invalid',
    quotaPollIntervalMs: 5 * 60 * 1000,
    cooldownAfter429Ms: 60_000,
    switchBudget: 4,
    requestTimeoutMs: 120_000,
    logLevel: 'info' as const,
  },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseId, fmtTime, main } from './bin.js';
import { config } from '../config.js';
import { createStore } from '../accounts/store.js';

const KEY = 'a'.repeat(64);

describe('parseId', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // @ts-expect-error mock signature vs spied signature mismatch — see comment in main().
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
  });
  afterEach(() => exitSpy.mockRestore());

  it('accepts positive integers', () => {
    expect(parseId('1')).toBe(1);
    expect(parseId('42')).toBe(42);
    expect(parseId('999999')).toBe(999999);
  });

  it('rejects non-digit, floats, hex, exponent, zero, and undefined via usage()', () => {
    for (const bad of [undefined, '', '0', '-1', '1.5', '1e2', '0x10', 'abc', '1; DROP']) {
      expect(() => parseId(bad as string)).toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(2);
      exitSpy.mockClear();
    }
  });
});

describe('fmtTime', () => {
  it('renders null/undefined as em-dash', () => {
    expect(fmtTime(null)).toBe('—');
    expect(fmtTime(undefined)).toBe('—');
  });
  it('renders 0 as the Unix epoch (not em-dash) — guards against the falsy-zero bug', () => {
    expect(fmtTime(0)).toBe('1970-01-01T00:00:00.000Z');
  });
  it('renders a real timestamp as ISO', () => {
    expect(fmtTime(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('main()', () => {
  // tmpParent is a parent dir we own. The actual dataDir is `tmpParent/data`,
  // a path that does NOT exist before each test — that lets us assert
  // that no DB was opened as a side effect of an unknown command.
  let tmpParent: string;
  let dataDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpParent = mkdtempSync(path.join(tmpdir(), 'gt-cli-'));
    dataDir = path.join(tmpParent, 'data');
    (config as { dataDir: string }).dataDir = dataDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // vi.spyOn's mock typing wants (this: unknown, ...args: unknown[]) which
    // collides with the real process.exit signature. The throw is what
    // matters for the test, not the input.
    // @ts-expect-error mock signature vs spied signature mismatch — see comment above.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(tmpParent, { recursive: true, force: true });
  });

  it('list prints "No accounts yet" on empty store', async () => {
    await main(['list']);
    expect(logSpy).toHaveBeenCalled();
    const all = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(all).toMatch(/No accounts yet/);
  });

  it('list prints a table row for a populated account', async () => {
    const s = createStore(dataDir, KEY);
    s.addAccount({ email: 'a@e.com', refreshToken: 'rt', tierName: 'pro' });
    s.close();
    await main(['list']);
    const all = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(all).toMatch(/a@e\.com/);
    expect(all).toMatch(/pro/);
  });

  it('remove <id> deletes the account', async () => {
    const s = createStore(dataDir, KEY);
    const a = s.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    s.close();
    await main(['remove', String(a.id)]);
    const after = createStore(dataDir, KEY);
    expect(after.getAccount(a.id)).toBeNull();
    after.close();
  });

  it('remove with non-integer id prints usage and exits 2', async () => {
    await expect(main(['remove', 'abc'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('remove on a non-existent id prints an error and exits 1', async () => {
    // main() rejects with the original error; the top-level .catch in
    // bin.ts turns that into process.exit(1). Test the chain separately.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const werr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const exit2 = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(main(['remove', '999'])).rejects.toThrow(/account #999 not found/);
    } finally {
      log.mockRestore();
      werr.mockRestore();
      exit2.mockRestore();
    }
  });

  it('unknown command does not create the data dir (lazy init)', async () => {
    expect(existsSync(dataDir)).toBe(false);
    await expect(main(['bogus'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('no command does not create the data dir (lazy init)', async () => {
    expect(existsSync(dataDir)).toBe(false);
    await expect(main([])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('failure path closes the SQLite handle (no leaked DB on error)', async () => {
    const s = createStore(dataDir, KEY);
    s.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    s.close();
    // refresh fails (no real network) — must still release the handle
    // so a follow-up createStore on the same data dir doesn't lock.
    await expect(main(['refresh', '1'])).rejects.toThrow();
    const reopened = createStore(dataDir, KEY);
    expect(reopened.listAccounts()).toHaveLength(1);
    reopened.close();
  });
});
