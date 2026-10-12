import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_PATHS } from './logger.js';

// Capture pino output to an in-memory string. `pino` accepts a custom
// destination stream in its second arg, so the production `logger`
// (which writes to stdout) is not affected.
function captureLog(fn: (l: pino.Logger) => void): string {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const testLogger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, dest);
  fn(testLogger);
  return chunks.join('');
}

describe('logger redaction (REDACT_PATHS contract)', () => {
  // Pins B1 (proxy-token code-review). The bare `clientApiKey` path
  // silently no-op'd because the env value lives at `config.clientApiKey`
  // and pino's redact paths are exact (not recursive). A future refactor
  // that drops the `config.` prefix would re-open the leak.
  it('redacts the nested path `config.clientApiKey` (B1 regression)', () => {
    expect(REDACT_PATHS).toContain('config.clientApiKey');
  });

  it('does not list a bare `clientApiKey` path (would silently miss the nested value)', () => {
    // The `config.` prefix is what makes the redact work. A bare
    // `clientApiKey` matches `obj.clientApiKey` exactly, NOT
    // `obj.config.clientApiKey`. If this test fails, B1 has regressed.
    expect(REDACT_PATHS).not.toContain('clientApiKey');
  });

  // End-to-end smoke: actually run pino with the production REDACT_PATHS
  // and verify the secret does not appear in the output. Catches future
  // pino version upgrades that change redact-path semantics.
  it('pino with REDACT_PATHS censors a nested config.clientApiKey value', () => {
    const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const output = captureLog((l) =>
      l.info({ config: { clientApiKey: SECRET } }, 'boot seed'),
    );
    expect(output).not.toContain(SECRET);
    expect(output).toContain('[REDACTED]');
  });

  it('pino with REDACT_PATHS also censors the established config.geminiApiKeys path', () => {
    // Sanity check that the existing `config.geminiApiKeys` pattern
    // (the model B1 was supposed to follow) still works.
    const SECRET = 'AQ.Ab' + 'a'.repeat(44);
    const output = captureLog((l) =>
      l.info({ config: { geminiApiKeys: [SECRET] } }, 'boot keys'),
    );
    expect(output).not.toContain(SECRET);
    expect(output).toContain('[REDACTED]');
  });

  // The bare `adminToken` path is at the root (not nested), so a
  // top-level `{ adminToken: ... }` is the natural test shape.
  it('pino with REDACT_PATHS censors a top-level adminToken', () => {
    const output = captureLog((l) =>
      l.info({ adminToken: 'x'.repeat(64) }, 'admin login'),
    );
    expect(output).not.toContain('x'.repeat(64));
    expect(output).toContain('[REDACTED]');
  });
});
