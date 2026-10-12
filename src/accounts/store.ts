import Database from 'better-sqlite3';
import { mkdirSync, openSync, closeSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { encrypt as enc, decrypt as dec } from './encryption.js';
import { keyIdFor } from '../api/gemini/keyConfig.js';

export type AccountStatus = 'active' | 'invalid' | 'ineligible';

export interface Account {
  id: number;
  email: string;
  tierId: string | null;
  tierName: string | null;
  status: AccountStatus;
  cooldownUntil: number | null;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  tokenExpiresAt: number | null;
  createdAt: number;
  onboardedAt: number | null;
}

export interface AddAccountArgs {
  email: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  tierId?: string;
  tierName?: string;
  onboardedAt?: number;
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  refresh_token_encrypted BLOB NOT NULL,
  access_token_encrypted BLOB,
  token_expires_at INTEGER,
  tier_id TEXT,
  tier_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cooldown_until INTEGER,
  last_used_at INTEGER,
  last_error_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  onboarded_at INTEGER
);

CREATE TABLE IF NOT EXISTS account_quota_events (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  reset_at INTEGER,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_quota_snapshots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  remaining INTEGER,
  limit_total INTEGER,
  reset_at INTEGER,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quota_events_account_time
  ON account_quota_events (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_account_time
  ON account_quota_snapshots (account_id, fetched_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL UNIQUE,
  key_ciphertext BLOB NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);

-- Singleton: stores the single admin-set Bearer token that guards /v1/*.
-- Absence => proxy is closed (every request 401s). The CHECK enforces the
-- one-row invariant at the DB layer in case anyone bypasses the Store API.
CREATE TABLE IF NOT EXISTS proxy_client_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_id TEXT NOT NULL,
  key_ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface Row {
  id: number;
  email: string;
  refresh_token_encrypted: Buffer;
  access_token_encrypted: Buffer | null;
  token_expires_at: number | null;
  tier_id: string | null;
  tier_name: string | null;
  status: AccountStatus;
  cooldown_until: number | null;
  last_used_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  created_at: number;
  onboarded_at: number | null;
}

function rowToAccount(r: Row): Account {
  return {
    id: r.id,
    email: r.email,
    tierId: r.tier_id,
    tierName: r.tier_name,
    status: r.status,
    cooldownUntil: r.cooldown_until,
    lastUsedAt: r.last_used_at,
    lastErrorAt: r.last_error_at,
    lastError: r.last_error,
    tokenExpiresAt: r.token_expires_at,
    createdAt: r.created_at,
    onboardedAt: r.onboarded_at,
  };
}

export interface QuotaEvent {
  model: string;
  resetAt: number | null;
  source: string;
  createdAt: number;
}

export interface QuotaSnapshot {
  model: string;
  remaining: number;
  limitTotal: number;
  resetAt: number | null;
  fetchedAt: number;
}

export interface ApiKey {
  id: number;
  label: string;
  keyId: string;
  enabled: boolean;
  createdAt: number;
  disabledAt: number | null;
}

export interface ApiKeyWithSecret extends ApiKey {
  key: string;
}

// Singleton: at most one admin-set proxy access token. The store
// treats the row as opaque to anyone who has not proven admin
// authority (UI / admin API); the runtime middleware only ever
// receives `getClientKeyWithSecret()`'s decrypted `key` field.
export interface ProxyClientKey {
  keyId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProxyClientKeyWithSecret extends ProxyClientKey {
  key: string;
}

export class ApiKeyConflictError extends Error {
  constructor(public readonly conflict: 'label_taken' | 'key_already_registered') {
    super(conflict);
  }
}

interface ApiKeyRow {
  id: number;
  label: string;
  key_id: string;
  key_ciphertext: Buffer;
  enabled: number;
  created_at: number;
  disabled_at: number | null;
}

function rowToApiKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    label: r.label,
    keyId: r.key_id,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    disabledAt: r.disabled_at,
  };
}

export interface Store {
  db: Database.Database;
  close: () => void;
  addAccount: (args: AddAccountArgs) => Account;
  getAccount: (id: number) => Account | null;
  getAccountByEmail: (email: string) => Account | null;
  listAccounts: () => Account[];
  removeAccount: (id: number) => void;
  setActiveToken: (id: number, accessToken: string, expiresAt: number) => void;
  setStatus: (id: number, status: AccountStatus, lastError?: string) => void;
  setCooldown: (id: number, until: number) => void;
  touchUsed: (id: number) => void;
  recordQuotaEvent: (accountId: number, model: string, source: '429' | 'poll', resetAt?: number) => void;
  recordQuotaSnapshot: (
    accountId: number,
    model: string,
    remaining: number,
    limitTotal: number,
    resetAt?: number,
    fetchedAt?: number,
  ) => void;
  listRecentQuotaEvents: (accountId: number, sinceMs: number) => QuotaEvent[];
  listLatestQuotaSnapshots: (accountId: number) => QuotaSnapshot[];
  hasRefreshToken: (id: number) => boolean;
  readActiveRefreshToken: (id: number) => string | null;
  readActiveAccessToken: (id: number) => { token: string; expiresAt: number } | null;
  addApiKey: (label: string, key: string) => ApiKey;
  listApiKeys: () => ApiKey[];
  listApiKeysWithSecret: () => ApiKeyWithSecret[];
  getApiKeyWithSecret: (id: number) => ApiKeyWithSecret | null;
  removeApiKey: (id: number) => boolean;
  setApiKeyEnabled: (id: number, enabled: boolean) => ApiKey | null;
  seedApiKeysFromEnv: (keys: readonly string[]) => number;
  getClientKey: () => ProxyClientKey | null;
  getClientKeyWithSecret: () => ProxyClientKeyWithSecret | null;
  setClientKey: (key: string) => ProxyClientKey;
  clearClientKey: () => boolean;
  seedClientKeyFromEnv: (key: string | undefined) => boolean;
}

export function createStore(dataDir: string, encryptionKeyHex: string = ''): Store {
  // Restrictive permissions: data dir 0700, db file + WAL/SHM sidecars 0600.
  // On Windows these are no-ops for NTFS DACLs; the data dir is expected to
  // live under the user's profile.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'data.db');
  try {
    // 'a+' creates if missing (applying the mode) and opens if existing; we
    // re-chmod below to cover the existing-file case.
    const fd = openSync(dbPath, 'a+', 0o600);
    closeSync(fd);
  } catch {
    // file system refused to open — let better-sqlite3 surface the error
  }
  // Re-apply 0o600 unconditionally: covers both the just-created case and
  // pre-existing files from an earlier deployment with looser perms.
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // ignore — non-fatal, but log-worthy
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // F16: secure_delete=ON zeroes out freed pages before reuse. FAST only
  // zeroes pages in rollback journals; with WAL mode the journal file is
  // persistent on disk and pages there can linger indefinitely otherwise.
  // Cost is a measurable (~5-15%) write slowdown, acceptable for this
  // workload (one row per refresh / quota event).
  db.pragma('secure_delete = ON');
  db.exec(MIGRATIONS);
  // better-sqlite3 creates data.db-wal and data.db-shm on first write;
  // tighten those to 0o600 too (WAL contains recent row pages, including
  // unencrypted-by-this-layer columns like email/status).
  const chmodSidecars = (): void => {
    for (const sibling of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(sibling)) {
        try {
          chmodSync(sibling, 0o600);
        } catch {
          // ignore — non-fatal
        }
      }
    }
  };
  chmodSidecars();

  const addAccountStmt = db.prepare(`
    INSERT INTO accounts (email, refresh_token_encrypted, access_token_encrypted, token_expires_at, tier_id, tier_name, onboarded_at, created_at)
    VALUES (@email, @rt, @at, @exp, @tierId, @tierName, @onboardedAt, @createdAt)
  `);
  const getByIdStmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const getByEmailStmt = db.prepare('SELECT * FROM accounts WHERE email = ?');
  const listStmt = db.prepare('SELECT * FROM accounts ORDER BY id ASC');
  const removeStmt = db.prepare('DELETE FROM accounts WHERE id = ?');
  const updateTokenStmt = db.prepare('UPDATE accounts SET access_token_encrypted=?, token_expires_at=? WHERE id=?');
  const updateStatusStmt = db.prepare('UPDATE accounts SET status=?, last_error_at=?, last_error=? WHERE id=?');
  const updateCooldownStmt = db.prepare('UPDATE accounts SET cooldown_until=? WHERE id=?');
  const touchUsedStmt = db.prepare('UPDATE accounts SET last_used_at=? WHERE id=?');
  const insertQuotaEventStmt = db.prepare(
    'INSERT INTO account_quota_events (account_id, model, reset_at, source, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertQuotaSnapshotStmt = db.prepare(
    'INSERT INTO account_quota_snapshots (account_id, model, remaining, limit_total, reset_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const listQuotaEventsStmt = db.prepare(
    'SELECT model, reset_at, source, created_at FROM account_quota_events WHERE account_id=? AND created_at>=? ORDER BY created_at DESC',
  );
  const listLatestSnapshotsStmt = db.prepare(
    `SELECT model, remaining, limit_total, reset_at, fetched_at FROM account_quota_snapshots
     WHERE account_id=? AND id IN (SELECT MAX(id) FROM account_quota_snapshots WHERE account_id=? GROUP BY model)
     ORDER BY model`,
  );

  const hasRefreshStmt = db.prepare(
    'SELECT 1 FROM accounts WHERE id=? AND refresh_token_encrypted IS NOT NULL',
  );

  const insertApiKeyStmt = db.prepare(`
    INSERT INTO api_keys (label, key_id, key_ciphertext, enabled, created_at, disabled_at)
    VALUES (@label, @keyId, @ciphertext, @enabled, @createdAt, @disabledAt)
  `);
  const listApiKeysStmt = db.prepare('SELECT * FROM api_keys ORDER BY id ASC');
  const getApiKeyStmt = db.prepare('SELECT * FROM api_keys WHERE id = ?');
  const apiKeyLabelExistsStmt = db.prepare('SELECT 1 FROM api_keys WHERE label = ?');
  const apiKeyIdExistsStmt = db.prepare('SELECT 1 FROM api_keys WHERE key_id = ?');
  const removeApiKeyStmt = db.prepare('DELETE FROM api_keys WHERE id = ?');
  const setApiKeyEnabledStmt = db.prepare(
    'UPDATE api_keys SET enabled = ?, disabled_at = ? WHERE id = ?',
  );
  const countApiKeysStmt = db.prepare('SELECT COUNT(*) AS n FROM api_keys');

  // proxy_client_key: UPSERT keeps the singleton invariant (id=1). When the
  // row exists, REPLACE drops the old ciphertext atomically; when it does
  // not, REPLACE behaves as INSERT. Either way the CHECK(id=1) is satisfied.
  const upsertClientKeyStmt = db.prepare(`
    INSERT OR REPLACE INTO proxy_client_key (id, key_id, key_ciphertext, created_at, updated_at)
    VALUES (1, @keyId, @ciphertext, @createdAt, @updatedAt)
  `);
  const getClientKeyStmt = db.prepare('SELECT key_id, created_at, updated_at FROM proxy_client_key WHERE id = 1');
  const getClientKeyWithSecretStmt = db.prepare('SELECT key_id, key_ciphertext, created_at, updated_at FROM proxy_client_key WHERE id = 1');
  const clearClientKeyStmt = db.prepare('DELETE FROM proxy_client_key WHERE id = 1');

  const requireKey = (): void => {
    if (!encryptionKeyHex) throw new Error('encryption key required for write ops');
  };

  return {
    db,
    close: () => {
      // F16: checkpoint TRUNCATE before close so the WAL file is folded
      // into the main DB and the on-disk sidecar is zero-length instead
      // of holding the last few KB of recent pages. The chmod pass after
      // the checkpoint re-tightens the freshly-truncated (and therefore
      // freshly-created) WAL file. F19: also re-chmod for the normal
      // case where a checkpoint ran without truncation.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // ignore — close() must not throw
      }
      chmodSidecars();
      db.close();
    },

    addAccount(args) {
      requireKey();
      const rt = enc(args.refreshToken, encryptionKeyHex);
      const at = args.accessToken ? enc(args.accessToken, encryptionKeyHex) : null;
      const now = Date.now();
      const info = addAccountStmt.run({
        email: args.email,
        rt,
        at,
        exp: args.expiresAt ?? null,
        tierId: args.tierId ?? null,
        tierName: args.tierName ?? null,
        onboardedAt: args.onboardedAt ?? null,
        createdAt: now,
      });
      return this.getAccount(Number(info.lastInsertRowid))!;
    },

    getAccount(id) {
      const r = getByIdStmt.get(id) as Row | undefined;
      return r ? rowToAccount(r) : null;
    },

    getAccountByEmail(email) {
      const r = getByEmailStmt.get(email) as Row | undefined;
      return r ? rowToAccount(r) : null;
    },

    listAccounts() {
      const rows = listStmt.all() as Row[];
      return rows.map(rowToAccount);
    },

    removeAccount(id) {
      removeStmt.run(id);
    },

    setActiveToken(id, accessToken, expiresAt) {
      requireKey();
      updateTokenStmt.run(enc(accessToken, encryptionKeyHex), expiresAt, id);
    },

    setStatus(id, status, lastError) {
      updateStatusStmt.run(status, lastError ? Date.now() : null, lastError ?? null, id);
    },

    setCooldown(id, until) {
      updateCooldownStmt.run(until, id);
    },

    touchUsed(id) {
      touchUsedStmt.run(Date.now(), id);
    },

    recordQuotaEvent(accountId, model, source, resetAt) {
      insertQuotaEventStmt.run(accountId, model, resetAt ?? null, source, Date.now());
    },

    recordQuotaSnapshot(accountId, model, remaining, limitTotal, resetAt, fetchedAt) {
      insertQuotaSnapshotStmt.run(accountId, model, remaining, limitTotal, resetAt ?? null, fetchedAt ?? Date.now());
    },

    listRecentQuotaEvents(accountId, sinceMs) {
      const rows = listQuotaEventsStmt.all(accountId, sinceMs) as {
        model: string;
        reset_at: number | null;
        source: string;
        created_at: number;
      }[];
      return rows.map((r) => ({
        model: r.model,
        resetAt: r.reset_at,
        source: r.source,
        createdAt: r.created_at,
      }));
    },

    listLatestQuotaSnapshots(accountId) {
      const rows = listLatestSnapshotsStmt.all(accountId, accountId) as {
        model: string;
        remaining: number;
        limit_total: number;
        reset_at: number | null;
        fetched_at: number;
      }[];
      return rows.map((r) => ({
        model: r.model,
        remaining: r.remaining,
        limitTotal: r.limit_total,
        resetAt: r.reset_at,
        fetchedAt: r.fetched_at,
      }));
    },

    hasRefreshToken(id) {
      const r = hasRefreshStmt.get(id);
      return r !== undefined;
    },

    readActiveRefreshToken(id) {
      if (!encryptionKeyHex) return null;
      const r = getByIdStmt.get(id) as Row | undefined;
      if (!r) return null;
      return dec(r.refresh_token_encrypted, encryptionKeyHex).toString('utf8');
    },

    readActiveAccessToken(id) {
      if (!encryptionKeyHex) return null;
      const r = getByIdStmt.get(id) as Row | undefined;
      if (!r?.access_token_encrypted || r.token_expires_at == null) return null;
      return {
        token: dec(r.access_token_encrypted, encryptionKeyHex).toString('utf8'),
        expiresAt: r.token_expires_at,
      };
    },

    addApiKey(label, key) {
      requireKey();
      const keyId = keyIdFor(key);
      if (apiKeyLabelExistsStmt.get(label)) throw new ApiKeyConflictError('label_taken');
      if (apiKeyIdExistsStmt.get(keyId)) throw new ApiKeyConflictError('key_already_registered');
      const now = Date.now();
      const info = insertApiKeyStmt.run({
        label,
        keyId,
        ciphertext: enc(key, encryptionKeyHex),
        enabled: 1,
        createdAt: now,
        disabledAt: null,
      });
      return {
        id: Number(info.lastInsertRowid),
        label,
        keyId,
        enabled: true,
        createdAt: now,
        disabledAt: null,
      };
    },

    listApiKeys() {
      return (listApiKeysStmt.all() as ApiKeyRow[]).map(rowToApiKey);
    },

    listApiKeysWithSecret() {
      if (!encryptionKeyHex) return [];
      return (listApiKeysStmt.all() as ApiKeyRow[]).map((r) => ({
        ...rowToApiKey(r),
        key: dec(r.key_ciphertext, encryptionKeyHex).toString('utf8'),
      }));
    },

    getApiKeyWithSecret(id) {
      if (!encryptionKeyHex) return null;
      const r = getApiKeyStmt.get(id) as ApiKeyRow | undefined;
      if (!r) return null;
      return {
        ...rowToApiKey(r),
        key: dec(r.key_ciphertext, encryptionKeyHex).toString('utf8'),
      };
    },

    removeApiKey(id) {
      return removeApiKeyStmt.run(id).changes > 0;
    },

    setApiKeyEnabled(id, enabled) {
      const existing = getApiKeyStmt.get(id) as ApiKeyRow | undefined;
      if (!existing) return null;
      const disabledAt = enabled ? null : Date.now();
      setApiKeyEnabledStmt.run(enabled ? 1 : 0, disabledAt, id);
      return { ...rowToApiKey(existing), enabled, disabledAt };
    },

    seedApiKeysFromEnv(keys) {
      if (keys.length === 0) return 0;
      const { n } = countApiKeysStmt.get() as { n: number };
      if (n > 0) return 0;
      let inserted = 0;
      for (let i = 0; i < keys.length; i++) {
        try {
          this.addApiKey(`boot:${i}`, keys[i]);
          inserted++;
        } catch {
          // duplicate label/keyId — skip, do not abort the seed
        }
      }
      return inserted;
    },

    getClientKey() {
      const r = getClientKeyStmt.get() as { key_id: string; created_at: number; updated_at: number } | undefined;
      if (!r) return null;
      return { keyId: r.key_id, createdAt: r.created_at, updatedAt: r.updated_at };
    },

    getClientKeyWithSecret() {
      if (!encryptionKeyHex) return null;
      const r = getClientKeyWithSecretStmt.get() as
        | { key_id: string; key_ciphertext: Buffer; created_at: number; updated_at: number }
        | undefined;
      if (!r) return null;
      return {
        keyId: r.key_id,
        key: dec(r.key_ciphertext, encryptionKeyHex).toString('utf8'),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    },

    setClientKey(key) {
      requireKey();
      const now = Date.now();
      // Preserve created_at across rotations; only updated_at moves forward.
      const existing = getClientKeyStmt.get() as { created_at: number } | undefined;
      const createdAt = existing?.created_at ?? now;
      upsertClientKeyStmt.run({
        keyId: keyIdFor(key),
        ciphertext: enc(key, encryptionKeyHex),
        createdAt,
        updatedAt: now,
      });
      return { keyId: keyIdFor(key), createdAt, updatedAt: now };
    },

    clearClientKey() {
      return clearClientKeyStmt.run().changes > 0;
    },

    seedClientKeyFromEnv(key) {
      if (!key) return false;
      // Same one-shot semantics as seedApiKeysFromEnv: the operator's
      // explicit env value gets installed exactly once; thereafter the
      // admin UI owns the row.
      if (getClientKeyStmt.get()) return false;
      this.setClientKey(key);
      return true;
    },
  };
}
