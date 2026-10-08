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
# Install ALL deps (incl. dev) in the builder so we have node-gyp /
# the build toolchain available to compile better-sqlite3. The prune
# step below removes devDeps before the runtime COPY, so production
# never sees them. --ignore-scripts (F4) blocks every package
# postinstall at install time; we then explicitly rebuild only
# better-sqlite3 under the controlled toolchain we just installed.
RUN npm ci --ignore-scripts

# F15: audit now, while the full dep tree (incl. dev) is on disk. We
# deliberately do NOT pass --omit=dev: we audit exactly the tree the
# builder installed. The audit fails the build on any known-vuln dep
# at audit-level=high. (Later the runtime stage installs only --omit=dev,
# so a dep only used at build time still has to pass the gate to keep
# us honest about the supply chain.)
RUN npm audit --audit-level=high

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && \
    npm rebuild better-sqlite3 --build-from-source

# SBOM generation. Pinned to a specific version (no `npx --yes`) so
# `docker build` doesn't auto-fetch a fresh, possibly compromised copy
# of the tool from npm on every build. The build-arg override exists
# so the version can be bumped in one place.
ARG CYCLONEDX_NPM_VERSION=1.20.0
RUN npm install --no-save --ignore-scripts \
        "@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}" && \
    npx @cyclonedx/cyclonedx-npm \
        --output-format JSON \
        --output-file /tmp/sbom.cdx.json \
        --spec-version 1.5

# Now that the build is done, prune devDeps from node_modules. The
# runtime stage copies the pruned tree wholesale, so prod never ships
# typescript, vitest, msw, supertest, tsx, etc.
RUN npm prune --omit=dev

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

# Production deps only. The COPY below brings in the pruned tree from
# the builder (F4: no postinstall runs in the runtime image).
COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules

# dist/ only — no source maps (F10). tsc was configured to skip them via
# `sourceMap: false`; the `find` is a belt-and-suspenders sweep for any
# stale .js.map left over from a prior `sourceMap: true` build.
COPY --from=builder /app/dist ./dist
RUN find /app/dist -name '*.js.map' -delete

# Operator can extract the SBOM with `docker cp <container>:/app/sbom.cdx.json .`
COPY --from=builder /tmp/sbom.cdx.json /app/sbom.cdx.json

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
