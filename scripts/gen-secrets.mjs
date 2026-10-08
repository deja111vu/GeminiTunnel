#!/usr/bin/env node
// gen-secrets.mjs — генератор секретов для деплоя.
// Ничего не отправляет в сеть. Ключи генерируются через node:crypto.
//
// Использование:
//   node scripts/gen-secrets.mjs            # печатает в stdout
//   node scripts/gen-secrets.mjs --out .env.local  # пишет в файл (mode 0600)
//
// Печатает ACCOUNTS_ENCRYPTION_KEY + ADMIN_TOKEN (по 32 байта = 64 hex) и
// публичный gemini-cli OAuth secret. --out отказывается перезаписывать
// существующий файл, чтобы случайно не затереть уже вписанные ключи.

import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const hex = (n = 32) => randomBytes(n).toString('hex');

const block = `# Сгенерировано ${new Date().toISOString()} через scripts/gen-secrets.mjs
# ВАЖНО: НЕ коммитьте. Добавьте этот файл в .gitignore.
ACCOUNTS_ENCRYPTION_KEY=${hex()}
ADMIN_TOKEN=${hex()}

# Публичный gemini-cli OAuth app (см. README → OAuth client).
GOOGLE_OAUTH_CLIENT_SECRET=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
`;

const outIdx = argv.indexOf('--out');
if (outIdx !== -1) {
  const path = argv[outIdx + 1];
  if (!path) {
    console.error('--out требует путь');
    exit(2);
  }
  if (existsSync(path)) {
    console.error(`отказываюсь перезаписывать существующий ${path}`);
    exit(1);
  }
  writeFileSync(path, block, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows: POSIX-режимы недоступны */ }
  console.error(`записано: ${path} (mode 0600 где поддерживается)`);
  console.error('сохраните ключи в pass/1Password — содержимое файла больше не показывается');
  exit(0);
}

console.log(block);
console.error('---');
console.error('сохраните ключи в pass / 1Password / Vault');
console.error('перезапуск скрипта = новые ключи, старые больше не покажутся');
