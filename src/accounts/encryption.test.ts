import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './encryption.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('encryption', () => {
  it('roundtrips a string', () => {
    const ct = encrypt('hello world', KEY);
    expect(ct).toBeInstanceOf(Buffer);
    expect(ct.length).toBeGreaterThan(11 + 16);
    expect(decrypt(ct, KEY).toString()).toBe('hello world');
  });

  it('roundtrips a binary', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const ct = encrypt(buf, KEY);
    expect(decrypt(ct, KEY).equals(buf)).toBe(true);
  });

  it('produces different ciphertext for same input (random IV)', () => {
    const a = encrypt('same', KEY);
    const b = encrypt('same', KEY);
    expect(a.equals(b)).toBe(false);
  });

  it('throws when tag mismatches', () => {
    const ct = encrypt('top secret', KEY);
    // corrupt last byte (auth tag)
    ct[ct.length - 1] ^= 0xff;
    expect(() => decrypt(ct, KEY)).toThrow();
  });

  it('throws when key is wrong length or non-hex', () => {
    expect(() => encrypt('x', 'short')).toThrow();
    expect(() => encrypt('x', 'z'.repeat(64))).toThrow(); // not hex
    expect(() => encrypt('x', '0'.repeat(64))).not.toThrow(); // valid
  });
});
