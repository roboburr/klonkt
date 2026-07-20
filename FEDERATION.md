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
- [OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749) public clients with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), S256 only)
- [OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414) ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414))
- [OAuth 2.0 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591) ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591))

## Supported FEPs

- [FEP-67ff: FEDERATION.md](https://codeberg.org/fediverse/fep/src/branch/main/fep/67ff/fep-67ff.md) (FINAL): this file.
- [FEP-f1d5: NodeInfo in Fediverse Software](https://codeberg.org/fediverse/fep/src/branch/main/fep/f1d5/fep-f1d5.md) (FINAL): `/.well-known/nodeinfo` links to a NodeInfo 2.1 document advertising software, version and the `activitypub` protocol.

Beyond these, Klonkt aims for de-facto Mastodon compatibility (the
`http://joinmastodon.org/ns#` extension terms below). See "Under consideration"
for FEPs we track but do not yet implement.

## ActivityPub

### Actor

Each site exposes a `Person` actor at `/ap/users/:slug` with `inbox`, `outbox`,
`followers`, `following` and `featured` collections, and an RSA-2048 public key
under the legacy `publicKey` / `publicKeyPem` field
([w3id security/v1](https://w3id.org/security/v1)). The actor advertises
`discoverable`, `manuallyApprovesFollowers` (currently always `false`),
`featured`, and profile metadata as `schema:PropertyValue` links (including
`rel="me"` verification links). Actor and object requests are
content-negotiated: `application/activity+json` returns the AP document, other
`Accept` values redirect to the human profile page.

### Activities sent

`Create`, `Update`, `Delete` (as `Tombstone`), `Follow`, `Accept`, `Like`,
`Announce`, `Undo` (of `Follow` / `Like` / `Announce`), `Add` / `Remove`
(featured-pin sync), and `Flag` (moderation reports). Posts, replies, boosts,
likes and follows are delivered to remote inboxes with a signed HTTP request and
a retrying delivery queue.

### Activities received

`Create`, `Update`, `Delete`, `Follow`, `Accept`, `Reject`, `Like`, `Announce`,
`Undo` and `Flag`. Inbound follows are answered with `Accept` and backfilled with
recent posts. Every inbound activity must carry a valid HTTP signature; unsigned
or unverifiable requests are rejected.

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
- Object Integrity Proofs: FEP-8b32 (DRAFT). Not used.
- Followers collection synchronization: FEP-8fcf (FINAL). Not implemented.
- Quote posts: FEP-044f (DRAFT). Quotes appear as replies with an inline link.

A guardian-gated actor model (guardianship for wards, gated follows and replies)
is being drafted separately as a candidate FEP.

## Additional documentation

- Client-to-Server API for apps (the Shaer contract): `docs/shaer-c2s-api.md`.
- Source code: `src/services/ActivityPubService.js` (core AP logic),
  `src/routes/activitypub.js` (S2S, WebFinger, NodeInfo),
  `src/routes/oauth.js` (C2S / OAuth).
- Changelog: `CHANGELOG.md` (and `CHANGELOG.nl.md`, `CHANGELOG.de.md`).
