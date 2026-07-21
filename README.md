# Klonkt

Your own, **self-hosted** corner of the web — for your story, your visuals and
your sound. Built on **Node + SQLite + htmx**: lightweight, server-rendered, and
yours. No algorithm, no ads, no platform sitting in between.

## What it does

- **Solo** — one personal site, entirely yours, on your own domain.
- **Blog & photos** — posts with cover, tags, timeline or grid.
- **Host your own music** — built-in audio player with tracks, albums and playlists.
- **Fediverse-native** — your posts federate over **ActivityPub**: people follow,
  like, boost and reply from Mastodon (or another Klonkt). You can follow accounts,
  see a home timeline, and reply/like back — Klonkt is a full fediverse client.
- **Grow**: newsletter, download-for-email, EPK/press kit, link-in-bio,
  show calendar, and **cookie-free statistics**.
- **Paid posts** — put a post behind your **own Patreon**. Supporters unlock it
  with a **passkey**: no account on your site, no cookie, and a patron's identity
  (name/email) is never stored — only a pseudonymous, expiring entitlement. You
  connect your Patreon once in the admin and pick a minimum amount per post.
- **Circles** — a curated feed of the makers you choose: feature accounts (other Klonkt
  sites, Mastodon, PeerTube — any fediverse server) and their public posts appear in your
  Circle. Decentralized, no central platform — built on ActivityPub.
- **Themes & languages** — multiple palettes (light + dark), interface in EN/NL/DE.
- **Installable (PWA)**, **privacy-first** (self-hosted fonts, no tracking).

### Lite mode (no audio)

Set `KLONKT_AUDIO=off` in `.env` to disable the entire audio/music feature.
Klonkt then runs as a lightweight **blog/photo/EPK/links site without ffmpeg** —
ideal for minimal hosting. Circles and external embeds
(YouTube/SoundCloud/Spotify) keep working.

It's **fully reversible**: set `KLONKT_AUDIO` back to `on` (or remove the line)
and restart — no reinstall. The flag only toggles the audio routes/UI; the
database tables are never dropped, so any tracks you had are preserved.

## Self-hosting

Klonkt is a **Node app** — run it on a **VPS, in Docker, or on a Node hosting
platform (PaaS)**. **Not** on classic shared PHP hosting. The database (SQLite)
creates itself on first start.

> **Requires [Node.js](https://nodejs.org/) 20 or newer.** The one-command VPS
> installer and the Docker image include it; only a manual install needs you to
> provide it.

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

Updates track the **`stable`** branch — it only advances to a version that's been verified,
so `klonkt-update` never pulls work-in-progress. Want the bleeding edge instead? Install with
`--branch main` (or set `KLONKT_BRANCH=main`).

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
nano .env          # optional: PUBLIC_BASE_URL, plus SMTP if you want it
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

By default the app binds to `127.0.0.1` (via `HOST` in `.env`), so only your
reverse proxy can reach it — not the open internet. Local testing on the same
machine (`localhost:3000`) still works. Only set `HOST=0.0.0.0` if you need direct
external access without a proxy (then open the port in your firewall and add HTTPS
yourself).

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
| `SESSION_SECRET` | auto | Signs login sessions. Leave empty to auto-generate (`storage/.session-secret`), or set a random ≥32-char string. |
| `PUBLIC_BASE_URL` | ✅ | Canonical URL (e.g. `https://yourdomain.com`) |
| `PAID_SECRET` | auto | Encrypts the stored Patreon secrets for **paid posts**. Leave empty to auto-generate on first use (`storage/.paid-secret`), or set your own ≥16-char string. |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` | — | Email for password reset + newsletter |
| `KLONKT_DEFAULT_LANG` | — | Default language for visitors (`en`/`nl`/`de`) |
| `KLONKT_AUDIO` | — | `off` = lite mode (no audio/ffmpeg) |
| `KLONKT_PREMIUM_ENABLED` | — | `on` (default) enables the Patreon-unlocked extras (incl. paid posts) |
| `HSTS_STRICT` | — | `1` = stricter HTTPS header (`includeSubDomains` + `preload`). Only set this if Klonkt owns the **whole** domain and all its subdomains are HTTPS — it forces every subdomain to HTTPS and can bake your domain into browsers near-permanently. Leave unset otherwise; the default is already safe. |

### Auto-generated secrets & backups

You never have to hand-edit the env for these: Klonkt generates them on first use
and keeps them stable across restarts and updates.

- `SESSION_SECRET` → `storage/.session-secret` (signs login sessions)
- `PAID_SECRET` → `storage/.paid-secret` (encrypts the stored Patreon secrets for
  paid posts)

The paid-posts key lives **outside** the database on purpose: encrypting the
Patreon secrets would be pointless if the key sat in the same file a database
dump would leak. Set either variable in `.env` to override the generated one.

**Back up the whole `storage/` directory** (database, media *and* these key
files). Restoring the database without `storage/.paid-secret` leaves the stored
Patreon secrets unreadable — you'd have to reconnect Patreon.

## Stack

- **Runtime:** Node 20+
- **Web:** Express + Helmet + express-session
- **DB:** better-sqlite3 (WAL), self-migrating on boot
- **Templates:** EJS (server-rendered) + **htmx 1.9** (vendored, no build step)
- **Audio:** ffmpeg-static (bundled)
- **Fediverse / Circles:** ActivityPub (HTTP Signatures) — federates with Mastodon, PeerTube and other Klonkt sites. See [FEDERATION.md](FEDERATION.md) for the supported activities and FEPs.
- **Fonts:** self-hosted variable woff2 (Fraunces / Plus Jakarta Sans)

## Project structure

```
src/
├── server.js          # Express bootstrap + route mounting
├── config/            # database, mailer, feature flags
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

## Acknowledgements

Klonkt stands on a lot of open-source work — Node.js, FFmpeg, SQLite, libwebp, resvg, htmx, EJS and
more, plus the Fraunces, Plus Jakarta Sans and Literata fonts. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full list and their licences. Thank you to
everyone who made them.
