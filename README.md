# Klonkt

Je eigen, **zelf-gehoste** plek op het web — voor je verhaal, je beeld en je
geluid. Gebouwd op **Node + SQLite + htmx**: licht, server-rendered, en van jou.
Geen algoritme, geen advertenties, geen platform dat ertussen zit.

## Wat het kan

- **Solo of hub** — één persoonlijke site, of een label/collectief met meerdere
  makers onder één dak.
- **Blog & foto's** — posts met cover, tags, tijdlijn of grid.
- **Eigen muziek hosten** — ingebouwde audiospeler met tracks, albums en playlists.
- **Fans & reacties** — bezoekers loggen in met Google (optioneel) en reageren.
- **Groeien**: nieuwsbrief, download-voor-email, EPK/perskit, link-in-bio,
  show-agenda, en **cookievrije statistieken**.
- **Cirkels** — verbind je site met andere Klonkt-sites en toon elkaars publieke
  posts; decentraal en zonder centraal platform (Ed25519-gesigneerde federatie).
- **Thema's & talen** — meerdere paletten (light + dark), interface in NL/EN/DE.
- **Installeerbaar (PWA)**, **privacy-first** (self-hosted fonts, geen tracking).

### Lite-modus (zonder audio)

Zet `KLONKT_AUDIO=off` in `.env` om de hele audio-/muziek-feature uit te
schakelen. Klonkt draait dan als lichte **blog/foto/EPK/links-site zónder ffmpeg**
— ideaal voor minimale hosting. Hub, Cirkels en externe embeds
(YouTube/SoundCloud/Spotify) blijven gewoon werken.

## Zelf hosten

Klonkt is een **Node-app** — draai 'm op een **VPS, in Docker, of op een
Node-hostingplatform (PaaS)**. **Niet** op klassieke shared PHP-hosting. De
database (SQLite) maakt zichzelf aan bij de eerste start.

### Optie A — Docker (aanbevolen)

Node, ffmpeg en cwebp zitten in het image; je hebt alleen Docker nodig.

```bash
git clone <repo-url> klonkt && cd klonkt
cp .env.example .env          # vul SESSION_SECRET + PUBLIC_BASE_URL in
docker compose up -d
```

Data (database + media) blijft in het `klonkt-data`-volume, ook na een update.
Updaten: `git pull && docker compose up -d --build`.

### Optie B — VPS-installer (Debian/Ubuntu)

Eén commando: installeert Node 20, Caddy (automatische HTTPS) en een
systemd-service. Coëxistentie-veilig (raakt een bestaande Node/webserver niet).

```bash
sudo bash scripts/install.sh --domain jouwdomein.nl
```

Bijwerken kan daarna met `klonkt-update`.

### Optie C — kaal Node (20+)

```bash
git clone <repo-url> klonkt && cd klonkt
npm ci
cp .env.example .env          # SESSION_SECRET + PUBLIC_BASE_URL invullen
npm start                     # database wordt bij de eerste start aangemaakt
```

Zet 'm voor productie achter een procesmanager (pm2/systemd) en een
reverse-proxy. `cwebp` is optioneel (`apt install webp`) voor WebP-afbeeldingen.

### HTTPS (Docker / kaal Node)

Zet een reverse-proxy vóór de app. Met **Caddy** (automatisch Let's Encrypt):

```caddy
jouwdomein.nl {
    reverse_proxy localhost:3000
    encode gzip zstd
}
```

(De VPS-installer regelt Caddy + HTTPS al voor je.)

### Eerste keer

Open je site → je krijgt de **setup-wizard**: kies je taal, geef je site een
naam en maak je beheerder aan. De **eerste gebruiker wordt automatisch
beheerder**; daarna sluit registratie zich. Wachtwoord kwijt?
`npm run reset-admin` (Docker: `docker compose exec klonkt npm run reset-admin`).

## Configuratie (`.env`)

| Variabele | Nodig | Wat |
|---|---|---|
| `SESSION_SECRET` | ✅ | Willekeurige string van ≥32 tekens |
| `PUBLIC_BASE_URL` | ✅ | Canonieke URL (bv. `https://jouwdomein.nl`) |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | — | Google-login voor luisteraars (eigen OAuth-client; geeft nooit beheer) |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` | — | E-mail voor wachtwoord-reset + nieuwsbrief |
| `KLONKT_DEFAULT_LANG` | — | Standaardtaal voor bezoekers (`en`/`nl`/`de`) |
| `KLONKT_AUDIO` | — | `off` = lite-modus (geen audio/ffmpeg) |

## Stack

- **Runtime:** Node 20+
- **Web:** Express + Helmet + express-session
- **DB:** better-sqlite3 (WAL), migreert zichzelf bij boot
- **Templates:** EJS (server-rendered) + **htmx 1.9** (vendored, geen build-step)
- **Audio:** ffmpeg-static (meegebundeld)
- **Cirkels:** Ed25519-gesigneerde pull (libsodium via Node-crypto)
- **Fonts:** self-hosted variable woff2 (Fraunces / Plus Jakarta Sans)

## Project-structuur

```
src/
├── server.js          # Express bootstrap + routes mounten
├── config/            # database, mailer, google, feature-flags
├── db/migrations/     # SQLite-schema (001-init.sql)
├── middleware/        # site-resolving, auth, render (htmx-aware)
├── routes/            # per-resource Express-routers (posts, auth, admin-*, circle, …)
├── services/          # domeinlogica (federatie, stats, mailer, permissies, …)
├── views/             # shell.ejs + partials/ + pages/  (EJS)
└── assets/            # css/ (palette-tokens + componenten), js/ (htmx, speler), fonts/
```

## Licentie

**AGPL-3.0-or-later** — zie [LICENSE](LICENSE). Klonkt is vrije software: je mag
het gebruiken, bestuderen, aanpassen en verspreiden. De AGPL vereist wel dat een
gewijzigde versie die je als netwerkdienst aanbiedt z'n broncode beschikbaar
stelt aan de gebruikers ervan. Gemaakt door robo.burr (Robin Genis) ·
<https://klonkt.com>
