// keyConfig.ts — pure parser for GEMINI_API_KEYS env var.
// CSV → trim → regex-validate → dedupe (by first occurrence).
// Used by config.ts (inline copy — config can't import from src/api/gemini/
// because config.ts is loaded at module-init time by every other module)
// and exposed here for unit testing in isolation.

import { createHash } from 'node:crypto';

const AQ_AB_PREFIX = 'AQ.Ab';
const KEY_BODY = '[a-zA-Z0-9_-]';
// Readonly RegExp: pinning the type and freezing the pattern prevents
// accidental global-flag mutation. Set.prototype preserves insertion order,
// so `new Set(...)` already gives us first-occurrence dedupe.
// A valid Google API key (Auth format, post-2026) is "AQ.Ab" + 35 or
// more chars of [a-zA-Z0-9_-] (40+ total). Body length is variable per
// Google issuance, not fixed — see RedHat ai-guardian #1617
// (https://github.com/RedHatProductSecurity/ai-guardian/issues/1617)
// for the documented ~35-char floor. Legacy AIza-format keys (39 chars)
// are no longer accepted: Google cut them off in Sept 2026.
export const KEY_RE: Readonly<RegExp> = new RegExp(`^${AQ_AB_PREFIX}${KEY_BODY}{35,}$`);

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
// AQ. key carry ~24 bits of entropy and let anyone with log access
// correlate which suffix belongs to which operator/model. SHA-256 of
// the full key, truncated to 8 hex chars, is:
//   - stable across log lines (same key -> same id within a process)
//   - not reversible in any practical sense: 64^N work to find a
//     preimage for an N-char body (N ≥ 35 per KEY_RE); even at the
//     documented minimum body length this is computationally infeasible.
//     no key disclosure from the id alone.
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

// True iff `value` looks like a well-formed Google API key. Public
// (the regex is also exported as KEY_RE) — by design, the format is
// not a secret. Used to reject keys in query strings and other
// untrusted locations where the parameter name cannot be trusted
// (clients may use `?key=`, `?KEY=`, `?api_key=`, etc. — and the
// NAME is case-sensitive in URLSearchParams, so we match on VALUE).
export function looksLikeApiKey(value: string): boolean {
  return KEY_RE.test(value);
}

// Returns the first query-string value that matches a well-formed
// Google API key (AQ. Auth format), regardless of the parameter name.
// Used by the edge guard that rejects `?key=AQ.…` before it can leak
// into access logs / browser history / referer headers.
//
// Case-insensitive on the parameter NAME side would require either
// iterating the spec implementation or normalising the query string
// ourselves. The cheaper, safer choice is: trust nothing about the
// name, scan every value with KEY_RE. This also catches
// `?api_key=AQ.…` / `?apikey=AQ.…` / any other name a client
// happens to pick.
export function findApiKeyInQuery(searchParams: URLSearchParams): string | null {
  for (const [, value] of searchParams.entries()) {
    if (KEY_RE.test(value)) return value;
  }
  return null;
}
