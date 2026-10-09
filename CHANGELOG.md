<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to gemini-tunnel are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-10-09

Параллельный с OAuth путь для **Google Gemini API key**
([aistudio.google.com/apikey](https://aistudio.google.com/apikey)). Без
OAuth, без браузерного логина, без хранилища refresh-токенов — только
ключи из `GEMINI_API_KEYS`.

### Added — Key path

- **`GEMINI_API_KEYS`** — CSV из AIza-ключей в `.env`. Пусто или не
  задано — поведение прокси идентично 2.0.0 (только OAuth). Когда
  задано — параллельно работает второй путь, диспетчер выбирает
  между ним и OAuth по заголовку `x-goog-api-key: AIza…`.
- **`KeyPool`** — round-robin по ключам с монотонным seq-тай-брейком,
  per-model cooldown после 429, per-key «bad» состояние с TTL
  после 401/403/404, startup jitter (0–30 с) для распределения
  холодного старта между репликами.
- **`KeyClient`** — fetch-обёртка для OpenAI-совместимого endpoint
  `/v1beta/openai/chat/completions`. `Authorization: Bearer <key>` per
  OpenAI-compat spec. Корректная отмена через `AbortSignal` (слушатель
  в `streamChat` вызывает `reader.cancel()` — `it.return?.()` не
  прерывает `await reader.read()`).
- **`runKeyChat`** — `bodyCap → clientAuth → keyOrOAuth → route`. F6
  first-chunk pull: первый SSE-чанк прочитывается до отправки
  клиенту, чтобы upstream 4xx/5xx не превращался в 200 + trailing
  error chunk. `clearCooldown` вызывается после первого успешного
  чанка, чтобы per-model cooldown не отравил ключ при живом
  ответе.
- **`NoKeyAvailableError(reason, retryAfterMs)`** — типизированный
  ответ от `KeyPool.pick()` с минимальным cooldown/bad-expiry по пулу;
  транслируется в 503 + `Retry-After`.
- **KEY_RE** — единственный regex `/^AIza[a-zA-Z0-9_-]{39}$/`
  экспортируется из `keyConfig.ts`; `middleware.ts` его импортирует
  (без дрифта). Drift-тесты пинят форму regex по трём местам
  (keyConfig, middleware, config).
- **`/health`** расширен: при наличии `keyPool` отвечает
  `{status, service, upstreams: {oauth, apiKey}}` со сводкой
  размера пула и счётчиками bad/cooldown. `summaryForAllModels()`
  агрегирует состояние по всем ключам.
- **`UpstreamMisconfiguredError`** — типизированный класс для
  случаев «upstream вернул не то, что мы умеем обработать»
  (например, `Content-Type: application/json` от стрим-эндпоинта).
  Классифицируется как 502 fatal, не 500.
- **Redact paths** в pino расширены на `*.x-goog-api-key`,
  `*.X-Goog-Api-Key`, и case-варианты `Authorization`/`Cookie`
  заголовков. AIza-ключи в логах не появятся.
- **4 drift-теста** для `KEY_RE` + 7 unit-тестов на middleware
  диспетчер (валидный/невалидный заголовок, query string, fall-through,
  ordering с clientAuth).

### Changed

- **`/v1/chat/completions` dispatch** — добавлен `keyOrOAuth`
  middleware между `bodyCap` и существующим OAuth handler. Клиент
  выбирает путь заголовком; `Authorization: Bearer AIza…` без
  `x-goog-api-key` → OAuth (как раньше). `?key=AIza…` в URL →
  400 `key_in_query_string_forbidden` всегда, даже при выключенном
  key-пути.
- **`KeyClient`** использует `config.requestTimeoutMs` (ранее
  имел свой дефолт). Один таймаут на оба upstream-пути.
- **`config.ts`** хранит inline-копию KEY_RE, чтобы разорвать цикл
  module-init (config загружается раньше, чем `src/api/gemini/`);
  drift-тест пинит её форму.
- **CHANGELOG** и **README** обновлены.

### Security

- **AIza-ключи не попадают в URL-логи**: `?key=AIza…` всегда 400,
  в т.ч. при `KEY_PATH_ENABLED=false`. Только well-formed ключи
  отбиваются на query-строке — случайный `?key=foo` проходит
  (не security issue, regex публичен).
- **AbortSignal пробрасывается до upstream** — клиентский disconnect
  вызывает `reader.cancel()` в `KeyClient.streamChat`, а не только
  `it.return?.()` (который не прерывает `await reader.read()`).
  Раньше отмена могла «висеть» до фактического завершения стрима.
- **First-chunk safety** — `runKeyChat` не отдаёт 200 OK, пока не
  прочитан хотя бы один байт upstream-ответа; статус-коды
  401/403/404/408/422/429/5xx приходят как есть, без trailing
  error chunk. Network failures → 502 (не 500 — внутренняя ошибка
  нашего кода, а не upstream).
- **Per-model cooldown** — очищается сразу после первого
  успешного чанка, не дожидаясь завершения стрима. Иначе
  «удачливый» ключ мог бы остаться в cooldown пока клиент
  качает длинный ответ.
- **`logger.ts`** redacts: добавлены `x-goog-api-key`, `X-Goog-Api-Key`,
  case-варианты `authorization`/`cookie`. Полный список реэкспортирован
  из `request.headers.*`, так что любой регистр капса будет
  замаскирован.
- **`retriable` флаг** в `upstream_exhausted` — клиент с retry-budget
  знает, что 4xx retry не поможет (форма запроса неверна), а 5xx /
  network — стоит повторить.

### Notes

- **OpenAI-совместимый путь** — `/v1beta/openai/chat/completions`
  принимает `Authorization: Bearer <AIza-key>` (не `x-goog-api-key`).
  Это per spec, см.
  [ai.google.dev/gemini-api/docs/openai](https://ai.google.dev/gemini-api/docs/openai).
  Нативный Gemini API принимает оба варианта, OpenAI-compat — только
  `Authorization: Bearer`. `x-goog-api-key` оставлен на входе в
  прокси как client-facing форма для удобства (клиент не должен
  знать, что прокси внутри переписывает заголовок).
- **`KEY_PATH_ENABLED`** авто-определяется из `geminiApiKeys.length > 0`.
  Чтобы **отключить** key-путь при наличии ключей в env, оставьте
  поле пустым.
- **Миграция с 2.0.x** — обратно совместимо. `GEMINI_API_KEYS` пуст →
  прокси ведёт себя ровно как 2.0.0. Никаких breaking changes в
  контракте `/v1/*` (для OAuth клиентов), `/admin/*`, CLI, или
  Docker-образа.

## [2.0.0] - 2026-10-08

Full rewrite: from a single-account FastAPI proxy to a TypeScript/Node
multi-account OAuth proxy for Google Code Assist with an OpenAI-compatible
surface, admin SPA, CLI, Docker image, and a security-hardening pass.

### Added

- **Multi-account pool** with LRU + round-robin tie-break, atomic
  rate-limit transaction, circuit breaker (status, cooldown, ineligible),
  and aggregate refresh errors (`AccountPool`).
- **OAuth login flow** with PKCE, state-bounded pending set, encrypted
  refresh-token storage (AES-256-GCM), and account re-login.
- **OpenAI-compatible API** at `/v1/chat/completions` and `/v1/models`
  with SSE streaming, first-chunk-buffered so upstream 401/403/429/5xx
  surface as HTTP status (not trailing SSE error), and stable
  `chatcmpl-...` chunk ids correlated across deltas.
- **Admin SPA** (`/admin`) with bearer auth (rate-limit-aware), JSON API
  for accounts / quota / OAuth start+exchange, secure-by-default headers
  (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, no-store).
- **Admin auth cookie flow** (`/admin/api/login`): HttpOnly+Secure+
  SameSite=Strict cookie replaces localStorage so XSS can't exfil the
  admin token; Bearer header still accepted for curl scripts.
- **CLI** (`tunnel login|list|remove|refresh|quota`) with hermetic
  test coverage and `forceRefresh` that bypasses the access-token cache.
- **Quota poller** that polls `/retrieveUserQuota` per account every
  5 min by default, with first-immediate poll, in-flight guard, and
  SIGTERM-safe teardown.
- **Docker** multi-stage build pinned by digest, with
  `npm ci --ignore-scripts`, `npm audit --audit-level=high`, CycloneDX
  SBOM, and pruned devDeps in the runtime image.
- **Security hardening** covering 19 claude-security findings: pino
  redact, body cap on `/v1/*` and `/admin/api/*`, URL validation
  (https-only, no embedded credentials), transactional refresh-token
  rotation, `secure_delete = ON`, `wal_checkpoint(TRUNCATE)` on shutdown,
  source maps stripped, env-schema validation, and shutdown ordering
  (HTTP server closes before SQLite).

### Changed

- Stack migrated from Python/FastAPI to TypeScript/Node (>=22), Hono
  on `@hono/node-server`, `better-sqlite3` (WAL, foreign_keys,
  secure_delete), zod env validation, pino structured logging.
- Storage: SQLite replaces the previous flat-file token store.
- README rewritten with the new deployment posture (Docker compose +
  Caddy/TLS in front of the proxy).

### Removed

- Legacy FastAPI service and its Docker artifacts.
- Runtime `scripts/` copy from the Docker image.

### Security

- Cookies: HttpOnly + Secure + SameSite=Strict; `Path=/admin` so the
  cookie is only sent to admin routes.
- Body cap: 4 MiB on all POST routes; missing `Content-Length` on POST
  → 411; oversized → 413. Rejects before `c.req.json()` to prevent
  OOM via large bodies.
- Logs: `*.access_token`, `*.refresh_token`, `*.authorization`,
  `*.cookie`, `adminToken`, `accountsEncryptionKey`,
  `googleOauthClientSecret`, and nested `req.headers.*` are redacted
  in pino output.
- DB: `data.db`, `data.db-wal`, `data.db-shm` are chmod 0600; the
  sidecars are re-chmodded after every checkpoint and a
  `wal_checkpoint(TRUNCATE)` runs on SIGINT/SIGTERM.
- Dockerfile: base image pinned by digest
  (`node@sha256:c3de60bf…`); no `npx --yes` (cyclonedx pinned to
  `1.20.0`); devDeps pruned before the runtime COPY; `npm audit` runs
  on the full tree (no `--omit=dev`) and fails the build on
  `audit-level=high`.
- Server routes never echo user-controlled or upstream error text
  (state, code, exception messages) in response bodies.

### Notes

- The published deployment posture is `CLIENT_API_KEY` unset + TLS
  terminated in front (Caddy, Cloudflare Access, mTLS, etc.). With
  `CLIENT_API_KEY` set, the proxy requires `Authorization: Bearer …`
  on `/v1/*`.
- `.env.example` ships with placeholders that fail zod validation by
  design (F8 / F9): a fresh checkout cannot start the proxy without
  real secrets.
