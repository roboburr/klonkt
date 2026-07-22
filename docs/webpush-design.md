# Web Push (VAPID) — ontwerp

Achtergrond-notificaties naar de browser/PWA van de site-eigenaar: nieuwe
follow, reply/mention, like, boost of DM, ook als de site dicht is. Zelf-gehost
(RFC 8030 + VAPID, RFC 8292), payload end-to-end versleuteld naar de browser
(RFC 8291): de push-dienst van de browser (Mozilla/Google/Apple) ziet alleen
ciphertext.

Dit is het model van Mastodon (`POST /api/v1/push/subscription`), aangepast aan
Klonkt-conventies. Er is geen FEP voor achtergrond-push; FEP-3ab2 (SSE) dekt
alleen live-terwijl-open en leunt op een cookie-ticket, wat niet bij Klonkt past.

## Beslissingen

- **Dependency: `web-push` (npm), bewust.** De RFC 8291-payload-encryptie
  (ECDH + HKDF + aes128gcm) en de VAPID-JWT zijn precies de fiddly,
  security-gevoelige laag die je niet zelf naschrijft. Lazy import, zoals
  @simplewebauthn/server: een canary die autofollowt vóór `npm ci` mag nooit
  op boot crashen.
- **VAPID-sleutels: env wint, anders auto-gegenereerd bestand.** Zelfde patroon
  als SESSION_SECRET/PAID_SECRET: `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/
  `VAPID_SUBJECT` in env als gezet, anders `storage/.vapid` (JSON, 0600),
  eenmalig gegenereerd. NOOIT regenereren zolang het bestand bestaat: nieuwe
  keys maken alle bestaande abonnementen ongeldig. Back-up = hele storage/-map.
- **Subject**: `PUBLIC_BASE_URL` als die er is (VAPID staat https-URL toe),
  anders `mailto:` fallback uit SMTP_FROM, anders een placeholder-mailto.
- **Abonnement hangt aan de ingelogde gebruiker** (sessie op het eigen domein).
  Web Push zelf is cookieloos; alleen het aan/uitzetten is een ingelogde actie.
- **Payload minimaal**: titel + korte body + doel-URL. Geen volledige teksten
  van DM's (de push-dienst ziet metadata, nooit meer inhoud dan nodig).

## Datamodel (additief)

```
push_subscriptions
  endpoint      TEXT PRIMARY KEY   -- push-dienst-URL van de browser
  user_id       TEXT NOT NULL      -- wie dit abonnement aanzette
  p256dh        TEXT NOT NULL      -- client public key (RFC 8291)
  auth          TEXT NOT NULL      -- client auth secret (RFC 8291)
  alert_types   TEXT               -- JSON: {"follow":1,"reply":1,"like":0,"boost":0,"dm":1}
  ua_label      TEXT               -- vrije apparaat-omschrijving voor de lijst
  created_at    DATETIME
  last_ok_at    DATETIME           -- laatste geslaagde push
```

## Flow

1. Eigenaar opent Beheer → Notificaties, klikt "Zet aan op dit apparaat".
2. Browser vraagt permissie (moet via user-gesture), `pushManager.subscribe`
   met de publieke VAPID-key → `POST /push/subscribe` slaat endpoint+keys op.
3. Er gebeurt iets (follow/reply/like/boost/DM in de S2S-inbox):
   `PushService.notifySite(slug, event)` → per abonnement van de eigenaar,
   gefilterd op alert_types, `web-push sendNotification` met versleutelde
   payload.
4. Service worker (`push`-event) toont de notificatie; klik opent de doel-URL.
5. 404/410 van de push-dienst → abonnement verwijderd (device weg/ingetrokken).

## Triggerpunten (S2S-inbox, ActivityPubService)

- `Follow` (na Accept): "X volgt je nu".
- `Create` Note/reply → interaction 'reply': "X reageerde op <post>".
- `Like` / `Announce` op eigen post: "X vond <post> leuk" / "X boostte <post>".
- Prutter-DM (direct note): "Nieuw bericht van X" (zonder inhoud).

Elke trigger is fire-and-forget (`.catch` → log), mag delivery nooit blokkeren.

## Caveats

- **iOS**: alleen voor een geïnstalleerde PWA (Add to Home Screen, iOS 16.4+),
  en alleen na een user-gesture. De UI toont die hint op iOS-Safari.
- **Key-rotatie breekt alles**: storage/.vapid is heilig, zie boven.
- **Shaer-native** (APNs/FCM/UnifiedPush-relay) valt buiten dit pad; de
  payload-vorm (JSON title/body/url/type) is er alvast op voorbereid.

## Slices

- 0: dit document
- 1: web-push dep + VAPID-sleutelbeheer + GET /push/vapid
- 2: tabel + subscribe/unsubscribe + SW-handlers + Beheer-pagina + testknop
- 3: echte triggers (follow/reply/like/boost/DM) met per-type voorkeuren
- 4: pruning-bevestiging, throttle, iOS-hint-polish
