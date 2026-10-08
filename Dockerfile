# syntax=docker/dockerfile:1.7
# Multi-stage build: compile TS -> bundle the dist/ tree + a slim runtime
# image with only production deps.

# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 needs a C++ toolchain at install time even though it
# ships a prebuilt binary for Linux x64 — install build deps defensively
# so a different arch or a missing prebuild falls back to a clean compile.
# The deb.debian.org mirror occasionally returns 502; retry the whole
# update+install once on transient failure so a flaky registry doesn't
# fail a perfectly good build.
RUN for i in 1 2 3; do \
      apt-get update && \
      apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates && \
      rm -rf /var/lib/apt/lists/* && \
      break; \
      echo "apt-get failed (attempt $i), retrying in 5s..."; \
      sleep 5; \
    done

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# curl is used by the HEALTHCHECK below. ca-certificates lets the proxy
# reach cloudcode-pa.googleapis.com and accounts.google.com out of the box.
RUN for i in 1 2 3; do \
      apt-get update && \
      apt-get install -y --no-install-recommends \
        curl ca-certificates && \
      rm -rf /var/lib/apt/lists/* && \
      break; \
      echo "apt-get failed (attempt $i), retrying in 5s..."; \
      sleep 5; \
    done

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts

# The DB lives on a mounted volume (see docker-compose.yml). Create the
# directory in the image so the first run doesn't fail when the volume
# mount point doesn't exist yet.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
WORKDIR /app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
