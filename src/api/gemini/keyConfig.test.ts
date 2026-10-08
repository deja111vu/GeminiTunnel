import { describe, it, expect } from 'vitest';
import { parseApiKeys } from './keyConfig.js';

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
  it('drops keys that do not match /^AIza[a-zA-Z0-9_-]{39}$/', () => {
    // Wrong length
    const tooShort = 'AIzaSyA' + 'a'.repeat(35);
    const tooLong = 'AIzaSyA' + 'a'.repeat(40);
    expect(parseApiKeys(`${tooShort},${tooLong},${VALID}`)).toEqual([VALID]);
  });
});
