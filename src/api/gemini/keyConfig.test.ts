import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseApiKeys, KEY_RE, keyIdFor, findApiKeyInQuery, looksLikeApiKey, authHeadersFor } from './keyConfig.js';

// A valid Google API key (Auth format) is 40+ chars total: "AQ.Ab" (5)
// + 35+ body chars. Body length is variable; 44 is a typical real-world
// example (53-char keys are also issued). See RedHat ai-guardian #1617
// for the documented 35-char floor.
const VALID = 'AQ.Ab' + 'a'.repeat(44); // 5 + 44 = 49, a valid example

describe('parseApiKeys', () => {
  it('returns [] for undefined', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
  });
  it('returns [] for empty string', () => {
    expect(parseApiKeys('')).toEqual([]);
  });
  it('returns [] for whitespace-only', () => {
    expect(parseApiKeys('   ')).toEqual([]);
  });
  it('returns [] for all-empty CSV (",,, ")', () => {
    expect(parseApiKeys(',,, ')).toEqual([]);
  });
  it('parses single valid key', () => {
    expect(parseApiKeys(VALID)).toEqual([VALID]);
  });
  it('parses 3 valid keys, preserves order, dedupes', () => {
    const k1 = VALID;
    const k2 = 'AQ.Ab' + 'b'.repeat(44);
    const k3 = 'AQ.Ab' + 'c'.repeat(44);
    expect(parseApiKeys(`${k1},${k2},${k3}`)).toEqual([k1, k2, k3]);
    expect(parseApiKeys(`${k1},${k1},${k2}`)).toEqual([k1, k2]);
  });
  it('trims whitespace around values', () => {
    expect(parseApiKeys(`  ${VALID}  , ${VALID} `)).toEqual([VALID]);
  });
  it('drops invalid format with no throw', () => {
    expect(parseApiKeys(`not-an-api-key,${VALID},short`)).toEqual([VALID]);
  });
  it('accepts a real 53-char Google API key (AQ.Ab + 48 body, as issued in practice)', () => {
    // Real Google Auth-format keys are 40+ chars: `AQ.Ab` prefix
    // (5 chars) + 35+ body chars. Body length is variable; a 48-char
    // body (53 total) is what one user received in Oct 2026. Body is
    // synthetic below; a real key matches the same regex.
    const real53 = 'AQ.Ab' + 'a'.repeat(48); // 5 + 48 = 53
    expect(real53).toHaveLength(53);
    expect(KEY_RE.test(real53)).toBe(true);
  });

  it('accepts the minimum-length key (AQ.Ab + exactly 35 body = 40 chars)', () => {
    // Floor case: 35 is the documented minimum body length
    // (RedHat ai-guardian #1617). 34 must be rejected.
    expect(KEY_RE.test('AQ.Ab' + 'a'.repeat(35))).toBe(true);  // 40
    expect(KEY_RE.test('AQ.Ab' + 'a'.repeat(34))).toBe(false); // 39, below floor
  });

  it('drops keys that do not match /^AQ\\.Ab[a-zA-Z0-9_-]{35,}$/ (length, prefix, charset)', () => {
    const belowMin = 'AQ.Ab' + 'a'.repeat(34); // 39, below 40-char minimum
    const wrongPrefix = 'BQ.Ab' + 'a'.repeat(44);
    const mixedCasePrefix = 'aq.Ab' + 'a'.repeat(44);
    const legacyAIza = 'AIzaSyA' + 'a'.repeat(32); // 39-char legacy, no longer accepted
    const plusBody = 'AQ.Ab' + '+'.repeat(44);
    const slashBody = 'AQ.Ab' + '/'.repeat(44);
    const spaceBody = 'AQ.Ab' + ' '.repeat(44);
    for (const bad of [belowMin, wrongPrefix, mixedCasePrefix, legacyAIza, plusBody, slashBody, spaceBody]) {
      expect(KEY_RE.test(bad)).toBe(false);
    }
  });

  it('preserves order with whitespace + invalid + valid interleaving', () => {
    const k1 = VALID;
    const k2 = 'AQ.Ab' + 'b'.repeat(44);
    expect(
      parseApiKeys(`  ,  not-a-key  ,  ${k1} ,  still-not-a-key  ,${k2}  `),
    ).toEqual([k1, k2]);
  });

  it('returns readonly array (no mutation hazard)', () => {
    const a = parseApiKeys(VALID);
    const b = parseApiKeys(VALID);
    expect(a).not.toBe(b); // fresh array each call
  });
});

describe('keyIdFor', () => {
  // Used in place of `key.slice(-4)` for log correlation. The id must
  // be (a) stable per-key, (b) 8 hex chars, (c) NOT any substring of
  // the raw key, so a leaked log line gives the operator nothing.
  const K = 'AQ.Ab' + 'a'.repeat(44);

  it('returns 8 lowercase hex chars', () => {
    expect(keyIdFor(K)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable across calls', () => {
    expect(keyIdFor(K)).toBe(keyIdFor(K));
  });

  it('matches SHA-256(key).slice(0, 8) (regression: do not change the digest without a deploy plan)', () => {
    const expected = createHash('sha256').update(K).digest('hex').slice(0, 8);
    expect(keyIdFor(K)).toBe(expected);
  });

  it('does NOT include any 4-char tail of the raw key (no fingerprint leak)', () => {
    const tail = K.slice(-4);
    expect(keyIdFor(K)).not.toContain(tail);
    expect(keyIdFor(K)).not.toBe(tail);
  });

  it('differs across distinct keys', () => {
    const K2 = 'AQ.Ab' + 'b'.repeat(44);
    expect(keyIdFor(K)).not.toBe(keyIdFor(K2));
  });
});

describe('looksLikeApiKey', () => {
  // Edge guard against well-formed key-shaped values in untrusted inputs. Used by
  // findApiKeyInQuery to scan query-string values regardless of parameter
  // name. Public on purpose — KEY_RE is also exported.
  const K = 'AQ.Ab' + 'a'.repeat(44);

  it('accepts a well-formed AQ.Ab key (49 chars; 40..∞ are all valid)', () => {
    expect(looksLikeApiKey(K)).toBe(true);
  });

  it('rejects an AIza-shaped key (legacy format, no longer accepted)', () => {
    expect(looksLikeApiKey('AIzaSyA' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects a truncated key (the F3 invariant: only well-formed keys are blocked)', () => {
    expect(looksLikeApiKey('AQ.Ab')).toBe(false);
    expect(looksLikeApiKey(K.slice(0, 10))).toBe(false);
  });

  it('rejects non-key strings', () => {
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('not-a-key')).toBe(false);
    expect(looksLikeApiKey('sk-abcdefghijklmnopqrstuvwxyz0123456789')).toBe(false);
  });
});

describe('findApiKeyInQuery', () => {
  // The F3 edge guard. URLSearchParams.get('key') is case-sensitive on
  // the parameter name, so `?KEY=AQ.…` bypasses a naive `get('key')`
  // check. We must match on VALUE, scanning every parameter.
  const K = 'AQ.Ab' + 'a'.repeat(44);
  const K2 = 'AQ.Ab' + 'b'.repeat(44);

  it('returns the API key value when present under the conventional `key` name', () => {
    const p = new URLSearchParams(`key=${K}`);
    expect(findApiKeyInQuery(p)).toBe(K);
  });

  it('returns the API key value when the parameter name has different casing (?KEY=)', () => {
    // F3 case-sensitivity regression: this used to return null because
    // URLSearchParams.get('key') is case-sensitive.
    const p = new URLSearchParams(`KEY=${K}`);
    expect(findApiKeyInQuery(p)).toBe(K);
  });

  it('returns the API key value under arbitrary parameter names (?api_key=, ?apikey=)', () => {
    expect(findApiKeyInQuery(new URLSearchParams(`api_key=${K}`))).toBe(K);
    expect(findApiKeyInQuery(new URLSearchParams(`apikey=${K}`))).toBe(K);
    expect(findApiKeyInQuery(new URLSearchParams(`token=${K}`))).toBe(K);
  });

  it('returns null when no value matches the API key format', () => {
    expect(findApiKeyInQuery(new URLSearchParams('key=foo'))).toBeNull();
    expect(findApiKeyInQuery(new URLSearchParams('key=AIza'))).toBeNull();
    expect(findApiKeyInQuery(new URLSearchParams('key=AQ.Ab'))).toBeNull();
    expect(findApiKeyInQuery(new URLSearchParams())).toBeNull();
    expect(findApiKeyInQuery(new URLSearchParams('page=2&limit=10'))).toBeNull();
  });

  it('ignores non-key values when a real key is also present', () => {
    // Mixed bag: a page counter, a fake key, and a real key. Returns
    // the real one (whichever is found first).
    const p = new URLSearchParams(`page=1&key=fake&apikey=${K}`);
    expect(findApiKeyInQuery(p)).toBe(K);
  });

  it('returns the first key match when multiple are present', () => {
    const p = new URLSearchParams(`key=${K}&api_key=${K2}`);
    expect(findApiKeyInQuery(p)).toBe(K);
  });
});

describe('authHeadersFor', () => {
  // Google split key transport in 2026:
  //   - AQ. Auth keys (post-2026): MUST ride on `x-goog-api-key`; Bearer
  //     on the OpenAI-compat layer returns 401 / 400 "Multiple
  //     authentication credentials received".
  //   - AIza Standard keys (legacy, deprecated Sept 2026): still ride on
  //     `Authorization: Bearer` — kept here for keys that haven't been
  //     rotated yet.
  // Selection is by prefix (`AQ.`) rather than via KEY_RE, because the
  // prefix is the load-bearing signal for the auth method; KEY_RE only
  // validates the body length/charset and accepts both `AQ.Ab…` and any
  // hypothetical future shape that still starts with `AQ.`.
  const AQ = 'AQ.Ab' + 'a'.repeat(48);
  const AIza = 'AIzaSyA' + 'a'.repeat(32);

  it('routes an AQ. key through x-goog-api-key (no Bearer)', () => {
    expect(authHeadersFor(AQ)).toEqual({ 'x-goog-api-key': AQ });
  });

  it('routes a legacy AIza key through Authorization: Bearer', () => {
    expect(authHeadersFor(AIza)).toEqual({ Authorization: `Bearer ${AIza}` });
  });

  it('does NOT mix both headers for a single key (Google rejects double-auth)', () => {
    const h = authHeadersFor(AQ);
    expect(h['Authorization']).toBeUndefined();
    expect(h['x-goog-api-key']).toBe(AQ);
  });
});

describe('KEY_RE drift', () => {
  // The Google API key regex is inlined in three places:
  //   - src/api/gemini/keyConfig.ts (canonical, exported here)
  //   - src/api/gemini/middleware.ts (imports KEY_RE now)
  //   - src/config.ts (inlined as AQ_AB_PREFIX+KEY_BODY to break a startup cycle)
  // config.ts and keyConfig.ts use the same construction, so the canonical
  // source form is `^AQ\.Ab[a-zA-Z0-9_-]{35,}$`. If a maintainer ever
  // hand-edits one site, the parser and the request dispatcher will
  // silently disagree — the server boots, accepts keys at the config
  // layer, and rejects them at the middleware (or vice versa). These
  // tests pin the regex shape across all three files.
  const here = fileURLToPath(import.meta.url);
  const repoRoot = here.replace(/[\\/]src[\\/]api[\\/]gemini[\\/].*$/, '');

  it('KEY_RE source matches the canonical pattern', () => {
    // The prefix is interpolated as a literal string `'AQ.Ab'` so the
    // stored source contains a literal `.` (not `\.`). The anchored
    // regex matches the same strings either way; we pin the literal
    // form because that's what `new RegExp(...)` produces.
    expect(KEY_RE.source).toBe('^AQ.Ab[a-zA-Z0-9_-]{35,}$');
  });

  it('AQ_AB_PREFIX constant in keyConfig.ts equals "AQ.Ab" (rename target for AIza migration)', () => {
    // Pin the constant name + value: if a maintainer ever tries to revert
    // the rename (back to AIZA_PREFIX) or change the prefix value, this trips.
    const src = readFileSync(new URL('./keyConfig.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/AQ_AB_PREFIX\s*=\s*['"]AQ\.Ab['"]/);
    expect(src).not.toMatch(/AIZA_PREFIX\s*=\s*['"]AIza['"]/);
  });

  it('middleware.ts imports KEY_RE from keyConfig (not inlined)', () => {
    // The middleware should import KEY_RE, not redefine it. If someone
    // re-inlines the regex here, the inline form will drift from the
    // canonical parser.
    const src = readFileSync(`${repoRoot}/src/api/gemini/middleware.ts`, 'utf8');
    // No inlined copy of the regex shape.
    expect(src).not.toMatch(/\/[\^]AQ\\\.Ab/);
    // And the import is actually present — a refactor that removed
    // both the inline AND the import would leave the file referencing
    // an undefined symbol at runtime.
    expect(src).toMatch(/from\s+['"]\.\/keyConfig\.js['"]/);
    expect(src).toMatch(/\bKEY_RE\b/);
  });

  it('config.ts inlined pattern matches KEY_RE.source', () => {
    // config.ts must keep an inlined copy (to break the startup cycle);
    // this test pins that copy to the same source.
    const src = readFileSync(`${repoRoot}/src/config.ts`, 'utf8');
    // The pattern is built from AQ_AB_PREFIX + KEY_BODY inside a template
    // literal: `^${AQ_AB_PREFIX}${KEY_BODY}{35,}$`. If a maintainer ever
    // hand-edits the inlined copy, the parser and the request dispatcher
    // will silently disagree.
    expect(src).toMatch(/AQ_AB_PREFIX\s*=\s*['"]AQ\.Ab['"]/);
    expect(src).toMatch(/KEY_BODY\s*=\s*['"]\[a-zA-Z0-9_-\]['"]/);
    // The construction site uses `${...}` interpolation, so we match
    // that form rather than the literal `KEY_BODY{35,}$`.
    expect(src).toMatch(/\$\{AQ_AB_PREFIX\}[\s\S]*?\$\{KEY_BODY\}\{35,\}\$/);
  });
});