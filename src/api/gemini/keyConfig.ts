// keyConfig.ts — pure parser for GEMINI_API_KEYS env var.
// CSV → trim → regex-validate → dedupe (by first occurrence).
// Used by config.ts (inline copy — config can't import from src/api/gemini/
// because config.ts is loaded at module-init time by every other module)
// and exposed here for unit testing in isolation.

const AIZA_PREFIX = 'AIza';
const KEY_BODY = '[a-zA-Z0-9_-]';
// Readonly RegExp: pinning the type and freezing the pattern prevents
// accidental global-flag mutation. Set.prototype preserves insertion order,
// so `new Set(...)` already gives us first-occurrence dedupe.
const KEY_RE: Readonly<RegExp> = new RegExp(`^${AIZA_PREFIX}${KEY_BODY}{39}$`);

export function parseApiKeys(envValue: string | undefined): readonly string[] {
  if (!envValue) return [];
  return [
    ...new Set(
      envValue
        .split(',')
        .map((s) => s.trim())
        .filter((s) => KEY_RE.test(s)),
    ),
  ];
}
