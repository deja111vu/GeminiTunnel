# Changelog

All notable changes to gemini-tunnel are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
