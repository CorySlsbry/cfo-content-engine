# syntax=docker/dockerfile:1.7
# -------------------------------------------------------------------
# CFO Content Engine — Cloud Run container.
#
# Single process: server.js handles the dashboard + orchestrator tick
# + researcher schedule + socket.io. No PM2, no separate workers.
#
# ffmpeg binaries are supplied by the ffmpeg-static + ffprobe-static
# npm packages (Linux x64), so the base image can stay slim — no
# apt-get ffmpeg needed.
#
# Cloud Run conventions honored:
#   - Listens on $PORT (defaults to 3000 for local)
#   - Logs to stdout/stderr (no log files)
#   - /healthz for readiness probes
#   - Runs as a non-root user
# -------------------------------------------------------------------

# ---- Build stage: install deps fresh for the target platform ----
FROM node:22-slim AS deps

WORKDIR /app

# Copy only the files needed to resolve dependencies. Separating this
# from the source copy keeps `npm ci` in a cacheable layer when only
# app code changes.
COPY package.json package-lock.json ./

# `npm ci` re-resolves native binaries (ffmpeg-static, ffprobe-static,
# better-sqlite3's successor is node:sqlite — no native build needed)
# for the Linux/x64 target. Never copy node_modules from the host.
RUN npm ci --omit=dev --no-audit --no-fund


# ---- Runtime stage: minimal image with only what the server needs ----
FROM node:22-slim AS runtime

# Install a couple of runtime dependencies:
#   - ca-certificates: for TLS to supabase + gemini + openai + elevenlabs
#   - tini: proper PID-1 signal handling so SIGTERM from Cloud Run
#     cleanly shuts us down (Node alone forwards signals weirdly).
# We intentionally do NOT install ffmpeg from apt; ffmpeg-static handles it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy prod deps from the build stage — they already have the correct
# platform binaries for ffmpeg-static / ffprobe-static.
COPY --from=deps /app/node_modules ./node_modules

# Copy the application code. Order by change frequency: package metadata
# first (rarely changes), then source (changes often).
COPY package.json package-lock.json ./
COPY public ./public
COPY assets ./assets
COPY *.js ./
# scripts/ contains one-shot migration scripts — include so an operator
# can `gcloud run jobs execute` them if ever needed, but they're not on
# the serve path.
COPY scripts ./scripts

# Non-root user. Cloud Run runs containers with their declared user; `node`
# is already uid 1000 in the official images.
USER node

# Cloud Run sets PORT dynamically — our server already honors it.
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_BACKEND=gcs

EXPOSE 3000

# tini forwards SIGTERM correctly; without it, Cloud Run's 10s grace-period
# sigkill happens before our shutdown hook runs, which can leave work
# half-done between stages.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
