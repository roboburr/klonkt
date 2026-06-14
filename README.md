# Klonkt Hub Beta

Persoonlijk multi-site platform met editorial-feel content + sociale community.
Forked van **PrutCMS v9** (PHP, file-based) naar **Node + SQLite + htmx**.

> **Naam-uitleg.** "PrutCMS v9" is en blijft het file-based PHP-product. Klonkt Hub
> (intern pakket `prutfolio`) is een nieuw product met andere DNA: het is geen
> *publishing tool* maar een *persoonlijk canvas* — content, profiel, sociale
> interactie en realtime in één.

## Filosofie

- **Editorial feel.** Magazine-typografie (Fraunces + Literata + Plus Jakarta), royale spacing, 8 paletten waaronder Sage / Paper / Ocean / Forest / Stone / Midnight / Sunset / Cream. Light + dark per palette.
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

## Quick start

```bash
npm install
cp .env.example .env
# zet SESSION_SECRET op iets random (>=32 chars in production)
npm run migrate
npm run dev
```

Open http://localhost:3000

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

## Migratie van PrutCMS v9

Importer is gepland voor v1.1. Pad: `posts/*.md` + `users.json` + `sites/*/config.json` → SQLite.

## License

Persoonlijk project. Niet bedoeld voor publieke distributie tot verder bericht.

## Deployed via git workflow on 2026-04-30

