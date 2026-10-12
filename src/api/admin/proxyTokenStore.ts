// proxyTokenStore.ts — in-memory mirror of the admin-set proxy access
// token. The /v1/* middleware reads from this mirror (cheap) instead
// of decrypting the row on every request. Admin API writes update
// both the DB (via the Store) and this mirror, in that order — the
// mirror is a cache, the DB is the source of truth.

export interface ProxyTokenStore {
  get(): string | undefined;
  set(token: string | undefined): void;
}

// Single shared instance. Tests reset the singleton in beforeEach
// to avoid cross-test bleed; the real app initializes the underlying
// value once at boot from the DB.
let singleton: ProxyTokenStore | null = null;

class InMemoryProxyTokenStore implements ProxyTokenStore {
  private current: string | undefined;

  get(): string | undefined {
    return this.current;
  }

  set(token: string | undefined): void {
    this.current = token;
  }
}

export function getProxyTokenStore(): ProxyTokenStore {
  if (!singleton) singleton = new InMemoryProxyTokenStore();
  return singleton;
}

// Test-only escape hatch: replace the singleton with a fresh store.
// Production code never calls this — the singleton is initialized
// once at boot from the DB.
export function resetProxyTokenStoreForTests(): void {
  singleton = null;
}
