// Copies the admin SPA HTML into dist/ after `tsc`, and also strips
// any .js.map files that a stale tsc with `sourceMap: true` left behind
// (F10). tsc only emits .ts files, so a vanilla HTML SPA would otherwise
// disappear from the production image; the destination mirrors the source
// layout (src/api/admin/ui.html → dist/api/admin/ui.html) so the prod
// server can resolve it via __dirname.
import { cpSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
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

// F10: production builds must not ship source maps. tsconfig sets
// `sourceMap: false` already, but a stale dist/ from a prior build
// (e.g. switching machines without `npm run clean`) can still carry
// `.js.map` files. Walk dist/ once and delete them.
const distDir = join(root, 'dist');
const stripMaps = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) stripMaps(p);
    else if (p.endsWith('.js.map')) unlinkSync(p);
  }
};
stripMaps(distDir);
