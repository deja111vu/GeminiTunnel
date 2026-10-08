#!/usr/bin/env node
// CLI entry point. Mirrors the admin API in shape: `tunnel login|list|remove|
// refresh|quota`. Reuses the same modules the server uses (Store, Refresher,
// finalizeLogin) so behaviour stays in sync.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createStore, type Store } from '../accounts/store.js';
import { TokenRefresher } from '../accounts/refresher.js';
import type { RefresherLike } from '../accounts/pool.js';
import { addPending } from '../oauth/state.js';
import { buildAuthorizationUrl } from '../oauth/flow.js';
import { finalizeLogin } from '../oauth/finalize.js';

function usage(): never {
  console.error(`Usage: tunnel <command> [args]

Commands:
  login [label]      OAuth login flow (prints URL, reads code from stdin)
  list               List accounts (id, email, tier, status, last_used)
  remove <id>        Remove an account
  refresh <id>       Force a token refresh (bypasses the cache)
  quota <id>         Show quota snapshots + 429 events (last 24h)
`);
  process.exit(2);
}

export function parseId(s: string | undefined): number {
  if (s === undefined || !/^\d+$/.test(s)) usage();
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) usage();
  return n;
}

export function fmtTime(t: number | null | undefined): string {
  if (t == null) return '—';
  return new Date(t).toISOString();
}

async function readCode(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (a) => resolve(a.trim()));
      // rl.question never resolves on EOF without '\n' — fall through
      // to 'close' so a piped/closed stdin doesn't hang forever.
      rl.once('close', () => resolve(''));
    });
  } finally {
    rl.close();
  }
}

async function cmdLogin(store: Store, label: string): Promise<void> {
  const { url, state, verifier, accountLabel } = buildAuthorizationUrl({ accountLabel: label });
  try {
    addPending({ state, verifier, accountLabel });
  } catch (err) {
    throw new Error(`could not start login: ${(err as Error).message}`);
  }
  console.log(url);
  const code = await readCode('\nPaste the code from the callback URL: ');
  if (!code) throw new Error('no code provided');
  const acc = await finalizeLogin({ state, code, store, encryptionKey: config.accountsEncryptionKey });
  console.log(`\nadded account #${acc.id} (${acc.email})`);
}

function cmdList(store: Store): void {
  const rows = store.listAccounts();
  if (!rows.length) {
    console.log('No accounts yet — run `tunnel login <label>`');
    return;
  }
  console.log(
    ['id', 'email', 'tier', 'status', 'last_used', 'cooldown_until']
      .map((h) => h.padEnd(20))
      .join(''),
  );
  for (const a of rows) {
    const tier = a.tierName ?? a.tierId ?? '—';
    console.log(
      [
        String(a.id),
        a.email,
        tier,
        a.status,
        fmtTime(a.lastUsedAt),
        fmtTime(a.cooldownUntil),
      ]
        .map((s) => s.padEnd(20))
        .join(''),
    );
  }
}

function cmdRemove(store: Store, id: number): void {
  if (!store.getAccount(id)) throw new Error(`account #${id} not found`);
  store.removeAccount(id);
  console.log(`removed #${id}`);
}

async function cmdRefresh(refresher: RefresherLike, store: Store, id: number): Promise<void> {
  const token = await refresher.forceRefresh(id);
  // Read expiry back from the store so the operator sees the same diagnostic
  // they used to get pre-d15a927; the refresher writes the new expiresAt
  // atomically with the access token in setActiveToken.
  const expiresAt = store.getAccount(id)?.tokenExpiresAt ?? null;
  console.log(
    `refreshed #${id}; new access token expires at ${fmtTime(expiresAt)} (length=${token.length})`,
  );
}

function cmdQuota(store: Store, id: number): void {
  const acc = store.getAccount(id);
  if (!acc) throw new Error(`account #${id} not found`);
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const snaps = store.listLatestQuotaSnapshots(id);
  const events = store.listRecentQuotaEvents(id, sinceMs);
  console.log(`#${id} ${acc.email} (${acc.tierName ?? acc.tierId ?? '—'})`);
  console.log('\nLatest snapshots:');
  if (!snaps.length) console.log('  (none)');
  for (const s of snaps) {
    console.log(`  ${s.model.padEnd(20)} ${String(s.remaining).padStart(6)} / ${s.limitTotal}   reset ${fmtTime(s.resetAt)}`);
  }
  console.log('\n429 events (24h):');
  if (!events.length) console.log('  (none)');
  for (const e of events) {
    console.log(`  ${fmtTime(e.createdAt)}  ${e.model.padEnd(20)}  reset ${fmtTime(e.resetAt)}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  // Validate the command BEFORE opening the DB so a `tunnel` / `tunnel bogus`
  // call doesn't create a data directory as a side effect.
  if (!cmd || !['login', 'list', 'remove', 'refresh', 'quota'].includes(cmd)) {
    usage();
  }
  const store = createStore(config.dataDir, config.accountsEncryptionKey);
  const refresher = new TokenRefresher(store, config.accountsEncryptionKey);
  try {
    switch (cmd) {
      case 'login':
        await cmdLogin(store, rest[0] ?? 'default');
        break;
      case 'list':
        cmdList(store);
        break;
      case 'remove':
        cmdRemove(store, parseId(rest[0]));
        break;
      case 'refresh':
        await cmdRefresh(refresher, store, parseId(rest[0]));
        break;
      case 'quota':
        cmdQuota(store, parseId(rest[0]));
        break;
    }
  } finally {
    store.close();
  }
}

// Only auto-run when this module is the entry point. Without this
// guard, `import './bin.js'` from a test would immediately execute
// `main(process.argv.slice(2))` against the vitest runner's argv.
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main(process.argv.slice(2)).then(
    () => {
      // Success — exit 0. Errors are already surfaced by the .catch below.
    },
    (err) => {
      // Log the structured failure server-side for observability, then
      // print a one-line human message to stderr. Do NOT also console.log
      // the full error — that double-writes the same thing and pollutes
      // stdout (which the caller may be piping).
      logger.error({ err: (err as Error).message }, 'cli: command failed');
      process.stderr.write(`\nError: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
