// Copies the admin SPA HTML into dist/ after `tsc`. tsc only emits .ts
// files, so a vanilla HTML SPA would otherwise disappear from the
// production image. The destination mirrors the source layout
// (src/api/admin/ui.html → dist/api/admin/ui.html) so the prod server
// can resolve it via __dirname.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pairs = [
  ['src/api/admin/ui.html', 'dist/api/admin/ui.html'],
];
for (const [src, dst] of pairs) {
  const from = join(root, src);
  const to = join(root, dst);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  console.log(`copied ${src} -> ${dst}`);
}
