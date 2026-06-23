# Klonkt

Your own, **self-hosted** corner of the web — for your story, your visuals and
your sound. Built on **Node + SQLite + htmx**: lightweight, server-rendered, and
yours. No algorithm, no ads, no platform sitting in between.

## What it does

- **Solo or hub** — one personal site, or a label/collective with multiple
  makers under one roof.
- **Blog & photos** — posts with cover, tags, timeline or grid.
- **Host your own music** — built-in audio player with tracks, albums and playlists.
- **Fans & comments** — visitors sign in with Google (optional) and comment.
- **Grow**: newsletter, download-for-email, EPK/press kit, link-in-bio,
  show calendar, and **cookie-free statistics**.
- **Circles** — connect your site with other Klonkt sites and show each other's
  public posts; decentralized, with no central platform (Ed25519-signed federation).
- **Themes & languages** — multiple palettes (light + dark), interface in EN/NL/DE.
- **Installable (PWA)**, **privacy-first** (self-hosted fonts, no tracking).

### Lite mode (no audio)

Set `KLONKT_AUDIO=off` in `.env` to disable the entire audio/music feature.
Klonkt then runs as a lightweight **blog/photo/EPK/links site without ffmpeg** —
ideal for minimal hosting. Hub, Circles and external embeds
(YouTube/SoundCloud/Spotify) keep working.

## Self-hosting

Klonkt is a **Node app** — run it on a **VPS, in Docker, or on a Node hosting
platform (PaaS)**. **Not** on classic shared PHP hosting. The database (SQLite)
creates itself on first start.

### Option A — One-command VPS installer (recommended)

**Good if:** you have (or just rented) a fresh, empty Debian/Ubuntu VPS and want
the easiest path. This single line does everything — installs Node 20, sets up
Caddy for automatic HTTPS, runs Klonkt as a background service that auto-restarts
on reboot, and adds an update command. It's coexistence-safe (if the server
already runs something it picks a free port and skips Caddy), but a clean VPS is
simplest. Point your domain's DNS (A + AAAA records) at the server first, then run
as root:

```bash
curl -fsSL https://klonkt.com/install.sh | sudo bash -s -- --domain yourdomain.com
```

Then open `https://yourdomain.com` and finish setup in the browser. Update anytime
with `klonkt-update`.

### Option B — Docker

**Good if:** you already use Docker, or want everything bundled in one isolated
container. Node, ffmpeg and cwebp are inside the image — you only need Docker +
Docker Compose.

```bash
git clone https://github.com/roboburr/klonkt.git
cd klonkt
cp .env.example .env          # works as-is; optionally set PUBLIC_BASE_URL to your domain
docker compose up -d
```

`SESSION_SECRET` is auto-generated on first start, so the defaults work as-is.
Klonkt runs on port 3000 — put your own reverse proxy in front for HTTPS (see
step 5 of Option C). Data (database + media) stays in the `klonkt-data` volume,
even across updates. Update: `git pull && docker compose up -d --build`.

### Option C — manual (Node 20+), step by step

**Good if:** you want full control, are adding Klonkt to a server you already
manage, or just want to test it locally.

**1. Get the code & install dependencies**

```bash
git clone https://github.com/roboburr/klonkt.git
cd klonkt
npm ci
```

**2. Create your config.** `SESSION_SECRET` (the key that signs login cookies) is
auto-generated on first start, so this works as-is. For production, set
`PUBLIC_BASE_URL` to your site address (e.g. `https://yourdomain.com`) so email &
login links are correct:

```bash
cp .env.example .env
nano .env          # optional: PUBLIC_BASE_URL, plus SMTP / Google if you want them
```

**3. Start it** — the SQLite database is created automatically on first start:

```bash
npm start          # runs on http://localhost:3000
```

Just testing locally? Stop here and open `http://localhost:3000`.

**4. Keep it running** across crashes and reboots (easiest is pm2):

```bash
npm install -g pm2
pm2 start src/server.js --name klonkt
pm2 save && pm2 startup     # run the one command it prints, once
```

**5. Add HTTPS** with a reverse proxy in front. With Caddy (automatic
certificates), put this in `/etc/caddy/Caddyfile` and reload Caddy:

```caddy
yourdomain.com {
    reverse_proxy localhost:3000
}
```

(`cwebp` is optional — `apt install webp` — for WebP image conversion.)

### HTTPS (Docker / bare Node)

Put a reverse proxy in front of the app. With **Caddy** (automatic Let's Encrypt):

```caddy
yourdomain.com {
    reverse_proxy localhost:3000
    encode gzip zstd
}
```

(The VPS installer sets up Caddy + HTTPS for you already.)

### First run

Open your site → you get the **setup wizard**: pick your language, name your site
and create your admin. The **first user automatically becomes the administrator**;
registration then closes. Lost your password?
`npm run reset-admin` (Docker: `docker compose exec klonkt npm run reset-admin`).

## Configuration (`.env`)

| Variable | Required | What |
|---|---|---|
| `SESSION_SECRET` | ✅ | Random string of ≥32 characters |
| `PUBLIC_BASE_URL` | ✅ | Canonical URL (e.g. `https://yourdomain.com`) |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | — | Google login for listeners (your own OAuth client; never grants admin) |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` | — | Email for password reset + newsletter |
| `KLONKT_DEFAULT_LANG` | — | Default language for visitors (`en`/`nl`/`de`) |
| `KLONKT_AUDIO` | — | `off` = lite mode (no audio/ffmpeg) |

## Stack

- **Runtime:** Node 20+
- **Web:** Express + Helmet + express-session
- **DB:** better-sqlite3 (WAL), self-migrating on boot
- **Templates:** EJS (server-rendered) + **htmx 1.9** (vendored, no build step)
- **Audio:** ffmpeg-static (bundled)
- **Circles:** Ed25519-signed pull (libsodium via Node crypto)
- **Fonts:** self-hosted variable woff2 (Fraunces / Plus Jakarta Sans)

## Project structure

```
src/
├── server.js          # Express bootstrap + route mounting
├── config/            # database, mailer, google, feature flags
├── db/migrations/     # SQLite schema (001-init.sql)
├── middleware/        # site resolving, auth, render (htmx-aware)
├── routes/            # per-resource Express routers (posts, auth, admin-*, circle, …)
├── services/          # domain logic (federation, stats, mailer, permissions, …)
├── views/             # shell.ejs + partials/ + pages/  (EJS)
└── assets/            # css/ (palette tokens + components), js/ (htmx, player), fonts/
```

## License

**AGPL-3.0-or-later** — see [LICENSE](LICENSE). Klonkt is free software: you may
use, study, modify and distribute it. The AGPL does require that a modified
version you offer as a network service makes its source code available to the
users of that service. Made by robo.burr (Robin Genis) ·
<https://klonkt.com>
