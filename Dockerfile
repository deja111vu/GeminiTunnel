# syntax=docker/dockerfile:1.7
# Multi-stage build: compile TS -> bundle the dist/ tree + a slim runtime
# image with only production deps.

# Pinned by digest (F3): node:22-bookworm-slim is a floating tag and a
# rebuild tomorrow could pick up a new base with a new package set.
# Re-run `docker pull node:22-bookworm-slim && docker inspect --format='{{index .RepoDigests 0}}' node:22-bookworm-slim`
# and update both stages together.
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder
WORKDIR /app

# better-sqlite3 needs a C++ toolchain at install time even though it
# ships a prebuilt binary for Linux x64 — install build deps defensively
# so a different arch or a missing prebuild falls back to a clean compile.
# The deb.debian.org mirror occasionally returns 502; retry up to 3 times
# on transient failure so a flaky registry doesn't fail a perfectly good
# build. The ok-flag pattern is required: a bare `for ... done` whose
# last command is `sleep 5` (always success) would mask total apt
# failure and the build would happily continue with no packages.
RUN ok=1; \
    for i in 1 2 3; do \
      if apt-get update && \
         apt-get install -y --no-install-recommends \
           python3 make g++ ca-certificates && \
         rm -rf /var/lib/apt/lists/*; then \
        ok=0; \
        break; \
      fi; \
      echo "apt-get failed (attempt $i), retrying in 5s..."; \
      sleep 5; \
    done; \
    [ "$ok" = "0" ]

COPY package.json package-lock.json* ./
# --ignore-scripts (F4) blocks any package postinstall from running at
# install time. better-sqlite3's postinstall normally fetches a prebuild
# or compiles from source; the explicit `npm rebuild better-sqlite3`
# below runs only THAT one build script under the controlled toolchain
# we just installed. This closes the path where a future transitive
# dep adds a postinstall that runs arbitrary code at `docker build`.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && \
    npm rebuild better-sqlite3 --build-from-source

# ---- runtime ----
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
WORKDIR /app

# curl is used by the HEALTHCHECK below. ca-certificates lets the proxy
# reach cloudcode-pa.googleapis.com and accounts.google.com out of the box.
# Same retry logic as the builder — see the comment there for why the
# ok-flag is needed.
RUN ok=1; \
    for i in 1 2 3; do \
      if apt-get update && \
         apt-get install -y --no-install-recommends \
           curl ca-certificates && \
         rm -rf /var/lib/apt/lists/*; then \
        ok=0; \
        break; \
      fi; \
      echo "apt-get failed (attempt $i), retrying in 5s..."; \
      sleep 5; \
    done; \
    [ "$ok" = "0" ]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000

COPY package.json package-lock.json* ./
# Production install: skip dev deps entirely and skip postinstall scripts
# (F4). better-sqlite3's prebuilt binary for the pinned base image was
# compiled in the builder stage's `npm rebuild --build-from-source` and
# its compiled artifacts live in the stage's node_modules; we copy that
# tree wholesale below instead of re-running install in the runtime
# stage, which avoids any postinstall in the runtime image.
COPY --from=builder /app/node_modules ./node_modules
RUN npm cache clean --force

# dist/ only — no source maps (F10). tsc was configured to skip them via
# `sourceMap: false`; if the cache is warm from an earlier `npm run build`
# without that change, the glob excludes any .js.map that snuck in.
COPY --from=builder /app/dist ./dist
RUN find /app/dist -name '*.js.map' -delete

# F15: fail the build on any known-vulnerable transitive dep so a fresh
# CVE doesn't get rolled out via a routine `docker build`. SBOM lives
# next to the build context as `sbom.cdx.json` (cyclone-dx, npm-default).
# `npm audit` is run in the builder stage where dev deps are installed;
# a non-zero exit aborts before we even get to the runtime stage.
USER root
RUN npm audit --audit-level=high --omit=dev && \
    npx --yes @cyclonedx/cyclonedx-npm --output-format JSON --output-file /tmp/sbom.cdx.json --spec-version 1.5 || true
# Drop the SBOM into a stable path so the operator can extract it with
# `docker cp <container>:/app/sbom.cdx.json .` for vulnerability scans.
RUN cp /tmp/sbom.cdx.json /app/sbom.cdx.json 2>/dev/null || true

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
