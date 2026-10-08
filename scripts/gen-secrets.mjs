#!/usr/bin/env node
// gen-secrets.mjs — генератор секретов для деплоя.
// Ничего не отправляет в сеть. Ключи генерируются через node:crypto.
//
// Использование:
//   node scripts/gen-secrets.mjs            # печатает в stdout
//   node scripts/gen-secrets.mjs --out FILE  # пишет в файл (mode 0600, atomic)
//
// Печатает ACCOUNTS_ENCRYPTION_KEY + ADMIN_TOKEN (по 32 байта = 64 hex) и
// публичный gemini-cli OAuth secret. --out открывает файл через
// O_CREAT|O_EXCL (атомарный create), чтобы:
//   - не следовать по symlink в чужой путь;
//   - не перезаписывать уже существующий файл.

import { randomBytes } from 'node:crypto';
import {
  openSync,
  closeSync,
  writeFileSync,
  chmodSync,
  constants,
} from 'node:fs';
import { argv, exit, platform } from 'node:process';

const { O_CREAT, O_EXCL, O_WRONLY } = constants;

// ponytail: argv parsing accepting both `--out PATH` and `--out=PATH`,
// and rejecting a missing or dash-prefixed argument so a stray flag
// (`--out --version`) can't be turned into a file literally named
// "--version".
function parseOut() {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) {
        console.error('--out требует путь');
        exit(2);
      }
      return v;
    }
    if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length);
      if (!v) {
        console.error('--out= требует путь');
        exit(2);
      }
      return v;
    }
  }
  return null;
}

const hex = (n = 32) => randomBytes(n).toString('hex');

const block = `# Сгенерировано через scripts/gen-secrets.mjs
# ВАЖНО: НЕ коммитьте. Добавьте этот файл в .gitignore.
ACCOUNTS_ENCRYPTION_KEY=${hex()}
ADMIN_TOKEN=${hex()}

# Публичный gemini-cli OAuth app (см. README → OAuth client).
GOOGLE_OAUTH_CLIENT_SECRET=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
`;

const out = parseOut();
if (out) {
  // Атомарный create. O_EXCL гарантирует, что open упадёт, если путь
  // уже существует (включая symlink → чужой файл). Это закрывает
  // TOCTOU-окно между existsSync() и writeFileSync().
  let fd;
  try {
    fd = openSync(out, O_CREAT | O_EXCL | O_WRONLY, 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error(`отказываюсь перезаписывать существующий ${out}`);
      exit(1);
    }
    throw err;
  }
  try {
    writeFileSync(fd, block);
  } finally {
    closeSync(fd);
  }
  // writeFileSync на POSIX уже создал файл с mode из open(); chmodSync
  // тут — no-op. На Windows POSIX-режимы не поддерживаются, пропускаем.
  if (platform !== 'win32') {
    try { chmodSync(out, 0o600); } catch {}
  }
  console.error(`записано: ${out} (mode 0600)`);
  console.error('сохраните ключи в pass/1Password — содержимое файла больше не показывается');
  exit(0);
}

console.log(block);
console.error('---');
console.error('сохраните ключи в pass / 1Password / Vault');
console.error('перезапуск скрипта = новые ключи, старые больше не покажутся');
