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
  refresh, удаление, запуск нового OAuth-логина. Защищён bearer-токеном.
- 🛠️ **CLI `tunnel`** — то же самое из терминала: `login`, `list`,
  `remove`, `refresh`, `quota`. Удобно для SSH на VPS.
- 🐳 **Docker-ready** — один контейнер, том для БД, healthcheck.
- 🪶 **Зависимости** — Node 22, `better-sqlite3`, `hono`, `pino`,
  `google-auth-library`. Никаких внешних сервисов.

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
2. **`ADMIN_TOKEN`** — bearer-токен для `/admin` и `/admin/api/*`.
   Проверяется через `crypto.timingSafeEqual`, а не `===`.
3. **`/admin` сам по себе — не панель без пароля.** Без `ADMIN_TOKEN`
   отдаёт 401. UI использует его для запросов.
4. **UFW / iptables** — ограничьте 8000-й порт по IP. Cloudflare
   Tunnel — хороший способ спрятать origin.
5. **HTTPS** — обязателен, если клиент не в локальной сети. Самый
   простой путь: поставить прокси за Cloudflare Tunnel или Caddy.
6. **Refresh-token rotation** — Google при каждом refresh может
   выдать новый `refresh_token`; прокси записывает его обратно
   в БД атомарно с новым access-токеном.
7. **OAuth state TTL** — pending-флоу хранятся 10 минут, и не более
   1000 одновременно (защита от DoS).
8. **Quota polling — read-only** — QuotaPoller использует только
   `loadCodeAssist` и `retrieveUserQuota`, ничего не пишет в аккаунт.
9. **Файловые права** — на Linux `data/` создаётся 0o700, `*.db` —
   0o600. На Windows — наследуются от пользователя, запустившего
   контейнер.

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
│   │   └── admin/          # /admin API + Web UI
│   ├── accounts/           # SQLite store, encryption, TokenRefresher, AccountPool
│   ├── oauth/              # PKCE, state, finalize
│   ├── quota/              # QuotaPoller
│   ├── cli/bin.ts          # `tunnel` CLI
│   ├── config.ts           # zod-валидация env
│   ├── index.ts            # server entry point
│   └── server.ts           # Hono app + /health
├── test/integration/       # end-to-end тесты с mock upstream
├── scripts/copy-static.mjs # post-build: ui.html -> dist/
├── Dockerfile              # multi-stage Node 22
├── docker-compose.yml
├── .env.example
├── tsconfig.json           # build (rootDir=src)
├── tsconfig.test.json      # typecheck для test/
└── package.json
```

## 📄 Лицензия

[MIT](LICENSE)
