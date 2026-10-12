// proxyTokenStore.ts — in-memory mirror of the admin-set proxy access
// token. The /v1/* middleware reads from this mirror (cheap) instead
// of decrypting the row on every request. Admin API writes update
// both the DB (via the Store) and this mirror, in that order — the
// mirror is a cache, the DB is the source of truth.

import type { Store } from '../../accounts/store.js';

export interface ProxyTokenStore {
  get(): string | undefined;
  set(token: string | undefined): void;
}

// Single shared instance. Tests reset the singleton in beforeEach
// to avoid cross-test bleed; the real app seeds the underlying value
// once at boot via `seedProxyTokenStore` (DB row, then
// CLIENT_API_KEY env var, then nothing).
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
// Production code never calls this — the singleton is seeded once
// at boot via `seedProxyTokenStore` (DB row, then CLIENT_API_KEY
// env var, then nothing).
export function resetProxyTokenStoreForTests(): void {
  singleton = null;
}

export type ProxyTokenSeedSource = 'db' | 'env' | 'unset';

export interface ProxyTokenSeedResult {
  source: ProxyTokenSeedSource;
  // keyId is set when source === 'db' (8 hex of SHA-256, from the
  // stored row). Env-seeded values are not yet in the DB and have
  // no keyId; unset values have no token at all.
  keyId?: string;
}

// Boot-time seed of the in-memory mirror. Precedence:
//
//   1. DB row (the source of truth after the first admin login),
//      if it has a non-empty key.
//   2. envClientKey (CLIENT_API_KEY env var; bootstrap hint only),
//      if it is set and non-empty.
//   3. nothing (proxy starts closed — /v1/* returns 401 until the
//      admin sets a token).
//
// An empty key in the DB is treated the same as "no DB row": the
// proxy's auth check is `if (!expected) return 401`, so an empty
// string would silently close the proxy while the seed reports
// source='db'. The same defensive check is applied to the env
// value.
//
// The env value is loaded into the mirror only — it is NOT
// persisted to the DB. The first admin-UI Generate/Rotate/Remove
// overwrites the env-derived value with a fresh one (which IS
// persisted). The behaviour differs from GEMINI_API_KEYS seeding
// (which persists env keys to the DB via seedApiKeysFromEnv):
// proxy-token rotation is expected to be rare and operator-driven
// from the admin UI, so re-seeding the mirror from the env on
// every boot is friendlier than forcing the operator to DELETE the
// DB row before the new env value takes effect.
export function seedProxyTokenStore(
  store: Pick<Store, 'getClientKeyWithSecret'>,
  envClientKey: string | undefined,
  mirror: ProxyTokenStore,
): ProxyTokenSeedResult {
  const dbKey = store.getClientKeyWithSecret();
  if (dbKey && dbKey.key) {
    mirror.set(dbKey.key);
    return { source: 'db', keyId: dbKey.keyId };
  }
  if (envClientKey) {
    mirror.set(envClientKey);
    return { source: 'env' };
  }
  return { source: 'unset' };
}
