# Klonkt Beta

Persoonlijk multi-site platform met editorial-feel content + sociale community.
Gebouwd op **Node + SQLite + htmx** — licht, zelf-gehost, en van jou.

> **Wat het is.** Geen *publishing tool* maar een *persoonlijk canvas* — content,
> profiel, sociale interactie en realtime in één.

## Filosofie

- **Editorial feel.** Magazine-typografie (Fraunces + Literata + Plus Jakarta), royale spacing, 12 paletten (o.a. Sage, Paper, Ocean, Forest, Stone, Midnight, Sunset, Cream, Rose, Goud, Terracotta, Lilac). Light + dark per palette.
- **App-feel waar het telt.** Geen full page reloads — htmx swaps + (binnenkort) View Transitions. Voelt als app, niet als website.
- **Server-rendered.** Geen build step, geen SPA-tax. EJS + htmx + minimale Alpine.
- **Realtime ingebouwd.** WebSocket server zit in `src/websocket/`. SSE als alternatief beschikbaar.
- **Privacy-first.** Self-hosted fonts, geen third-party requests, geen tracking.

## Roadmap

| Fase | Scope | Status |
|------|-------|--------|
| **1.0 — v9-feel** | Homepage, profile-header, feed, post-detail visueel matchen met v9 | 🟡 in progress |
| **1.1 — auth + posts** | Login / register / post CRUD compleet | ✅ klaar |
| **1.2 — sociale laag** | Comments, Prutter (DMs zonder E2EE), notifications | ⚪ na 1.0 |
| **1.3 — app-feel** | View Transitions, optimistic UI, swipe-actions, haptics | ⚪ |
| **1.4 — bottom-tab nav** | Native-app-stijl navigatie op mobiel, sidebar op desktop | ⚪ |
| **2.0 — E2EE DMs** | MLS protocol via `@openmls/openmls`, single-device first | ⚪ apart project |

## Zelf hosten

Klonkt is een **Node-app** (geen PHP) — draai 'm op een VPS, in Docker of op een
Node-hostingplatform. **Niet** op klassieke shared PHP-hosting. De database
(SQLite) maakt zichzelf aan bij de eerste start; er is geen los installatiescript.

### Optie A — Docker (aanbevolen)

Alles (Node, ffmpeg, cwebp) zit in het image; je hoeft alleen Docker te hebben.

```bash
git clone <repo-url> klonkt && cd klonkt
cp .env.example .env
# vul in .env minimaal in: SESSION_SECRET (>=32 random tekens) + PUBLIC_BASE_URL
docker compose up -d
```

De app draait nu op poort 3000. Alle data (database + geüploade media/audio)
blijft bewaard in het `klonkt-data`-volume, ook na een update. Updaten:

```bash
git pull && docker compose up -d --build
```

### Optie B — direct met Node (Node 20+)

```bash
git clone <repo-url> klonkt && cd klonkt
npm ci
cp .env.example .env        # SESSION_SECRET + PUBLIC_BASE_URL invullen
npm start                   # database wordt bij de eerste start aangemaakt
```

Open http://localhost:3000. Voor productie: zet 'm achter een procesmanager
(pm2/systemd) zodat 'ie aanblijft. `cwebp` is optioneel (Debian/Ubuntu:
`apt install webp`) voor WebP-afbeeldingen — ontbreekt 'ie, dan wordt het
origineel bewaard. (`npm run dev` = watch-mode voor ontwikkeling.)

### HTTPS (productie)

Zet een reverse-proxy vóór de app voor TLS. Met **Caddy** (automatisch
Let's Encrypt) volstaat één blok:

```caddy
jouwdomein.nl {
    reverse_proxy localhost:3000
    encode gzip zstd
}
```

### Eerste keer

Open je site en ga naar **`/auth/register`** — de **eerste gebruiker wordt
automatisch beheerder**; daarna sluit registratie zich. Wachtwoord kwijt?
`npm run reset-admin` (in Docker: `docker compose exec klonkt npm run reset-admin`).

## Stack

- **Runtime:** Node 20+
- **Web:** Express + Helmet + express-session
- **DB:** better-sqlite3 (WAL mode)
- **Templates:** EJS (server-rendered)
- **Frontend interactie:** htmx 1.9 (vendored)
- **Realtime:** ws (WebSocket)
- **Fonts:** self-hosted variable woff2 (Fraunces / Literata / Plus Jakarta Sans)

## Project structure

```
src/
├── server.js           # Express bootstrap, routes mounting, WS server
├── config/             # database, env loading
├── db/migrations/      # SQLite schema (001-init.sql)
├── middleware/         # auth, render (htmx-aware), site, rate-limit
├── routes/             # per-resource Express routers
├── services/           # domain logic (Prutter, Audio, Theme, Permissions, ...)
├── views/
│   ├── shell.ejs       # outer document (head, nav, footer)
│   ├── partials/       # topnav, profile-header, post-card, post-tile
│   └── pages/          # home, post, account, admin, ...
├── assets/
│   ├── css/style.css   # v9 stylesheet — palette tokens, components
│   ├── fonts/          # variable woff2
│   └── js/             # htmx, audio-player
└── websocket/          # WS server for realtime (notifications, prutter, presence)
```

## Import

Importer voor bestaande bestandsgebaseerde content is gepland voor v1.1.
Pad: `posts/*.md` + `users.json` + `sites/*/config.json` → SQLite.

## License

Persoonlijk project. Niet bedoeld voor publieke distributie tot verder bericht.

## Deployed via git workflow on 2026-04-30

