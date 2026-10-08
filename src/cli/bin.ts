#!/usr/bin/env node
// CLI entry point. Mirrors the admin API in shape: `tunnel login|list|remove|
// refresh|quota`. Reuses the same modules the server uses (Store, Refresher,
// finalizeLogin) so behaviour stays in sync.

import { createInterface } from 'node:readline';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createStore } from '../accounts/store.js';
import { TokenRefresher } from '../accounts/refresher.js';
import { addPending } from '../oauth/state.js';
import { buildAuthorizationUrl } from '../oauth/flow.js';
import { finalizeLogin } from '../oauth/finalize.js';

const STORE = createStore(config.dataDir, config.accountsEncryptionKey);
const REFRESHER = new TokenRefresher(STORE, config.accountsEncryptionKey);

function usage(): never {
  console.error(`Usage: tunnel <command> [args]

Commands:
  login [label]      OAuth login flow (prints URL, reads code from stdin)
  list               List accounts (id, email, tier, status, last_used)
  remove <id>        Remove an account
  refresh <id>       Force a token refresh
  quota <id>         Show quota snapshots + 429 events (last 24h)
`);
  process.exit(2);
}

async function readCode(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
  } finally {
    rl.close();
  }
}

async function cmdLogin(label: string): Promise<void> {
  const { url, state, verifier, accountLabel } = buildAuthorizationUrl({ accountLabel: label });
  addPending({ state, verifier, accountLabel });
  console.log(url);
  const code = await readCode('\nPaste the code from the callback URL: ');
  if (!code) throw new Error('no code provided');
  const acc = await finalizeLogin({ state, code, store: STORE, encryptionKey: config.accountsEncryptionKey });
  console.log(`\nadded account #${acc.id} (${acc.email})`);
}

function fmtTime(t: number | null): string {
  if (!t) return '—';
  return new Date(t).toISOString();
}

function cmdList(): void {
  const rows = STORE.listAccounts();
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

function cmdRemove(id: number): void {
  if (!STORE.getAccount(id)) throw new Error(`account #${id} not found`);
  STORE.removeAccount(id);
  console.log(`removed #${id}`);
}

async function cmdRefresh(id: number): Promise<void> {
  const token = await REFRESHER.getAccessToken(id);
  const acc = STORE.getAccount(id);
  console.log(
    `refreshed #${id}; new access token expires at ${fmtTime(acc?.tokenExpiresAt ?? null)} (length=${token.length})`,
  );
}

function cmdQuota(id: number): void {
  const acc = STORE.getAccount(id);
  if (!acc) throw new Error(`account #${id} not found`);
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const snaps = STORE.listLatestQuotaSnapshots(id);
  const events = STORE.listRecentQuotaEvents(id, sinceMs);
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

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'login':
      await cmdLogin(rest[0] ?? 'default');
      break;
    case 'list':
      cmdList();
      break;
    case 'remove': {
      const id = Number(rest[0]);
      if (!Number.isFinite(id)) usage();
      cmdRemove(id);
      break;
    }
    case 'refresh': {
      const id = Number(rest[0]);
      if (!Number.isFinite(id)) usage();
      await cmdRefresh(id);
      break;
    }
    case 'quota': {
      const id = Number(rest[0]);
      if (!Number.isFinite(id)) usage();
      cmdQuota(id);
      break;
    }
    default:
      usage();
  }
}

main(process.argv.slice(2)).then(
  () => STORE.close(),
  (err) => {
    logger.error({ err: (err as Error).message }, 'cli: command failed');
    console.error(`\nError: ${(err as Error).message}`);
    process.exit(1);
  },
);
