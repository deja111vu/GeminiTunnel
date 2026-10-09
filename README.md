# 🚀 Gemini Tunnel

OpenAI-совместимый прокси для **Google Code Assist / Gemini API** с поддержкой
мультиаккаунта. Разворачивается на VPS в стране с доступом к Google API, после
чего OpenAI-клиенты (Claude Code, Cline, Cursor и т.д.) подключаются к
`http://VPS:8000/v1` и получают Gemini Pro/Flash ответы.

Если у вас несколько Google-аккаунтов с подпиской — прокси
автоматически переключается между ними при 429 и равномерно
распределяет нагрузку.

## ✨ Возможности

- 🔐 **OAuth 2.0 + PKCE** — каждый аккаунт логинится через браузер,
  refresh-токены шифруются AES-256-GCM и лежат в локальной SQLite.
- 🧠 **OpenAI-совместимый API** — `POST /v1/chat/completions`,
  `GET /v1/models`, стриминг через SSE, tool calls, system prompt.
- 🔄 **Round-robin + LRU + circuit breaker** — несколько аккаунтов
  прозрачно для клиента. На 429 аккаунт уходит в cooldown на
  `COOLDOWN_AFTER_429_MS`, запрос летит на следующий.
- 📊 **Квоты и события** — фоновое опрашивание `/retrieveUserQuota`
  каждые 5 минут, история 429 на 7 дней, просмотр через Web UI.
- 🖥️ **Web UI на `/admin`** — список аккаунтов, квоты, статус, ручной
  refresh, удаление, запуск нового OAuth-логина. Авторизация через
  HttpOnly+Secure+SameSite=Strict cookie; Bearer-токен остался для
  curl-скриптов и тестов.
- 🛠️ **CLI `tunnel`** — то же самое из терминала: `login`, `list`,
  `remove`, `refresh`, `quota`. Удобно для SSH на VPS.
- 🐳 **Docker-ready** — один контейнер, том для БД, healthcheck,
  digest-pinned base image, `npm audit` на build, CycloneDX SBOM.
- 🪶 **Зависимости** — Node 22, `better-sqlite3`, `hono`, `pino`,
  `google-auth-library`. Никаких внешних сервисов.
- 🔑 **Gemini API key path (опционально)** — параллельно с OAuth
  можно подключить прямые AIza-ключи из [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
  Клиент выбирает путь заголовком `x-goog-api-key: AIza…`; без
  заголовка работает OAuth, как раньше. Round-robin по ключам,
  per-model cooldown, отмена через AbortSignal. См.
  [«Gemini API key path»](#-gemini-api-key-path-опционально).

## 🚀 Быстрый старт

### 1. Сгенерируйте ключи

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"  # ACCOUNTS_ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"  # ADMIN_TOKEN
```

### 2. Скопируйте `.env.example` в `.env` и заполните

```bash
cp .env.example .env
nano .env
```

Минимум нужно заменить:
- `ACCOUNTS_ENCRYPTION_KEY` — 64 hex символа
- `ADMIN_TOKEN` — 64 hex символа (для доступа к `/admin`)
- `GOOGLE_OAUTH_CLIENT_SECRET` — публичный секрет gemini-cli

### 3. Запустите

```bash
mkdir -p data
docker compose up -d --build
docker compose logs -f proxy   # Ctrl+C чтобы оторваться
```

Healthcheck:

```bash
curl http://localhost:8000/health
# {"status":"ok","service":"gemini-tunnel"}
```

### 4. Залогиньте первый аккаунт

```bash
docker compose exec proxy tunnel login personal
```

Скрипт напечатает URL вида `https://accounts.google.com/o/oauth2/v2/auth?...`.
Откройте его в браузере, дайте согласие, скопируйте `code=...` из
redirect-URL, вставьте в терминал. Повторите для второго/третьего
аккаунта.

Проверить:

```bash
docker compose exec proxy tunnel list
```

## 🔌 Подключение клиентов

Любой OpenAI-совместимый клиент, который позволяет задать `base_url`,
подключается так:

| Поле           | Значение                          |
|----------------|-----------------------------------|
| `base_url`     | `http://<VPS_IP>:8000/v1`         |
| `api_key`      | любой непустой (например `dummy`)  |
| `model`        | `gemini-2.5-pro`, `gemini-2.5-flash` |

Прокси использует свой Google OAuth — ключ клиента игнорируется.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://VPS_IP:8000
# Claude Code берёт api_key из env, можно любой
export ANTHROPIC_API_KEY=dummy
```

(либо через UI: Settings → API Key → Base URL)

### Cline (VS Code)

Settings → API Provider → **OpenAI Compatible**:
- Base URL: `http://VPS_IP:8000/v1`
- API Key: `dummy`
- Model ID: `gemini-2.5-pro`

### Cursor

Settings → Models → OpenAI API Key:
- Override OpenAI Base URL: `http://VPS_IP:8000/v1`
- API Key: `dummy`

## 🔑 Gemini API key path (опционально)

Параллельно с OAuth прокси умеет работать с прямыми ключами
[Google Gemini API](https://aistudio.google.com/apikey). Полезно,
когда не хочется логиниться через браузер или держать refresh-токены
в БД: задал `GEMINI_API_KEYS=AIza…,AIza…` — и готово.

### Что добавить в `.env`

```bash
# CSV из AIza-ключей. Пусто — key-путь выключен, прокси работает
# только в OAuth-режиме (поведение 2.0.x).
GEMINI_API_KEYS=AIzaSyAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,AIzaSyByyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy

# Cooldown per-key per-model после 429. По умолчанию 60с.
# KEY_COOLDOWN_AFTER_429_MS=60000

# TTL состояния "bad" для ключа после 401/403/404. По умолчанию 24ч.
# KEY_BAD_TTL_MS=86400000
```

### Как подключить клиент

Клиент выбирает путь заголовком. Без заголовка — OAuth, как раньше.

```bash
# Claude Code с key-путем: передаем AIza-ключ в x-goog-api-key
curl -X POST http://VPS_IP:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: AIzaSyAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}'
```

В OpenAI-клиентах, которые не позволяют задать произвольный заголовок
(Cline, Cursor, и т.п.), стандартный `api_key` всё равно уходит в
`Authorization: Bearer …` — прокси этот вариант игнорирует и
проваливается на OAuth. Для таких клиентов key-путь пока не
поддержан.

### Как это работает внутри

- **`KeyPool`** — round-robin по ключам, монотонный seq-тай-брейк
  при равном LRU. Per-model cooldown после 429 (по умолчанию
  60 с, ключ не выбирается для этой модели, но может выбираться
  для другой). Per-key «bad» состояние с TTL после 401/403/404
  (по умолчанию 24 ч). Startup jitter (0–30 с) — чтобы холодный
  старт нескольких реплик не отправлял все запросы в один ключ.
- **`KeyClient`** — fetch-обёртка для OpenAI-совместимого endpoint
  Google (`/v1beta/openai/chat/completions`). Ключ отправляется
  как `Authorization: Bearer <key>` per
  [OpenAI-compat spec](https://ai.google.dev/gemini-api/docs/openai).
  AbortSignal пробрасывается до upstream-ридера: клиентский
  disconnect вызывает `reader.cancel()` и не висит до конца стрима.
- **`runKeyChat`** — `bodyCap → clientAuth → keyOrOAuth → route`.
  First-chunk safety: первый SSE-чанк прочитывается до отправки
  клиенту, поэтому upstream 4xx/5xx приходит как HTTP-статус, а не
  как 200 OK + trailing error chunk. Cooldown снимается сразу после
  первого успешного чанка, не дожидаясь конца стрима.
- **`/health`** — при включённом key-пути возвращает агрегированную
  сводку:

  ```json
  {
    "status": "ok",
    "service": "gemini-tunnel",
    "upstreams": {
      "oauth": { "pool": 3, "active": 2, "cooldown": 1 },
      "apiKey": { "pool": 5, "active": 4, "bad": 1 }
    }
  }
  ```

### Безопасность

- **AIza-ключи в URL → 400**. Запрос с `?key=AIza…` всегда
  отбивается (даже при `KEY_PATH_ENABLED=false`), чтобы ключи
  не попадали в access-логи, browser history и referer.
- **AIza-ключи в логах → redact**. `x-goog-api-key` (и все
  регистры) добавлены в pino redact paths. `Authorization` тоже.
- **Один key-rotation цикл на запрос**. Если все ключи в cooldown
  или bad — 503 + `Retry-After`, без бесконечного перебора.
- **Обратно совместимо с 2.0.x**. `GEMINI_API_KEYS` пуст → прокси
  ведёт себя ровно как раньше. OAuth-клиенты не замечают изменений.

## 🏗 Архитектура

```
┌─────────────┐         ┌────────────────────────────────────┐         ┌────────────────────┐
│  Claude     │         │  gemini-tunnel  (VPS, port 8000)   │         │  Google Code Assist│
│  Code /     │  HTTP   │                                    │  HTTPS  │                    │
│  Cline /    │ ──────► │  ┌────────────┐    ┌────────────┐  │ ──────► │  cloudcode-pa.     │
│  Cursor     │  /v1/*  │  │ Hono router│───►│AccountPool │  │  OAuth  │  googleapis.com    │
│             │ ◄────── │  └────────────┘    │ (LRU/429)  │  │ ◄────── │                    │
│             │   SSE   │       │            └────────────┘  │  stream │  /v1internal:      │
│             │         │       │                  │         │         │  streamGenerate-   │
│             │         │       ▼                  ▼         │         │  Content           │
│             │         │  ┌────────────┐    ┌────────────┐  │         │                    │
│             │         │  │ SQLite     │    │TokenRefr.  │  │         │                    │
│             │         │  │ (AES-GCM)  │    │(refresh +  │  │         │                    │
│             │         │  │            │    │ cooldown)  │  │         │                    │
│             │         │  └────────────┘    └────────────┘  │         │                    │
│             │         │  ┌────────────┐    ┌────────────┐  │         └────────────────────┘
│             │         │  │QuotaPoller │    │   /admin   │  │
│             │         │  │ (5min)     │    │   Web UI   │  │
│             │         │  └────────────┘    └────────────┘  │
└─────────────┘         └────────────────────────────────────┘
```

- **Hono router** — единственный HTTP entry point, валидирует zod-схемы.
- **AccountPool** — на каждый запрос выбирает активный аккаунт по LRU
  + in-memory tie-breaker, выдаёт действующий access-токен. На 429
  ставит аккаунт в cooldown (через SQLite) и переключается.
- **TokenRefresher** — `google-auth-library` обновляет access-токен
  по `refresh_token` с 60-секундным leeway до истечения. Хранит
  refresh-токены только в зашифрованном виде.
- **QuotaPoller** — раз в `QUOTA_POLL_INTERVAL_MS` опрашивает каждый
  активный аккаунт, пишет строки в `account_quota_snapshots` для UI.
- **SQLite (WAL)** — единственное постоянное хранилище. Refresh-токены
  шифруются AES-256-GCM с `ACCOUNTS_ENCRYPTION_KEY` (12-байт IV,
  формат `iv ‖ ciphertext ‖ tag`).

## 🔐 Безопасность

1. **`ACCOUNTS_ENCRYPTION_KEY`** — самое важное. Потеряли = потеряли
   все аккаунты, придётся перелогинивать. Храните в секрет-менеджере
   (1Password, Vault, AWS Secrets Manager), **не в git**.
2. **`ADMIN_TOKEN`** — токен для `/admin` и `/admin/api/*`.
   Проверяется через `crypto.timingSafeEqual`, а не `===`. UI
   передаёт его через HttpOnly+Secure+SameSite=Strict cookie
   (XSS не может прочитать), Bearer-заголовок остался для curl и
   тестов.
3. **`/admin` сам по себе — не панель без пароля.** Без валидной
   сессии отдаёт 401 + `WWW-Authenticate`. UI не хранит токен в
   `localStorage`.
4. **UFW / iptables** — ограничьте 8000-й порт по IP. Cloudflare
   Tunnel — хороший способ спрятать origin.
5. **HTTPS** — обязателен, если клиент не в локальной сети. Самый
   простой путь: поставить прокси за Cloudflare Tunnel или Caddy.
   Cookie-флаги (`Secure`) рассчитаны на это.
6. **Refresh-token rotation** — Google при каждом refresh может
   выдать новый `refresh_token`; прокси записывает его обратно
   в БД атомарно с новым access-токеном через `db.transaction()`,
   чтобы SIGKILL между записями не оставил пару «новый access +
   старый refresh» (невалидный на следующем refresh).
7. **OAuth state TTL** — pending-флоу хранятся 10 минут, и не более
   1000 одновременно (защита от DoS).
8. **Quota polling — read-only** — QuotaPoller использует только
   `loadCodeAssist` и `retrieveUserQuota`, ничего не пишет в аккаунт.
9. **Файловые права** — на Linux `data/` создаётся 0o700, `*.db`,
   `*.db-wal`, `*.db-shm` — 0o600 (sidecars пере-chmod-ятся после
   каждого checkpoint). На Windows — наследуются от пользователя,
   запустившего контейнер.
10. **Body cap** — все POST (`/v1/*` и `/admin/api/*`) ограничены
    4 МиБ; без `Content-Length` на POST — 411; сверх лимита — 413.
    Проверка отрабатывает до `c.req.json()`, чтобы 200 МБ тело не
    попало в V8.
11. **Логи безопасно redact-ятся** — pino вырезает
    `*.access_token`, `*.refresh_token`, `*.authorization`,
    `*.cookie`, `adminToken`, `accountsEncryptionKey`,
    `googleOauthClientSecret` и вложенные `req.headers.*`.
12. **WAL durability** — SQLite в режиме WAL с `secure_delete = ON`
    (zeroes freed pages), `wal_checkpoint(TRUNCATE)` +
    re-chmod sidecars на SIGINT/SIGTERM. Никаких страниц с
    access-токенами, оставшихся на диске после штатной остановки.
13. **Docker-образ** — базовый image прибит по digest, `npm ci
    --ignore-scripts` (только `better-sqlite3` rebuild из source
    под контролируемым toolchain), devDeps вычищаются до копирования
    в runtime-стадию, `npm audit --audit-level=high` валит сборку
    на известной CVE, source maps не попадают в dist.

## 🩺 Troubleshooting

### `invalid_grant` при refresh

Refresh-токен отозван (пользователь сбросил пароль, удалил
приложение, прошло 6 месяцев неактивности). Решение:
`docker compose exec proxy tunnel remove <id> && tunnel login
<label>`.

### `429 Too Many Requests` на все аккаунты

- Подождите `COOLDOWN_AFTER_429_MS` (по умолчанию 60 секунд).
- Добавьте больше аккаунтов: каждый аккаунт = отдельная квота.
- Проверьте, не накопились ли «свежие» аккаунты с 0 квотой:
  `tunnel quota <id>`.

### `No active account available`

Все аккаунты либо в cooldown, либо в `invalid`/`ineligible`.
Проверьте `tunnel list` — колонка `status` покажет, что случилось.
Самые частые причины: `invalid` (refresh-токен умер) или `ineligible`
(аккаунт не имеет Code Assist).

### `Config validation failed: ADMIN_TOKEN: 64 hex chars (32 bytes)`

В `.env` лежит не 64-символьная hex-строка. Сгенерируйте заново
командой из раздела «Быстрый старт».

### `Container is unhealthy`

`docker compose logs proxy` покажет причину. Самые частые:
- Не указан `GOOGLE_OAUTH_CLIENT_SECRET` → процесс падает на старте.
- Порт 8000 уже занят на хосте → измените `ports:` в compose.
- `data/` принадлежит root, а контейнер работает под `node` →
  `sudo chown -R 1000:1000 data/`.

### `tunnel login` зависает на «Paste the code»

Скорее всего, в Google-аккаунте включена 2FA, и вы не дошли до
экрана согласия. Откройте напечатанный URL в режиме инкогнито
или с другого профиля.

## ⚠️ Ограничения

- **Лимиты — per-account.** Несколько аккаунтов не складывают квоты в
  одну, а позволяют выбрать «свободный». Если все аккаунты выбрали
  одну и ту же квоту (например, все на free-tier), переключение не
  поможет.
- **Refresh-token rotation.** Google не всегда ротирует токены, но
  иногда меняет их. Прокси это поддерживает, но если токен
  поворачивается слишком часто — проверьте `tunnel refresh <id>`.
- **Streaming aborts.** Клиент может оборвать SSE-стрим; прокси
  корректно отменяет upstream-запрос, но если оборвалось уже после
  первого чанка, аккаунт может остаться в невыгодном положении.
  Решение — следующий запрос уйдёт на другой аккаунт.
- **Tool calls и system prompt** проходят прозрачно, но
  `function_calling_config` на стороне Code Assist не настраивается
  через OpenAI API — прокси отдаёт дефолты Google.
- **Не проксирует `embeddings`, `images`, `audio`** — только
  `/v1/chat/completions` и `/v1/models`.
- **OAuth callback** — прокси сам callback не принимает: пользователь
  копирует `code` из URL и вставляет в CLI. Это сознательное
  упрощение (нет публичного HTTPS endpoint для callback).

## 📁 Структура проекта

```
GeminiTunnel/
├── src/
│   ├── api/
│   │   ├── openai/         # OpenAI-совместимый адаптер (/v1/chat, /v1/models)
│   │   ├── codeassist/     # Клиент Code Assist (streamGenerateContent, quota)
│   │   └── admin/          # /admin API + Web UI (cookie auth)
│   ├── accounts/           # SQLite store, encryption, TokenRefresher, AccountPool
│   ├── oauth/              # PKCE, state, finalize
│   ├── quota/              # QuotaPoller
│   ├── cli/bin.ts          # `tunnel` CLI
│   ├── config.ts           # zod-валидация env
│   ├── index.ts            # server entry point + graceful shutdown
│   ├── logger.ts           # pino + redact
│   └── server.ts           # Hono app + body cap + /health
├── test/integration/       # end-to-end тесты с mock upstream
├── scripts/copy-static.mjs # post-build: ui.html -> dist/, .js.map strip
├── Dockerfile              # multi-stage Node 22, digest-pinned
├── docker-compose.yml
├── .env.example
├── tsconfig.json           # build (rootDir=src, sourceMap: false)
├── tsconfig.test.json      # typecheck для test/
├── vitest.config.ts
├── CHANGELOG.md            # история релизов (Keep a Changelog)
├── README.md
└── LICENSE
```

## 📄 Лицензия

[MIT](LICENSE)

## 🗒 История изменений

[CHANGELOG.md](CHANGELOG.md) — что добавилось, что изменилось,
что удалилось в каждом релизе. Теги релизов и GitHub Releases
публикуются на странице репозитория.
