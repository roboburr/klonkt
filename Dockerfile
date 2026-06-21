# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────
# Klonkt — zelf-host image. Multi-stage: native deps compileren in een volle
# image, dan een slanke runtime. ffmpeg wordt meegebundeld via ffmpeg-static
# (npm), cwebp komt uit het Debian-pakket 'webp'.
# ──────────────────────────────────────────────────────────────────────────

# ---- builder: native modules (better-sqlite3) + ffmpeg-static ophalen ----
FROM node:20-bookworm AS builder
WORKDIR /app
# Build-tools voor het geval better-sqlite3 from-source moet (anders prebuilt).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Productie-deps; install-scripts draaien (better-sqlite3 build + ffmpeg download).
RUN npm ci --omit=dev

# ---- runtime: slank image + cwebp ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# cwebp = afbeelding→WebP (optioneel in de app, maar handig); ca-certificates
# voor uitgaande HTTPS (license-server, SMTP, Google).
RUN apt-get update && apt-get install -y --no-install-recommends webp ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# node_modules (incl. gecompileerde better-sqlite3 + gebundelde ffmpeg) uit builder.
COPY --from=builder /app/node_modules ./node_modules
# App-broncode.
COPY . .
# Persistente data leeft hier (DB, media, audio) — mount-punt voor een volume.
RUN mkdir -p storage/media storage/audio && chown -R node:node /app
USER node
EXPOSE 3000
# Simpele healthcheck via Node's ingebouwde fetch (Node 20).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
