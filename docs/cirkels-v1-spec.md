# Klonkt — Cirkels (v1-spec)

> Derde tenancy-optie naast **solo** en **hub**. Laat zelf-gehoste **solo-instances**
> elkaars publieke content tonen, **decentraal** en **asymmetrisch** — zónder centraal
> punt, zónder centrale moderatie, zónder dat iemand (ook Robin niet) de cirkel bezit.

Status: ontwerp. Bouwt voort op de bestaande tenancy-laag (`SettingsService`,
`app_settings`, `resolveSite`/`site.js`, `sites`-schema).

---

## 1. Principes (waarom dit veilig is voor het self-host-model)

1. **Geen centrale content.** Elke instance hbost z'n eigen posts. Een cirkel is
   enkel een *verzameling verbindingen*, geen opslag.
2. **Asymmetrisch (volgen, geen vriendschap).** A toont B omdat A dat kiest — los van
   of B A toont. "4 bandleden droppen de 5e" kan; de 5e houdt de 4 gewoon in z'n eigen
   cirkel. Dit is de Mastodon/Twitter-`Follow`-semantiek, niet de Facebook-`Friend`.
3. **Per-instance beheer + zelf-policing.** Elke admin beheert *zijn eigen* cirkel
   (Klonkt-URL's toevoegen/weghalen). Bevalt een bron niet → eruit. Geen centrale
   autoriteit, dus geen moderatie-/aansprakelijkheidslast bij de leverancier.
4. **Publiek = publiek.** Een cirkel toont alleen reeds-publieke posts (zoals RSS /
   embedding van het open web). Een bron kan zich wel **afmelden** voor surfacing
   (zie §6, `allow_circle`).
5. **Standaard-compatibel datamodel, simpel transport.** De content krijgt de **vorm**
   van **ActivityStreams 2.0 / schema.org**, maar v1 **transporteert** via een
   simpele **getekende pull** (geen volledige ActivityPub-server). De echte AP-brug
   (inbox/outbox, WebFinger, HTTP-signatures) komt in v2 als fediverse-koppeling.
   → Eert Bart's "gebruik de standaarden" én Robin's "licht & tolerant eerst".
6. **v1 = statisch.** Gecachte publieke kaarten. **Cross-instance comments/interactie
   blijft GEPARKEERD** — dáár komt de moderatie/abuse-ellende terug.

---

## 2. Tenancy-model

`app_settings.tenancy` krijgt een derde waarde:

| Modus | Structuur |
|---|---|
| `solo` | 1 site, geen federatie |
| `hub` | 1 instance, N sites, centraal beheerd |
| `circle` | 1 solo-site **+** een cirkel-feed van remote Klonkt-instances |

`circle` = functioneel "solo + cirkel-feature aan". `getTenancy()` wordt uitgebreid;
`resolveSite` gedraagt zich voor de lokale routes identiek aan `solo` (pin de primaire
site), met daarbovenop de cirkel-routes (§5).

```js
// SettingsService.js
export function getTenancy() {
  const v = getSetting('tenancy', 'solo');
  return v === 'hub' ? 'hub' : v === 'circle' ? 'circle' : 'solo';
}
```

---

## 3. Datamodel (nieuwe migratie)

Hergebruik bestaand: `sites.origin_server` (al `'local'` default), `sites.is_public`,
`sites.closed_circle_mode`. Nieuw:

```sql
-- Wie de lokale site volgt (asymmetrisch, lokaal beheerd)
CREATE TABLE IF NOT EXISTS circle_links (
    id            TEXT PRIMARY KEY,
    local_site_id TEXT NOT NULL,         -- onze site die deze bron toont
    remote_url    TEXT NOT NULL,         -- canonieke instance-URL (https://...)
    remote_actor_id TEXT,                -- ingevuld na eerste fetch
    label         TEXT,                  -- admin-notitie / weergavenaam
    status        TEXT DEFAULT 'active', -- active | paused | error
    added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced   DATETIME,
    last_error    TEXT,
    UNIQUE(local_site_id, remote_url),
    FOREIGN KEY (local_site_id) REFERENCES sites(id)
);

-- Gecachete remote actor (incl. publieke sleutel voor verificatie)
CREATE TABLE IF NOT EXISTS remote_actors (
    id            TEXT PRIMARY KEY,      -- = actor.id (de canonieke URL)
    url           TEXT UNIQUE NOT NULL,
    name          TEXT,
    summary       TEXT,
    avatar        TEXT,
    public_key    TEXT NOT NULL,         -- Ed25519, base64
    fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Gecachete remote posts (statische snapshot, AS-object)
CREATE TABLE IF NOT EXISTS remote_posts (
    id            TEXT PRIMARY KEY,      -- = object.id (remote canonieke URL)
    actor_id      TEXT NOT NULL,
    published     DATETIME,
    title         TEXT,
    summary       TEXT,                  -- platte tekst, gesanitized
    url           TEXT,                  -- link terug naar de bron
    media_json    TEXT,                  -- genormaliseerde media-refs (JSON)
    raw_json      TEXT,                  -- origineel AS-object (audit)
    fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_id) REFERENCES remote_actors(id)
);
```

> `circle_links` is bewust **per `local_site_id`** zodat het model meteen klopt als een
> hub later óók cirkels wil (elke site z'n eigen cirkel). Voor solo is er één site.

---

## 4. Het protocol (v1: getekende pull, AS-vormig)

Elke Klonkt-instance publiceert **twee statische, publieke JSON-documenten** op vaste
paden. Geen auth, geen inbox — alleen *lezen*.

### 4a. Actor — `GET /.klonkt/actor.json`

ActivityStreams `Person`/`Service`-actor met de **publieke sleutel** (Ed25519):

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://schema.org/"],
  "type": "Person",
  "id": "https://joostklein.klonkt.com/.klonkt/actor.json",
  "name": "Joost Klein",
  "summary": "Frisse gozer met platen.",
  "url": "https://joostklein.klonkt.com/",
  "icon": { "type": "Image", "url": "https://joostklein.klonkt.com/img/avatar.webp" },
  "outbox": "https://joostklein.klonkt.com/.klonkt/outbox.json",
  "publicKey": {
    "id": "https://joostklein.klonkt.com/.klonkt/actor.json#key",
    "owner": "https://joostklein.klonkt.com/.klonkt/actor.json",
    "algorithm": "ed25519",
    "publicKeyBase64": "M0r3...base64..."
  },
  "klonkt": { "version": 1, "allowCircle": true }
}
```

### 4b. Outbox — `GET /.klonkt/outbox.json`

AS `OrderedCollection` van recente `Create`→`Note`/`Audio`-objecten (alleen publieke
posts). Statisch gegenereerd bij elke post-mutatie (cache-bestand of route).

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "OrderedCollection",
  "id": "https://joostklein.klonkt.com/.klonkt/outbox.json",
  "totalItems": 2,
  "orderedItems": [
    {
      "type": "Create",
      "id": "https://joostklein.klonkt.com/posts/zomer-2026#create",
      "published": "2026-06-14T18:00:00Z",
      "actor": "https://joostklein.klonkt.com/.klonkt/actor.json",
      "object": {
        "type": "Article",
        "id": "https://joostklein.klonkt.com/posts/zomer-2026",
        "name": "Zomerplaat",
        "summary": "Nieuwe single uit.",
        "url": "https://joostklein.klonkt.com/posts/zomer-2026",
        "published": "2026-06-14T18:00:00Z",
        "attachment": [
          { "type": "Audio", "url": "https://joostklein.klonkt.com/audio/stream/zomer.mp3",
            "name": "Zomerplaat", "duration": "PT3M21S" }
        ]
      }
    }
  ]
}
```

### 4c. Tekenen + verifiëren (anti-spoofing)

- De instance tekent het **outbox-document** met z'n Ed25519-private sleutel.
  v1-keuze: **detached signature in een HTTP-header** bij de outbox-respons:
  `Klonkt-Signature: ed25519=<base64(sig over raw body)>`.
  (Eenvoudiger dan HTTP Message Signatures; v2 kan naar de RFC-9421-variant.)
- Consument: fetch `actor.json` → pak `publicKeyBase64` → fetch `outbox.json` →
  verifieer `Klonkt-Signature` over de **ruwe body** met die sleutel. Mismatch → drop +
  `circle_links.status='error'`, `last_error` gevuld.
- **TOFU** (trust-on-first-use): de eerste keer wordt de pubkey gecachet in
  `remote_actors`. Verandert 'ie later → waarschuw de admin (key-rotation = expliciete
  her-bevestiging), zoals SSH.

> Sleutelopslag lokaal: genereer per-instance één Ed25519-keypair bij eerste start,
> bewaar in `app_settings` (`circle_privkey` / `circle_pubkey`, base64). Privé-sleutel
> nooit serveren; alleen de publieke in `actor.json`.

---

## 5. Server-flow & routes

### 5a. Publiceren (onze kant)
- Genereer/ververs `/.klonkt/actor.json` + `/.klonkt/outbox.json` (alleen `is_public`
  posts; respecteer `allow_circle`). Trigger: post-create/update/delete + nightly.
- Statisch cachen (bestand of in-memory) + de `Klonkt-Signature`-header zetten.

### 5b. Pullen (cirkel verversen) — `CircleService.sync()`
Periodiek (cron, bv. elke 15 min) + handmatige "ververs"-knop:
```
voor elke circle_links (status=active):
  fetch remote_url + '/.klonkt/actor.json'      (volg redirect naar canoniek)
  upsert remote_actors (pubkey TOFU-check)
  fetch actor.outbox  (met Klonkt-Signature)
  verifieer signature met pubkey   -> faal? status=error, continue
  voor elk Create/object: sanitize + upsert remote_posts
  circle_links.last_synced = now, status=active
```
Robuust/tolerant: time-outs, max body-size, alleen `https`, alleen verwachte velden,
onbekende velden negeren (Postel's law — Bart's "tolerant & robuust").

### 5c. Tonen — nieuwe route `/cirkel` (+ feed-blok op de home)
- `routes/circle.js` (mount alleen als `tenancy==='circle'`): toont een
  tijd-gesorteerde **statische kaarten-feed** van `remote_posts` (titel, samenvatting,
  bron-avatar/naam, "via <instance>"-badge, link terug naar de bron). Geen interactie.
- Optioneel een compacte "Uit je cirkel"-strook op de solo-home.
- Media: v1 toont een **link/representatie** terug naar de bron (geen herhosting). De
  `media_json` mag een resting-kaart renderen die naar de bron-URL linkt (embeddable
  komt in v2; nu geen cross-host streaming/CSP-gedoe).

### 5d. Beheer-UX — Beheer → **Cirkel**
- Lijst van `circle_links` met status (✓ active / ⏸ paused / ⚠ error + reden).
- Input "Voeg een Klonkt-site toe" (plak URL) → validatie (fetch actor, toon
  naam/avatar ter bevestiging) → opslaan.
- Per bron: pauzeren / verwijderen / nu-verversen.
- Toggle **"Mijn site mag in cirkels van anderen verschijnen"** → `sites.is_public`
  i.c.m. een nieuwe `allow_circle`-flag (default aan) → stuurt `actor.allowCircle`.

---

## 6. Privacy, veiligheid, edge-cases

- **Opt-out van surfacing**: `allow_circle=0` → onze `actor.json`/`outbox.json` geven
  `allowCircle:false` + lege outbox. Een nette consument respecteert dat (zoals
  robots). Hard afdwingen kan niet (publieke bytes) — eerlijk benoemen, zoals het web.
- **Remote HTML-sanitatie**: remote `summary`/titels strikt strippen naar platte tekst
  vóór opslag/rendering (geen remote HTML/CSS in onze DOM → geen XSS-import; vgl. de
  `mailapp`-keuze om geen vreemde HTML te injecteren).
- **Alleen https**, redirect-limiet, body-size-limiet, fetch-timeout, rate-limit per
  bron. Verifieer dat `object.id`/`url` op **hetzelfde origin** als de actor staan
  (anti-impersonatie: bron mag geen posts "namens" een andere instance claimen).
- **Key-rotation** = expliciete admin-herbevestiging (TOFU).
- **Verwijderingen**: outbox is de bron van waarheid; remote_posts die niet meer in de
  outbox staan → opruimen (tombstone of hard delete) bij sync.
- **Geen wederkerigheid afdwingen** — bewust. Discovery = handmatig URL toevoegen.

---

## 7. Wat v1 NIET doet (expliciet geparkeerd)
- Cross-instance **comments/likes/interactie** (moderatie/abuse-risico).
- **Herhosting** van remote audio/media (v1 linkt terug; embeddable = v2).
- Volledige **ActivityPub** (inbox, bezorging, WebFinger, HTTP-signatures) — v2-brug.
- Centrale **discovery/index**.

---

## 8. Toekomst (v2+, voorbereid maar niet gebouwd)
- **ActivityPub-brug**: omdat de datavorm al AS 2.0 is, is de stap naar een echte
  `inbox`/`outbox` + RFC-9421 HTTP Message Signatures + WebFinger incrementeel — dan
  praat Klonkt ook met Mastodon/fediverse. Premium/optioneel.
- **Embeddable content**: cross-host players (hergebruik het bestaande embed-player +
  PlaybackRegistry-patroon), met CSP-uitbreiding per vertrouwde bron.
- **Hub × cirkels**: een hub-site kan zelf een cirkel hebben (model is er al klaar voor
  via `circle_links.local_site_id`).

---

## 9. Implementatie-volgorde (incrementeel, elk los testbaar)
1. Migratie (3 tabellen) + `getTenancy` → `circle` + Beheer-toggle.
2. Eigen publicatie: keypair-bootstrap + `/.klonkt/actor.json` + `/.klonkt/outbox.json`
   + `Klonkt-Signature`. (Testbaar: `curl` + signatuur-verify-scriptje.)
3. `CircleService.sync()` (fetch+verify+cache) + cron + "ververs"-knop.
4. Beheer → Cirkel (toevoegen/lijst/status).
5. `/cirkel`-feed (statische kaarten) + home-strook.
6. Sanitatie/security-hardening + adversariële review (signatuur-spoof, cross-origin
   object-id, XSS-import, key-rotation).
