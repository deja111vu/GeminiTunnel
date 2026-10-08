import { describe, it, expect, beforeEach } from 'vitest';
import { KeyPool, NoKeyAvailableError } from './keyPool.js';

const K1 = 'AIzaSyA' + 'a'.repeat(36);
const K2 = 'AIzaSyB' + 'b'.repeat(36);
const K3 = 'AIzaSyC' + 'c'.repeat(36);
const NOW = 1_700_000_000_000;

describe('KeyPool', () => {
  let now = NOW;
  beforeEach(() => { now = NOW; });

  function makePool(keys = [K1, K2, K3]) {
    return new KeyPool({ keys, cooldownMs: 60_000, badTtlMs: 86_400_000, jitterMs: 0, now: () => now });
  }

  it('round-robin across all 3 keys', () => {
    const p = makePool();
    expect(p.pick().key).toBe(K1);
    expect(p.pick().key).toBe(K2);
    expect(p.pick().key).toBe(K3);
    expect(p.pick().key).toBe(K1);
  });

  it('per-model cooldown: k1 cooldown для "pro", но доступен для "flash"', () => {
    const p = makePool();
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    now += 1;
    const proPicks = [p.pick('gemini-2.5-pro').key, p.pick('gemini-2.5-pro').key, p.pick('gemini-2.5-pro').key];
    expect(proPicks).not.toContain(K1);
    expect(proPicks.sort()).toEqual([K2, K3, K2].sort());
    // K1 still available for flash
    const flashPicks = [p.pick('gemini-2.5-flash').key, p.pick('gemini-2.5-flash').key, p.pick('gemini-2.5-flash').key];
    expect(flashPicks).toContain(K1);
  });

  it('markBad excludes key for 24h across all models', () => {
    const p = makePool();
    p.markBad(K1);
    now += 1;
    const picks = [p.pick(), p.pick(), p.pick()].map((p) => p.key);
    expect(picks.every((k) => k !== K1)).toBe(true);
  });

  it('all bad → pick() throws', () => {
    const p = makePool([K1, K2]);
    p.markBad(K1);
    p.markBad(K2);
    now += 1;
    expect(() => p.pick()).toThrow();
  });

  it('all cooldown (not bad) → pick(model) throws', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    p.recordRateLimit(K2, 'gemini-2.5-pro', 60_000);
    now += 1;
    expect(() => p.pick('gemini-2.5-pro')).toThrow();
  });

  it('TTL истекает → ключ возвращается', () => {
    const p = makePool([K1, K2]);
    p.markBad(K1, 100);
    now += 1;
    expect(p.pick().key).toBe(K2);
    now += 200;
    const picks = [p.pick().key, p.pick().key].sort();
    expect(picks).toEqual([K1, K2].sort());
  });

  it('startup jitter: nextAvailableAfter > now → ключ пропускается', () => {
    const p = new KeyPool({
      keys: [K1, K2, K3],
      cooldownMs: 60_000,
      badTtlMs: 86_400_000,
      jitterMs: 0, // disable random jitter; we set explicit values below
      now: () => now,
    });
    // Force K1 nextAvailableAfter far in future; K2, K3 in the past (immediately available).
    (p as unknown as { nextAvailableAfter: Map<string, number> }).nextAvailableAfter.set(K1, now + 60_000);
    (p as unknown as { nextAvailableAfter: Map<string, number> }).nextAvailableAfter.set(K2, now);
    (p as unknown as { nextAvailableAfter: Map<string, number> }).nextAvailableAfter.set(K3, now);
    const picks = [p.pick().key, p.pick().key, p.pick().key, p.pick().key];
    expect(picks).not.toContain(K1);
    expect(new Set(picks)).toEqual(new Set([K2, K3]));
  });

  it('thundering herd: 3 ключа с jitter → pick разносит запросы', () => {
    const p = new KeyPool({
      keys: [K1, K2, K3],
      cooldownMs: 60_000,
      badTtlMs: 86_400_000,
      jitterMs: 30_000,
      now: () => now,
    });
    // K1 already past jitter, K2 still in jitter (5s), K3 still in jitter (15s).
    (p as unknown as { nextAvailableAfter: Map<string, number> }).nextAvailableAfter.set(K1, now);
    (p as unknown as { nextAvailableAfter: Map<string, number> }).nextAvailableAfter.set(K2, now + 5_000);
    (p as unknown as { nextAvailableAfter: Map<string, number> }).nextAvailableAfter.set(K3, now + 15_000);
    // At t=now, only K1 is available.
    expect(p.pick().key).toBe(K1);
    // At t=now+10s, K2 also available.
    now += 10_000;
    const picks = [p.pick().key, p.pick().key].sort();
    expect(picks).toEqual([K1, K2].sort());
  });

  it('summaryForAllModels() reports configured/cooldown/bad counts', () => {
    const p = makePool([K1, K2, K3]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    p.markBad(K2);
    now += 1;
    const s = p.summaryForAllModels();
    expect(s.configured).toBe(3);
    expect(s.bad).toBe(1);
    expect(s.cooldown).toBe(1);
  });

  it('summaryForModel() counts per-model cooldowns', () => {
    const p = makePool([K1, K2, K3]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    p.recordRateLimit(K2, 'gemini-2.5-pro', 60_000);
    now += 1;
    const s = p.summaryForModel('gemini-2.5-pro');
    expect(s.cooldown).toBe(2);
    expect(s.bad).toBe(0);
    expect(s.configured).toBe(3);
  });

  it('pick() throws when keys is empty', () => {
    const p = makePool([]);
    expect(() => p.pick()).toThrow();
  });

  it('clearCooldown() после успеха снимает per-model cooldown', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    p.clearCooldown(K1, 'gemini-2.5-pro');
    now += 1;
    const picks = [p.pick('gemini-2.5-pro').key, p.pick('gemini-2.5-pro').key];
    expect(picks).toContain(K1);
  });

  it('per-model cooldown не задевает другие модели', () => {
    const p = makePool([K1]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    now += 1;
    expect(p.pick('gemini-2.5-flash').key).toBe(K1);
    expect(() => p.pick('gemini-2.5-pro')).toThrow();
  });

  it('markBad на одном ключе не задевает остальные', () => {
    const p = makePool([K1, K2, K3]);
    p.markBad(K1);
    now += 1;
    expect(p.pick().key).not.toBe(K1);
    expect(p.pick().key).not.toBe(K1);
  });

  it('minBadExpiry() returns min time-to-expiry среди bad ключей', () => {
    const p = makePool([K1, K2, K3]);
    p.markBad(K1, 10_000);
    p.markBad(K2, 60_000);
    now += 1;
    const exp = p.minBadExpiry();
    expect(exp).toBeGreaterThan(9_000);
    expect(exp).toBeLessThanOrEqual(10_000);
  });

  it('minBadExpiry() returns null when no bad keys', () => {
    const p = makePool([K1]);
    expect(p.minBadExpiry()).toBeNull();
  });

  it('minCooldownExpiry(model) returns min time-to-expiry среди cooldown keys', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 5_000);
    p.recordRateLimit(K2, 'gemini-2.5-pro', 30_000);
    now += 1;
    const exp = p.minCooldownExpiry('gemini-2.5-pro');
    expect(exp).toBeGreaterThan(4_000);
    expect(exp).toBeLessThanOrEqual(5_000);
  });

  it('summaryForAllModels() агрегирует cooldown по всем моделям', () => {
    const p = makePool([K1, K2, K3]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000);
    p.recordRateLimit(K2, 'gemini-2.5-flash', 60_000);
    p.markBad(K3);
    now += 1;
    const s = p.summaryForAllModels();
    expect(s.configured).toBe(3);
    expect(s.bad).toBe(1);
    expect(s.cooldown).toBe(2); // K1 (pro) + K2 (flash)
  });

  it('all bad → throws NoKeyAvailableError с reason=all_bad и retryAfterMs=minBadExpiry', () => {
    const p = makePool([K1, K2]);
    p.markBad(K1, 10_000);
    p.markBad(K2, 30_000);
    now += 1;
    try {
      p.pick();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NoKeyAvailableError);
      const e = err as NoKeyAvailableError;
      expect(e.reason).toBe('all_bad');
      expect(e.retryAfterMs).toBeGreaterThan(9_000);
      expect(e.retryAfterMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('all cooldown (per-model) → throws NoKeyAvailableError с reason=all_cooldown', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 5_000);
    p.recordRateLimit(K2, 'gemini-2.5-pro', 30_000);
    now += 1;
    try {
      p.pick('gemini-2.5-pro');
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NoKeyAvailableError);
      const e = err as NoKeyAvailableError;
      expect(e.reason).toBe('all_cooldown');
      expect(e.retryAfterMs).toBeGreaterThan(4_000);
      expect(e.retryAfterMs).toBeLessThanOrEqual(5_000);
    }
  });

  it('markBad clears existing per-model cooldowns для ключа (no stale block after bad TTL)', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 120_000);
    p.markBad(K1, 100);
    now += 200; // bad TTL expired
    // Without the fix, K1 would still be on cooldown for pro.
    const picks = [p.pick('gemini-2.5-pro').key, p.pick('gemini-2.5-pro').key];
    expect(picks).toContain(K1);
  });

  it('recordRateLimit берёт max(existing, newUntil) — не сокращает активный cooldown', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000); // until = now + 60_000
    now += 30_000; // 30s прошло
    p.recordRateLimit(K1, 'gemini-2.5-pro', 60_000); // newUntil = now + 60_000 = t+120_000, existing=t+60_000
    now += 1;
    // K1 must still be on cooldown: existing until (t+60_000) > now (t+30_001)
    expect(p.pick('gemini-2.5-pro').key).toBe(K2);
  });

  it('recordRateLimit fresh 429 within active cooldown slides `until` to t+durMax', () => {
    const p = makePool([K1, K2]);
    p.recordRateLimit(K1, 'gemini-2.5-pro', 10_000); // until = now+10_000
    now += 5_000;
    p.recordRateLimit(K1, 'gemini-2.5-pro', 30_000); // newUntil = now+30_000 = t+35_000, > existing t+10_000
    now += 1;
    // Should still be on cooldown
    expect(p.pick('gemini-2.5-pro').key).toBe(K2);
  });
});
