import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, type Store } from '../accounts/store.js';
import type { RefresherLike } from '../accounts/pool.js';
import { QuotaPoller } from './poller.js';

const KEY = 'a'.repeat(64);

// Mock the CodeAssistClient so the test doesn't hit the network. The
// test substitutes a fake client with the same shape as the real one.
class FakeClient {
  loadCodeAssist = vi.fn();
  retrieveUserQuota = vi.fn();
}

const fakeRefresher: RefresherLike = {
  getAccessToken: vi.fn(async (id: number) => `tok-${id}`),
  // forceRefresh isn't exercised by these tests but RefresherLike requires it.
  forceRefresh: vi.fn(async (id: number) => `tok-${id}`),
};

describe('QuotaPoller', () => {
  let tmp: string;
  let store: Store;
  let client: FakeClient;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gt-quota-'));
    store = createStore(tmp, KEY);
    client = new FakeClient();
    vi.useRealTimers();
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runOnce polls every active account, records one snapshot per model bucket', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    client.loadCodeAssist.mockResolvedValue({ cloudaicompanionProject: 'proj-1' });
    client.retrieveUserQuota.mockResolvedValue({
      buckets: [
        { modelId: 'gemini-2.5-pro', remainingAmount: 80, totalAmount: 100, resetTime: '2026-10-09T00:00:00Z' },
        { modelId: 'gemini-2.5-flash', remainingAmount: 950, totalAmount: 1000 },
      ],
    });
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    await poller.runOnce();

    const snaps = store.listLatestQuotaSnapshots(a.id);
    expect(snaps).toHaveLength(2);
    const pro = snaps.find((s) => s.model === 'gemini-2.5-pro')!;
    expect(pro.remaining).toBe(80);
    expect(pro.limitTotal).toBe(100);
    expect(pro.resetAt).toBe(new Date('2026-10-09T00:00:00Z').getTime());
    const flash = snaps.find((s) => s.model === 'gemini-2.5-flash')!;
    expect(flash.remaining).toBe(950);
    expect(flash.resetAt).toBeNull();
  });

  it('runOnce skips accounts whose status is not active (no fetch)', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    store.setStatus(a.id, 'invalid', 'invalid_grant');
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    await poller.runOnce();
    expect(client.loadCodeAssist).not.toHaveBeenCalled();
    expect(client.retrieveUserQuota).not.toHaveBeenCalled();
  });

  it('runOnce handles a missing cloudaicompanionProject by recording nothing and not throwing', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    client.loadCodeAssist.mockResolvedValue({}); // no cloudaicompanionProject
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    await poller.runOnce();
    expect(client.retrieveUserQuota).not.toHaveBeenCalled();
    expect(store.listLatestQuotaSnapshots(a.id)).toHaveLength(0);
  });

  it('runOnce skips buckets where the upstream did not report amounts (no false 0/0)', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    client.loadCodeAssist.mockResolvedValue({ cloudaicompanionProject: 'proj-1' });
    client.retrieveUserQuota.mockResolvedValue({
      // Two buckets, one valid and one with missing amounts. The latter
      // would otherwise be stored as remaining=0/total=0 and falsely
      // report the account as exhausted in the admin UI.
      buckets: [
        { modelId: 'gemini-2.5-pro', remainingAmount: 80, totalAmount: 100 },
        { modelId: 'gemini-2.5-flash' /* no amounts */ },
      ],
    });
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    await poller.runOnce();
    const snaps = store.listLatestQuotaSnapshots(a.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].model).toBe('gemini-2.5-pro');
  });

  it('runOnce polls accounts concurrently so a slow account does not block the batch', async () => {
    store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    store.addAccount({ email: 'b@e.com', refreshToken: 'rt' });
    const startedAt: number[] = [];
    const order: string[] = [];
    client.loadCodeAssist.mockImplementation(async (_md, tok) => {
      const which = tok === 'tok-1' ? 'a' : 'b';
      startedAt.push(Date.now());
      order.push(`start-${which}`);
      // a takes 100ms, b is instant
      if (which === 'a') await new Promise((r) => setTimeout(r, 100));
      order.push(`end-${which}`);
      return { cloudaicompanionProject: `proj-${which}` };
    });
    client.retrieveUserQuota.mockResolvedValue({
      buckets: [{ modelId: 'gemini-2.5-pro', remainingAmount: 50, totalAmount: 100 }],
    });
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    const t0 = Date.now();
    await poller.runOnce();
    // Both must START before either ends — the sequential version would
    // emit start-a, end-a, start-b, end-b.
    expect(order.indexOf('start-b')).toBeLessThan(order.indexOf('end-a'));
    expect(Date.now() - t0).toBeLessThan(200); // a's 100ms wait, not a+b
  });

  it('runOnce isolates failures: one failing account does not block the others', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    const b = store.addAccount({ email: 'b@e.com', refreshToken: 'rt' });
    client.loadCodeAssist.mockImplementation(async (_md, tok) => {
      if (tok === 'tok-1') throw new Error('network down');
      return { cloudaicompanionProject: 'proj-2' };
    });
    client.retrieveUserQuota.mockResolvedValue({
      buckets: [{ modelId: 'gemini-2.5-pro', remainingAmount: 5, totalAmount: 10 }],
    });
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    await poller.runOnce();
    // b succeeded even though a threw
    expect(store.listLatestQuotaSnapshots(b.id)).toHaveLength(1);
    expect(store.listLatestQuotaSnapshots(a.id)).toHaveLength(0);
  });

  it('start() schedules runOnce at the given interval; stop() clears it', async () => {
    const a = store.addAccount({ email: 'a@e.com', refreshToken: 'rt' });
    client.loadCodeAssist.mockResolvedValue({ cloudaicompanionProject: 'proj-3' });
    client.retrieveUserQuota.mockResolvedValue({
      buckets: [{ modelId: 'gemini-2.5-pro', remainingAmount: 50, totalAmount: 100 }],
    });
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 20 });
    poller.start();
    await new Promise((r) => setTimeout(r, 70));
    poller.stop();
    // ~3 ticks at 20ms; allow some slack for timer drift
    const calls = client.retrieveUserQuota.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(store.listLatestQuotaSnapshots(a.id)).toHaveLength(1);
  });

  it('stop() is a no-op when start was never called', () => {
    const poller = new QuotaPoller({ store, refresher: fakeRefresher, client: client as never, intervalMs: 999_999 });
    expect(() => poller.stop()).not.toThrow();
  });
});
