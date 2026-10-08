export interface PendingEntry {
  state: string;
  verifier: string;
  accountLabel: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
// Hard cap on the pending flow map. A real user adds one entry per OAuth
// round-trip; anything past this is either a stuck UI or a deliberate flood.
// The cap is enforced AFTER sweeping expired entries, so legitimate flow
// bursts inside the TTL window aren't blocked.
const MAX_ENTRIES = 1000;

const store = new Map<string, PendingEntry>();

function sweepExpired(now: number): void {
  for (const [k, e] of store) {
    if (now - e.createdAt > TTL_MS) store.delete(k);
  }
}

export function addPending(entry: Omit<PendingEntry, 'createdAt'>): void {
  const now = Date.now();
  sweepExpired(now);
  if (store.size >= MAX_ENTRIES) {
    throw new Error('too many in-flight OAuth flows; retry later');
  }
  store.set(entry.state, { ...entry, createdAt: now });
}

export function popPending(state: string): PendingEntry | null {
  const e = store.get(state);
  if (!e) return null;
  store.delete(state);
  if (Date.now() - e.createdAt > TTL_MS) return null;
  return e;
}

export function clearPending(): void {
  store.clear();
}

export function _pendingSize(): number {
  return store.size;
}
