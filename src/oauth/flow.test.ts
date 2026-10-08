import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { generatePkce, randomState, buildAuthorizationUrl } from './flow.js';
import { addPending, popPending, clearPending } from './state.js';

describe('oauth primitives', () => {
  it('generatePkce returns matching verifier+challenge (S256)', async () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge.length).toBeGreaterThanOrEqual(43);
    // recompute manually
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const b64 = Buffer.from(hash).toString('base64url');
    expect(challenge).toBe(b64);
  });

  it('randomState is hex 32 chars', () => {
    const s = randomState();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('buildAuthorizationUrl produces URL with required params', () => {
    const { url, state, verifier } = buildAuthorizationUrl({ accountLabel: 'work' });
    const u = new URL(url);
    expect(u.host).toBe('accounts.google.com');
    expect(u.pathname).toBe('/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBeTruthy();
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(state);
    // challenge is the hashed verifier, not verifier itself
    const challengeFromVerifier = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(u.searchParams.get('code_challenge')).toBe(challengeFromVerifier);
    expect(verifier).toBeTruthy();
  });
});

describe('pending oauth state', () => {
  beforeEach(() => {
    clearPending();
  });

  it('addPending + popPending roundtrips', () => {
    addPending({ state: 'aabb', verifier: 'v', accountLabel: 'work' });
    const e = popPending('aabb');
    expect(e).toEqual({ state: 'aabb', verifier: 'v', accountLabel: 'work', createdAt: expect.any(Number) });
    expect(popPending('aabb')).toBeNull();
  });

  it('popPending returns null on unknown', () => {
    expect(popPending('unknown')).toBeNull();
  });

  it('popPending returns null when entry expired', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
      addPending({ state: 'old', verifier: 'v', accountLabel: 'a' });
      vi.advanceTimersByTime(11 * 60 * 1000); // 11 min > 10 min TTL
      expect(popPending('old')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
