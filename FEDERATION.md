# Federation

Klonkt is a small single-tenant fediverse site engine. Each site is one
ActivityPub actor (a `Person`) that federates its posts, replies, boosts,
likes, follows and polls, and that native or web apps can drive over
ActivityPub Client-to-Server. This document describes what Klonkt speaks on the
wire, following [FEP-67ff](https://codeberg.org/fediverse/fep/src/branch/main/fep/67ff/fep-67ff.md).

## Supported federation protocols and standards

- [ActivityPub](https://www.w3.org/TR/activitypub/) Server-to-Server (S2S)
- [ActivityPub](https://www.w3.org/TR/activitypub/) Client-to-Server (C2S), over OAuth 2.0
- [WebFinger](https://webfinger.net/) ([RFC 7033](https://www.rfc-editor.org/rfc/rfc7033))
- [HTTP Signatures](https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures) (draft-cavage), `rsa-sha256`
- [NodeInfo](https://nodeinfo.diaspora.software/) 2.1
- [OpenWebAuth](https://codeberg.org/fediverse/fep/src/branch/main/fep/61cf/fep-61cf.md) single sign-on, both roles (see "Authentication")
- [OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749) public clients with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), S256 only)
- [OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414) ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414))
- [OAuth 2.0 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591) ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591))

## Supported FEPs

- [FEP-67ff: FEDERATION.md](https://codeberg.org/fediverse/fep/src/branch/main/fep/67ff/fep-67ff.md) (FINAL): this file.
- [FEP-f1d5: NodeInfo in Fediverse Software](https://codeberg.org/fediverse/fep/src/branch/main/fep/f1d5/fep-f1d5.md) (FINAL): `/.well-known/nodeinfo` links to a NodeInfo 2.1 document advertising software, version and the `activitypub` protocol.
- [FEP-e232: Object Links](https://codeberg.org/fediverse/fep/src/branch/main/fep/e232/fep-e232.md) (FINAL): `Link` tags with `mediaType` `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` for object references inside content.
- [FEP-044f: Consent-respecting quote posts](https://codeberg.org/fediverse/fep/src/branch/main/fep/044f/fep-044f.md) (DRAFT): a quoted fediverse object carries real quote semantics — the `quote` property plus an FEP-e232 `Link` tag — and renders as a quote card rather than a bare link.
- [FEP-9098: Custom emojis](https://codeberg.org/fediverse/fep/src/branch/main/fep/9098/fep-9098.md) (DRAFT): `:shortcode:` emoji tags on content and display names, preserved on the wire so connected apps can render them.
- [FEP-c648: Blocked Collection](https://codeberg.org/fediverse/fep/src/branch/main/fep/c648/fep-c648.md) (DRAFT): inbound `Block` and `Undo(Block)` are honoured.
- [FEP-7628: Move actor](https://codeberg.org/fediverse/fep/src/branch/main/fep/7628/fep-7628.md) (DRAFT): account migration — `alsoKnownAs`, `movedTo` and the `Move` activity, sent and received. See "Account migration".
- [FEP-1580: Move Actor Objects with a `migration` Collection](https://codeberg.org/fediverse/fep/src/branch/main/fep/1580/fep-1580.md) (DRAFT): the objects a `Move` leaves behind, exposed as a `migration` collection alongside `moves`.
- [FEP-61cf: The OpenWebAuth Protocol](https://codeberg.org/fediverse/fep/src/branch/main/fep/61cf/fep-61cf.md) (DRAFT): federated single sign-on, implemented in **both** roles. As a *target*, Klonkt lets a visitor from another server prove who they are and read follower-only posts without an account here. As a *home instance*, a site owner can sign in to another OpenWebAuth site using their own actor. See "Authentication".
- [FEP-888d: Using `https://w3id.org/fep` as a base for FEP-specific namespaces](https://codeberg.org/fediverse/fep/src/branch/main/fep/888d/fep-888d.md) (DRAFT): the FEP-1580 terms are declared under `https://w3id.org/fep/1580/`, as that FEP registers them.

Two further proposals are our own and are not (yet) part of the FEP index:

- **FEP-633c: Guardians** — guardian-gated actors: wards, gated follows and
  replies, the call-in flow, and a multi-party handshake. Implemented here and
  submitted upstream as pull request
  [#889](https://codeberg.org/fediverse/fep/pulls/889); the vocabulary is served
  at [`https://ns.klonkt.com/shaer`](https://ns.klonkt.com/shaer).
- **FEP-9876: enriched actor references** — collection members are bare URIs by
  default and embedded objects on request, opt-in through
  `Prefer: return=representation` ([RFC 7240](https://www.rfc-editor.org/rfc/rfc7240)).
  Implemented; not yet submitted.

Beyond these, Klonkt aims for de-facto Mastodon compatibility (the
`http://joinmastodon.org/ns#` extension terms below). See "Under consideration"
for FEPs we track but do not yet implement.

## ActivityPub

### Actor

Each site exposes a `Person` actor at `/ap/users/:slug` with `inbox`, `outbox`,
`followers`, `following` and `featured` collections, and an RSA-2048 public key
under the legacy `publicKey` / `publicKeyPem` field
([w3id security/v1](https://w3id.org/security/v1)). The actor advertises
`discoverable`, `manuallyApprovesFollowers` (true for a ward, and for any site
with owner approval switched on — see "Follow approval"),
`featured`, and profile metadata as `schema:PropertyValue` links (including
`rel="me"` verification links). Actor and object requests are
content-negotiated: `application/activity+json` returns the AP document, other
`Accept` values redirect to the human profile page.

### Activities sent

`Create`, `Update`, `Delete` (as `Tombstone`), `Follow`, `Accept`, `Like`,
`Announce`, `Undo` (of `Follow` / `Like` / `Announce`), `Add` / `Remove`
(featured-pin sync), `Flag` (moderation reports), `Move` (account migration),
and `Offer` (the FEP-633c guardianship handshake). Posts, replies, boosts,
likes and follows are delivered to remote inboxes with a signed HTTP request and
a retrying delivery queue.

### Activities received

`Create`, `Update`, `Delete`, `Follow`, `Accept`, `Reject`, `Like`, `Announce`,
`Undo`, `Flag`, `Block`, `Move` and `Offer`. Inbound follows are answered with
`Accept` and backfilled with recent posts. Every inbound activity must carry a
valid HTTP signature; unsigned or unverifiable requests are rejected.

### Object types

- `Note`: posts and replies, including rich replies with formatting and media.
- `Question`: polls, single (`oneOf`) or multiple (`anyOf`) choice, with
  `endTime`, `closed`, and Mastodon's `toot:votersCount`. Votes are received as a
  `Note` with a `name` matching an option and `inReplyTo` the question. Tallies
  are pushed to followers as `Update(Question)`.
- `Image`, `Audio`, `Video`: media attachments with `mediaType`, `url` and `name`
  (alt text). Audio attachments may carry cover art in `icon`.
- `Tombstone`: in `Delete` activities.

### Extensions and compatibility terms

Every emitted object carries the full `@context`. Beyond AS2 core and
security/v1, Klonkt declares and uses:

- `as:sensitive` and `summary` for content warnings (blurred media, hidden text).
- `as:Hashtag` tag objects (`#Tag`, linked to `/tag/:slug`).
- `Mention` tag objects (`@user@host`, linked to the actor), resolved outbound
  via WebFinger.
- `contentMap`: BCP-47 language maps on posts and replies (Mastodon language
  filter and translate).
- `toot:discoverable`, `toot:featured`, `toot:votersCount`.
- `schema:PropertyValue` / `schema:value` for profile metadata, and
  `schema:embedUrl` for player-card embeds.

### Collections

- `followers` and `following` are count-only for the public. An authenticated
  request from the site owner (a C2S bearer token scoped to that site) returns the
  full list of actor URIs, so a connected app can build a contacts list.
- `featured` lists pinned posts. Pin and unpin federate immediately as
  `Add` / `Remove`, serialized per site to keep Mastodon's pin order.
- A note's `replies` collection is served, and inbound threads are crawled one
  level at a time (stale-while-revalidate, SSRF-guarded, budget-limited).

## Account migration

Klonkt implements account moves in both directions, following
[FEP-7628](https://codeberg.org/fediverse/fep/src/branch/main/fep/7628/fep-7628.md)
for the actor and
[FEP-1580](https://codeberg.org/fediverse/fep/src/branch/main/fep/1580/fep-1580.md)
for the objects the actor leaves behind.

- **Actor terms.** `alsoKnownAs` and `movedTo` are declared with the same term
  definitions Mastodon ships, so an existing implementation reads them without
  special-casing. `alsoKnownAs` is reserved for former identities of the same
  actor; a reference to an external register (a MusicBrainz artist, say) uses
  `schema:sameAs` instead, precisely so that a move cannot be confused by it.
- **The `Move` activity** is both sent and received. FEP-7628 moves *followers*
  and says so explicitly; the objects are a separate problem, which is what
  FEP-1580 addresses.
- **Object migration.** A migrated site exposes a `migration` collection and a
  `moves` collection, plus `migrationComplete`, `migratedFrom` and `migratedAt`.
  The terms live under `https://w3id.org/fep/1580/`, the namespace that FEP
  registers by way of FEP-888d. The FEP's own CURIE for the collection is
  `migration:migration`; Klonkt emits the JSON key `migration`, because that is
  what a consumer reads on.
- **Importing.** An import from an export is not treated as a separate case: the
  same path ingests from a source actor.

One gap is worth stating plainly: the `moves` collection carries **no integrity
proof**. Without [FEP-8b32](https://codeberg.org/fediverse/fep/src/branch/main/fep/8b32/fep-8b32.md)
there is no signature under it, so a consumer has to trust the serving host
rather than the claim itself. This is tracked and not yet resolved.

## Client-to-Server (C2S)

Native and web apps drive an account over ActivityPub C2S. This is not the
Mastodon client API: Mastodon apps (Ivory and the like) are not supported here.

- Discovery: the actor advertises its OAuth endpoints, and
  `/.well-known/oauth-authorization-server` (RFC 8414) returns the authorization,
  token and registration endpoints, `response_types=["code"]`,
  `grant_types=["authorization_code"]`, `code_challenge_methods=["S256"]`,
  `token_endpoint_auth_methods=["none"]` and `scopes_supported=["c2s"]`.
- Registration: `POST /oauth/register` (RFC 7591), public clients only.
- Authorization: PKCE authorization-code flow with a consent screen where the
  user picks which site the app may act for. Tokens are hashed at rest and bound
  to a single user and site.
- Outbox: `POST /ap/users/:slug/outbox` with a bearer token accepts `Create`
  (a bare `Note` is wrapped in a `Create` per spec), `Like`, `Announce`,
  `Follow` and their `Undo`. Content is sanitized; a token cannot post for a
  different site. `Delete` and `Update` over C2S are not yet implemented.

## Authentication

- S2S: HTTP Signatures (draft-cavage), `rsa-sha256`, over
  `(request-target) host date digest`, with a configurable clock-skew tolerance
  and reverse-proxy-aware host matching. Object Integrity Proofs
  (FEP-8b32) are not used.
- C2S: OAuth 2.0 bearer tokens, public clients with PKCE (S256), scope `c2s`.
- Visitors: OpenWebAuth (FEP-61cf), described below.

### OpenWebAuth (FEP-61cf)

Klonkt implements both roles.

**As a target instance.** A visitor enters their fediverse address; we WebFinger
it for a `http://purl.org/openwebauth/v1#redirect` link (falling back to `/magic`
on the same host, as Hubzilla and (streams) do) and send them there. Their server
then makes a signed request to our token endpoint at `/owa/token`, which accepts
both `GET` and `POST`. We verify the HTTP Signature with the same code path that
verifies inbox deliveries — the key is pinned to the origin the actor document
was fetched from, the signed `Date` must be recent, and a body requires a signed
digest — then return a single-use token encrypted to the actor's public key
(PKCS #1 v1.5, URL-safe Base64, unpadded). The visitor returns with `?owt=`, we
redeem the token once and know who they are.

Discovery for the other side: a WebFinger query for this server's root URL
returns a `http://purl.org/openwebauth/v1` link pointing at `/owa/token`. An
actor's WebFinger response carries the `#redirect` link pointing at `/magic`.

**As a home instance.** `/magic` takes an OpenWebAuth request for a logged-in
owner, discovers the target's token endpoint, requests a token over a signed
request, decrypts it with the site's private key and returns the visitor with
`?owt=`. On Klonkt the fediverse identity is the *site* actor, so an owner with
several sites picks which one to present. There is a consent screen: FEP-61cf
warns under "Information leakage" that OpenWebAuth hands a strong identity claim
to any site that asks, so the detour through the home instance is where the user
can decline.

Notes for implementers:

- The signature travels in `Authorization: Signature …`, as FEP-61cf requires,
  not in the `Signature` header the rest of the fediverse uses. Our token
  endpoint accepts either.
- Signed requests we send also carry a signed `X-Open-Web-Auth` header with
  random content, per the FEP.
- `?zid=` may start the flow but never establishes identity; only a redeemed
  `?owt=` does. `?owt=` is stripped from the URL after redemption.
- Tokens are single-use and expire after three minutes; expired ones are swept
  on every issue and redemption.
- A discovered endpoint must share the origin it was discovered for. If
  discovery fails, `/magic` returns an error rather than redirecting, so it
  cannot be used as an open redirector.

What this unlocks: `fan_only` posts. That gate used to ask for a local account,
which is the wrong question — it excluded exactly the followers it was meant to
admit. It now asks whether the proven actor follows this site.

### Follow approval

A site can require the owner to approve followers. With it on, the actor
advertises `manuallyApprovesFollowers: true`, an inbound `Follow` is held
pending instead of auto-accepted, and the owner accepts (sending `Accept` plus a
backfill) or rejects (sending `Reject`). Ward actors always gate this way
through their guardians, which takes precedence. A pending request is not a
follower, and so does not open follower-only posts.

## Moderation and safety

- Inbound `Flag` reports are stored for the site owner; the owner can send an
  outbound `Flag` to a remote actor's server.
- The owner can remove an inbound reply from a thread; a tombstone prevents the
  thread crawler from re-fetching it.
- Actor and domain blocks silently drop matching activities (no error
  disclosure) and purge existing content.
- All outbound fetches are SSRF-guarded (private-range IP blocking on every
  redirect hop, per-request timeout).

## Under consideration (not yet implemented)

Klonkt tracks the following proposals but does not implement them yet. Draft
specs are marked; per project policy, drafts are only adopted deliberately and
with a note in the changelog.

- Reply control. FEP-5624 (per-object reply control) is WITHDRAWN as of
  2025-06-24; its Mastodon terms `canReply` / `ApproveReply` / `RejectReply`
  remain in production use. The live successor discussion is in drafts FEP-171b
  (conversation containers), FEP-7458 (replies collection) and FEP-11dd (context
  ownership). Klonkt currently accepts all replies to its posts.
- Search-indexing consent: FEP-5feb (DRAFT). No `indexable` flag is emitted yet.
- Actor public keys as Multikey: FEP-521a (FINAL). Klonkt still uses the legacy
  `publicKey` representation.
- Object Integrity Proofs: FEP-8b32 (DRAFT). Not used. This is also what leaves
  the `moves` collection unsigned; see "Account migration".
- Followers collection synchronization: FEP-8fcf (FINAL). Not implemented.

## Additional documentation

- Client-to-Server API for apps (the Shaer contract): `docs/shaer-c2s-api.md`.
- Source code: `src/services/ActivityPubService.js` (core AP logic),
  `src/routes/activitypub.js` (S2S, WebFinger, NodeInfo),
  `src/routes/oauth.js` (C2S / OAuth),
  `src/services/OpenWebAuthService.js` and `src/routes/openwebauth.js`
  (OpenWebAuth, both roles).
- Changelog: `CHANGELOG.md` (and `CHANGELOG.nl.md`, `CHANGELOG.de.md`).
