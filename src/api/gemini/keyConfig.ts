// keyConfig.ts — pure parser for GEMINI_API_KEYS env var.
// CSV → trim → regex-validate → dedupe (by first occurrence).
// Used by config.ts (inline copy — config can't import from src/api/gemini/
// because config.ts is loaded at module-init time by every other module)
// and exposed here for unit testing in isolation.

import { createHash } from 'node:crypto';

const AIZA_PREFIX = 'AIza';
const KEY_BODY = '[a-zA-Z0-9_-]';
// Readonly RegExp: pinning the type and freezing the pattern prevents
// accidental global-flag mutation. Set.prototype preserves insertion order,
// so `new Set(...)` already gives us first-occurrence dedupe.
export const KEY_RE: Readonly<RegExp> = new RegExp(`^${AIZA_PREFIX}${KEY_BODY}{39}$`);

export function parseApiKeys(envValue: string | undefined): readonly string[] {
  if (!envValue) return [];
  return [
    ...new Set(
      envValue
        .split(',')
        .map((s) => s.trim())
        .filter((s) => KEY_RE.test(s)),
    ),
  ];
}

// Stable, non-reversable per-key identifier for log correlation.
//
// `slice(-4)` was used as a fingerprint, but the last 4 chars of an
// AIza key carry ~24 bits of entropy and let anyone with log access
// correlate which suffix belongs to which operator/model. SHA-256 of
// the full key, truncated to 8 hex chars, is:
//   - stable across log lines (same key -> same id within a process)
//   - not reversible in any practical sense (64^35 work to find a
//     preimage; no key disclosure from the id alone)
//   - 32 bits of collision resistance, enough for a per-process log
//     channel where N is the configured key count (typically <100)
//
// Note: this is NOT a secret hash (no pepper, no HMAC) — its only
// purpose is to keep `keySuffix`-style fingerprints out of the log
// stream. Anyone who has the id AND the full key can verify they
// match, but that's also true of a `keySuffix: "abcd"` line.
export function keyIdFor(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
