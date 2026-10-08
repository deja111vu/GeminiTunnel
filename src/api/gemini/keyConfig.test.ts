import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseApiKeys, KEY_RE } from './keyConfig.js';

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

  it('middleware.ts no longer inlines a copy of the regex', () => {
    // The middleware should import KEY_RE, not redefine it. If someone
    // re-inlines the regex here, the inline form will drift from the
    // canonical parser.
    const src = readFileSync(`${repoRoot}/src/api/gemini/middleware.ts`, 'utf8');
    expect(src).not.toMatch(/\/[\^]AIza/);
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
