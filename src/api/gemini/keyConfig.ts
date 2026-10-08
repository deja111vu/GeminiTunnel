// keyConfig.ts — pure parser for GEMINI_API_KEYS env var.
// CSV → trim → regex-validate → dedupe (by first occurrence).
// Used by config.ts (inline copy — config can't import from src/api/gemini/
// because config.ts is loaded at module-init time by every other module)
// and exposed here for unit testing in isolation.

export const KEY_RE = /^AIza[a-zA-Z0-9_-]{39}$/;

export function parseApiKeys(envValue: string | undefined): string[] {
  if (!envValue) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of envValue.split(',')) {
    const v = raw.trim();
    if (!v) continue;
    if (!KEY_RE.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
