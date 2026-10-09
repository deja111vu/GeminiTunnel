import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseApiKeys, KEY_RE, keyIdFor, findAizaInQuery, looksLikeApiKey } from './keyConfig.js';

// A valid Google API key is 43 chars total: "AIza" + 39 chars of [a-zA-Z0-9_-].
const VALID = 'AIzaSyA' + 'a'.repeat(36); // 7 + 36 = 43

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
    const k2 = 'AIzaSyB' + 'b'.repeat(36);
    const k3 = 'AIzaSyC' + 'c'.repeat(36);
    expect(parseApiKeys(`${k1},${k2},${k3}`)).toEqual([k1, k2, k3]);
    expect(parseApiKeys(`${k1},${k1},${k2}`)).toEqual([k1, k2]);
  });
  it('trims whitespace around values', () => {
    expect(parseApiKeys(`  ${VALID}  , ${VALID} `)).toEqual([VALID]);
  });
  it('drops invalid format with no throw', () => {
    expect(parseApiKeys(`not-an-api-key,${VALID},short`)).toEqual([VALID]);
  });
  it('drops keys that do not match /^AIza[a-zA-Z0-9_-]{39}$/ (length, prefix, charset)', () => {
    // Wrong length
    const tooShort = 'AIzaSyA' + 'a'.repeat(35);
    const tooLong = 'AIzaSyA' + 'a'.repeat(40);
    // Wrong prefix (lowercase / wrong letters)
    const wrongPrefix = 'BIzaSyA' + 'a'.repeat(36);
    const mixedCasePrefix = 'aIzaSyA' + 'a'.repeat(36);
    // Wrong charset in body: + / = . @ space (each is 43 chars long, passes length, fails charset)
    const plusBody = 'AIzaSyA' + '+'.repeat(36);
    const slashBody = 'AIzaSyA' + '/'.repeat(36);
    const spaceBody = 'AIzaSyA' + ' '.repeat(36);
    expect(
      parseApiKeys(`${tooShort},${tooLong},${wrongPrefix},${mixedCasePrefix},${plusBody},${slashBody},${spaceBody},${VALID}`),
    ).toEqual([VALID]);
  });

  it('preserves order with whitespace + invalid + valid interleaving', () => {
    const k1 = VALID;
    const k2 = 'AIzaSyB' + 'b'.repeat(36);
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
  const K = 'AIzaSyA' + 'a'.repeat(36);

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
    const K2 = 'AIzaSyB' + 'b'.repeat(36);
    expect(keyIdFor(K)).not.toBe(keyIdFor(K2));
  });
});

describe('looksLikeApiKey', () => {
  // Edge guard against AIza-shaped values in untrusted inputs. Used by
  // findAizaInQuery to scan query-string values regardless of parameter
  // name. Public on purpose — KEY_RE is also exported.
  const K = 'AIzaSyA' + 'a'.repeat(36);

  it('accepts a well-formed key', () => {
    expect(looksLikeApiKey(K)).toBe(true);
  });

  it('rejects a truncated key (the F3 invariant: only well-formed keys are blocked)', () => {
    expect(looksLikeApiKey('AIza')).toBe(false);
    expect(looksLikeApiKey(K.slice(0, 10))).toBe(false);
  });

  it('rejects non-key strings', () => {
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('not-a-key')).toBe(false);
    expect(looksLikeApiKey('sk-abcdefghijklmnopqrstuvwxyz0123456789')).toBe(false);
  });
});

describe('findAizaInQuery', () => {
  // The F3 edge guard. URLSearchParams.get('key') is case-sensitive on
  // the parameter name, so `?KEY=AIza…` bypasses a naive `get('key')`
  // check. We must match on VALUE, scanning every parameter.
  const K = 'AIzaSyA' + 'a'.repeat(36);
  const K2 = 'AIzaSyB' + 'b'.repeat(36);

  it('returns the AIza value when present under the conventional `key` name', () => {
    const p = new URLSearchParams(`key=${K}`);
    expect(findAizaInQuery(p)).toBe(K);
  });

  it('returns the AIza value when the parameter name has different casing (?KEY=)', () => {
    // F3 case-sensitivity regression: this used to return null because
    // URLSearchParams.get('key') is case-sensitive.
    const p = new URLSearchParams(`KEY=${K}`);
    expect(findAizaInQuery(p)).toBe(K);
  });

  it('returns the AIza value under arbitrary parameter names (?api_key=, ?apikey=)', () => {
    expect(findAizaInQuery(new URLSearchParams(`api_key=${K}`))).toBe(K);
    expect(findAizaInQuery(new URLSearchParams(`apikey=${K}`))).toBe(K);
    expect(findAizaInQuery(new URLSearchParams(`token=${K}`))).toBe(K);
  });

  it('returns null when no value matches the AIza format', () => {
    expect(findAizaInQuery(new URLSearchParams('key=foo'))).toBeNull();
    expect(findAizaInQuery(new URLSearchParams('key=AIza'))).toBeNull();
    expect(findAizaInQuery(new URLSearchParams())).toBeNull();
    expect(findAizaInQuery(new URLSearchParams('page=2&limit=10'))).toBeNull();
  });

  it('ignores non-AIza values when a real key is also present', () => {
    // Mixed bag: a page counter, a fake key, and a real key. Returns
    // the real one (whichever is found first).
    const p = new URLSearchParams(`page=1&key=fake&apikey=${K}`);
    expect(findAizaInQuery(p)).toBe(K);
  });

  it('returns the first AIza match when multiple are present', () => {
    const p = new URLSearchParams(`key=${K}&api_key=${K2}`);
    expect(findAizaInQuery(p)).toBe(K);
  });
});

describe('KEY_RE drift', () => {
  // The Google API key regex is inlined in three places:
  //   - src/api/gemini/keyConfig.ts (canonical, exported here)
  //   - src/api/gemini/middleware.ts (imports KEY_RE now)
  //   - src/config.ts (inlined as AIZA_PREFIX+KEY_BODY to break a startup cycle)
  // config.ts and keyConfig.ts use the same construction, so the canonical
  // source form is `^AIza[a-zA-Z0-9_-]{39}$`. If a maintainer ever
  // hand-edits one site, the parser and the request dispatcher will
  // silently disagree — the server boots, accepts keys at the config
  // layer, and rejects them at the middleware (or vice versa). These
  // tests pin the regex shape across all three files.
  const here = fileURLToPath(import.meta.url);
  const repoRoot = here.replace(/[\\/]src[\\/]api[\\/]gemini[\\/].*$/, '');

  it('KEY_RE source matches the canonical pattern', () => {
    expect(KEY_RE.source).toBe('^AIza[a-zA-Z0-9_-]{39}$');
  });

  it('middleware.ts imports KEY_RE from keyConfig (not inlined)', () => {
    // The middleware should import KEY_RE, not redefine it. If someone
    // re-inlines the regex here, the inline form will drift from the
    // canonical parser.
    const src = readFileSync(`${repoRoot}/src/api/gemini/middleware.ts`, 'utf8');
    // No inlined copy of the regex shape.
    expect(src).not.toMatch(/\/[\^]AIza/);
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
    // The pattern is built from AIZA_PREFIX + KEY_BODY inside a template
    // literal: `^${AIZA_PREFIX}${KEY_BODY}{39}$`. If a maintainer ever
    // hand-edits the inlined copy, the parser and the request dispatcher
    // will silently disagree.
    expect(src).toMatch(/AIZA_PREFIX\s*=\s*['"]AIza['"]/);
    expect(src).toMatch(/KEY_BODY\s*=\s*['"]\[a-zA-Z0-9_-\]['"]/);
    // The construction site uses `${...}` interpolation, so we match
    // that form rather than the literal `KEY_BODY{39}$`.
    expect(src).toMatch(/\$\{AIZA_PREFIX\}[\s\S]*?\$\{KEY_BODY\}\{39\}\$/);
  });
});
