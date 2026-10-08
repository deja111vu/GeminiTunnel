import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addPending, popPending, clearPending, _pendingSize } from './state.js';

describe('addPending', () => {
  beforeEach(() => {
    clearPending();
    vi.useRealTimers();
  });

  it('stores an entry that popPending can retrieve', () => {
    addPending({ state: 's1', verifier: 'v1', accountLabel: 'work' });
    const e = popPending('s1');
    expect(e).not.toBeNull();
    expect(e?.verifier).toBe('v1');
    expect(e?.accountLabel).toBe('work');
  });

  it('evicts expired entries on insert so a flood of /oauth/start cannot grow the map unbounded', () => {
    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    // pre-populate 3 entries, then jump past the 10-minute TTL
    addPending({ state: 'a', verifier: 'v', accountLabel: 'l' });
    addPending({ state: 'b', verifier: 'v', accountLabel: 'l' });
    addPending({ state: 'c', verifier: 'v', accountLabel: 'l' });
    expect(_pendingSize()).toBe(3);
    vi.setSystemTime(start + 11 * 60 * 1000);
    // the next add must sweep the three stale entries
    addPending({ state: 'd', verifier: 'v', accountLabel: 'l' });
    expect(_pendingSize()).toBe(1);
  });

  it('throws when the pending map is full so a sustained flood cannot OOM the process', () => {
    // All inserts share one Date.now() (no TTL boundary), so the sweep
    // never helps. The cap must fire on raw size.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    for (let i = 0; i < 1500; i++) {
      try {
        addPending({ state: 'k' + i, verifier: 'v', accountLabel: 'l' });
      } catch {
        return; // expected
      }
    }
    throw new Error('addPending did not enforce a size cap');
  });
});

describe('popPending', () => {
  beforeEach(() => {
    clearPending();
    vi.useRealTimers();
  });

  it('returns null for unknown state', () => {
    expect(popPending('nope')).toBeNull();
  });

  it('returns null for expired entry (TTL check at pop time)', () => {
    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    addPending({ state: 'x', verifier: 'v', accountLabel: 'l' });
    vi.setSystemTime(start + 11 * 60 * 1000);
    expect(popPending('x')).toBeNull();
  });

  it('deletes entry on successful pop (one-shot semantics)', () => {
    addPending({ state: 'y', verifier: 'v', accountLabel: 'l' });
    popPending('y');
    expect(popPending('y')).toBeNull();
  });
});
