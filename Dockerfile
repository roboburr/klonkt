# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────
# Klonkt — self-host image. Multi-stage: compile native deps in a full
# image, then a slim runtime. ffmpeg is bundled via ffmpeg-static
# (npm), cwebp comes from the Debian 'webp' package.
# ──────────────────────────────────────────────────────────────────────────

# ---- builder: fetch native modules (better-sqlite3) + ffmpeg-static ----
FROM node:20-bookworm AS builder
WORKDIR /app
# Build tools in case better-sqlite3 must build from source (otherwise prebuilt).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Production deps; install scripts run (better-sqlite3 build + ffmpeg download).
RUN npm ci --omit=dev

# ---- runtime: slank image + cwebp ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# cwebp = image→WebP (optional in the app, but handy); ca-certificates
# for outbound HTTPS (license server, SMTP, Google).
RUN apt-get update && apt-get install -y --no-install-recommends webp ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# node_modules (incl. compiled better-sqlite3 + bundled ffmpeg) from builder.
COPY --from=builder /app/node_modules ./node_modules
# App source code.
COPY . .
# Persistent data lives here (DB, media, audio) — mount point for a volume.
RUN mkdir -p storage/media storage/audio && chown -R node:node /app
USER node
EXPOSE 3000
# Simple healthcheck via Node's built-in fetch (Node 20).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
