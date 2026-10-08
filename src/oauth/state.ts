export interface PendingEntry {
  state: string;
  verifier: string;
  accountLabel: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const store = new Map<string, PendingEntry>();

export function addPending(entry: Omit<PendingEntry, 'createdAt'>): void {
  store.set(entry.state, { ...entry, createdAt: Date.now() });
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
