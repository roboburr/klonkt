# Paid posts: design (slice 0 spike)

Reference for building the paid-posts feature (klonkt-demo-aki). Premium
feature: site-owner's own Patreon patrons unlock paid posts with a passkey.
No cookies, no patron identity stored, re-link on expiry. The privacy statement
`privacy-betaalde-posts.md` is the promise this design must keep.

## Decisions (fixed)

1. Revocation = re-link + TTL (~30 days). Store NO patron id, not even hashed or
   encrypted. An entitlement is `{ passkey, site, proven cents, expiry }`.
2. WebAuthn via a dependency: `@simplewebauthn/server` (server) +
   `@simplewebauthn/browser` (client).
3. Strictly no cookie / session / localStorage in this flow. Every unlock is a
   standalone passkey assertion.

Klonkt Premium (the license-server Ed25519 flow, `patreon_*` settings) is a
separate layer and stays untouched. This feature never reuses those settings.

## Dependency check

`@simplewebauthn/server` 13.3.2, MIT, `engines.node >=20` (we run v20.18). Pulls
`@levischuck/tiny-cbor`, `@hexagon/base64`, and several `@peculiar/asn1-*` +
`@peculiar/x509` (attestation/cert parsing). Footprint is real but all MIT and
maintained; acceptable given the explicit go-ahead for a dependency. Client uses
`@simplewebauthn/browser` (MIT). We only need registration + assertion of
discoverable credentials; no attestation is required (`attestationType: 'none'`),
which keeps the cert-parsing paths cold.

## Patreon API v2 (verified)

- Authorize: `GET https://www.patreon.com/oauth2/authorize`
- Token: `POST https://www.patreon.com/api/oauth2/token` (also `grant_type=refresh_token`)
- Scopes: `identity`, `identity.memberships`, `campaigns`, `campaigns.members`.
- Owner (creator): when they register an API client they get client id + secret
  AND a creator access + refresh token directly, no OAuth dance needed. Tokens
  carry `expires_in`; refresh with the refresh token. So the owner setup can be
  as light as "paste your Patreon client id + secret" and we mint/refresh from
  there, or a one-time creator OAuth. We only need the creator token to verify a
  patron during their link step (below).
- Patron (visitor): OAuth with `identity.memberships`, then
  `GET /api/oauth2/v2/identity?include=memberships.campaign&fields[member]=patron_status,currently_entitled_amount_cents`.
  Response is JSON:API: walk `data.relationships.memberships.data` for member ids,
  match them in `included`, and for each member read `patron_status` +
  `currently_entitled_amount_cents`; the member's `relationships.campaign`
  points at the campaign object (also in `included`) so we can pick the one that
  matches the owner's campaign id.
- Rate limits: 100 req / 2s per client, 100 req/min per token; 429 carries
  `retry_after_seconds`. Fine: the patron path is one call per link, and the
  owner-token path is one call per link too. No polling.

## The cookie-less trick (used twice)

No session means no server-side "pending state" bound to a browser. Both the
OAuth `state` and the WebAuthn `challenge` are made stateless with a signed,
short-lived blob:

```
blob = base64url( JSON{ nonce, site, purpose, cents?, exp } )
tag  = HMAC-SHA256(PAID_SECRET, blob)     // key from env, never in the DB dump for this
token = blob + "." + tag
```

- OAuth: `state = token`. On the Patreon callback we verify the tag + `exp`,
  read `site`/`purpose`, and never needed a cookie.
- WebAuthn: the challenge we hand the browser is such a token (purpose
  `register` or `assert`, plus the target post/tier). On verify we re-derive and
  check it. `@simplewebauthn/server` lets us pass the expected challenge in, so
  we compare the returned challenge to our re-verified token.

`PAID_SECRET` (32 random bytes) lives in env, like the other secrets.

## Data model (additive)

New table `paid_patreon` (one row per site owner's campaign):

| column | note |
| --- | --- |
| `site_id` | PK |
| `client_id` | the owner's Patreon API client id |
| `client_secret_enc` | AES-256-GCM, key from env |
| `campaign_id` | the owner's campaign |
| `access_token_enc`, `refresh_token_enc`, `token_exp` | creator token, encrypted |
| `default_min_cents` | default price gate for a paid post |
| `updated_at` | |

New table `paid_entitlements` (one row per passkey, NO patron identity):

| column | note |
| --- | --- |
| `credential_id` | PK, the WebAuthn credential id (opaque) |
| `site_id` | which site this passkey is entitled on |
| `public_key` | COSE public key for assertion verification |
| `counter` | WebAuthn signature counter |
| `transports` | optional |
| `min_cents` | the amount the patron proved at link time (the tier they hold) |
| `expires_at` | TTL; re-link after |
| `created_at` | |

Posts gain two additive columns: `paid` (INTEGER 0/1) and `paid_min_cents`
(INTEGER, null = use `default_min_cents`).

Encryption helper is new (the codebase has none): `aes-256-gcm`, key =
`scryptSync(PAID_SECRET, 'paid', 32)`, random iv per value, store `iv:tag:ct`.

## Flows

Owner link (slice 1, premium-gated in Beheer):
1. Owner pastes Patreon client id + secret (or does a one-time creator OAuth),
   sets the campaign and a default price.
2. We store the (encrypted) creator token + campaign id in `paid_patreon`.
3. A refresh path renews the creator token before `token_exp`, and a de-auth
   clears the row.

Patron link (slice 3, no cookie):
1. Visitor clicks "unlock via Patreon" on a paid post. We build a signed `state`
   (purpose `link`, site, the post's required cents) and redirect to Patreon
   authorize with `identity.memberships`.
2. Callback verifies `state`, exchanges the code, calls identity?include=
   memberships.campaign, finds the membership for the owner's campaign, checks
   `patron_status == 'active_patron'` and `currently_entitled_amount_cents >=`
   the required cents.
3. If ok, we run WebAuthn registration (discoverable credential,
   `attestationType: 'none'`), store `{credential_id, site, public_key, counter,
   min_cents = entitled cents, expires_at = now + TTL}` in `paid_entitlements`.
   The Patreon code/token is discarded here; nothing identifying is kept.

Unlock (slice 4, per post, no cookie):
1. Paid post page shows the teaser + an "unlock" button and a WebAuthn assert
   challenge (our signed token, purpose `assert`, carrying the post's required
   cents).
2. Browser produces an assertion with the discoverable credential; we verify it
   with `@simplewebauthn/server` against the stored `public_key`, check the
   entitlement's `min_cents >=` required and `expires_at` in the future, bump
   `counter`, and return the full content in that same response. No unlock token
   becomes state.

Expiry (slice 5): the Scheduler prunes rows past `expires_at`; the unlock button
falls back to the link flow when no valid entitlement asserts. A "forget this
passkey" action deletes the row after an assertion proves ownership (the GDPR
delete path from the privacy statement).

## Federation

A paid post MUST NOT federate its full content (that would leak past the gate).
It federates a teaser + a link back, like the `fan_only` path already limits
delivery. Touches `buildNote`. Decide the exact teaser at slice 2.

## Open items to settle while building

- Owner setup: creator-token-paste vs one-time creator OAuth. Paste is simplest
  (Patreon hands the token on client registration); OAuth is friendlier. Pick in
  slice 1.
- WebAuthn RP id: the site host. In hub mode each site is a subpath, not a
  subdomain, so one RP id per instance host, scoped by `site_id` in the row.
  Confirm hub behavior in slice 3.
- TTL exact value + whether to also cap by Patreon's `currently_entitled` at
  assert time (we do not re-call Patreon on unlock by design; the TTL is the
  freshness bound).
- No-JS: WebAuthn needs JS. A paid post without JS shows only the teaser + the
  link-to-Patreon path. Acceptable.
