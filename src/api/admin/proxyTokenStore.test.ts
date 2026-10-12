import { describe, it, expect, beforeEach } from 'vitest';
import { getProxyTokenStore, resetProxyTokenStoreForTests } from './proxyTokenStore.js';

describe('proxyTokenStore', () => {
  beforeEach(() => {
    resetProxyTokenStoreForTests();
  });

  it('get() returns undefined on a fresh singleton', () => {
    expect(getProxyTokenStore().get()).toBeUndefined();
  });

  it('set() then get() roundtrips the value', () => {
    const s = getProxyTokenStore();
    s.set('a'.repeat(64));
    expect(s.get()).toBe('a'.repeat(64));
  });

  it('set(undefined) clears the value', () => {
    const s = getProxyTokenStore();
    s.set('a'.repeat(64));
    s.set(undefined);
    expect(s.get()).toBeUndefined();
  });

  it('getProxyTokenStore returns the same instance across calls', () => {
    expect(getProxyTokenStore()).toBe(getProxyTokenStore());
  });

  it('resetProxyTokenStoreForTests() forces a new instance', () => {
    const first = getProxyTokenStore();
    first.set('a'.repeat(64));
    resetProxyTokenStoreForTests();
    const second = getProxyTokenStore();
    expect(second).not.toBe(first);
    expect(second.get()).toBeUndefined();
  });
});
