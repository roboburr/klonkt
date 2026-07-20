# Shaer to Klonkt: the C2S API

This documents the contract the Shaer apps (iOS, Android) use to drive a Klonkt
account. It is ActivityPub Client-to-Server (C2S) over OAuth 2.0, plus a few
`shaer:` extension terms from FEP-633c. It is not the Mastodon client API:
Mastodon apps use their own API and are not served here.

Everything is discovered, never hardcoded: a client resolves a handle to an
actor document and reads the endpoints from it, so the same client works against
any Klonkt instance (and degrades gracefully against other AP servers).

Base URL below is the instance origin, e.g. `https://klonkt.example`. All AP
requests send and accept `application/activity+json`.

## 1. Discovery

1. **WebFinger** the handle:
   `GET /.well-known/webfinger?resource=acct:<user>@<host>`
   Returns a JRD; the `self` link (`type: application/activity+json`) is the
   actor id.
2. **Fetch the actor** at that id: `GET /ap/users/:slug`.
   Read the collection URLs and the C2S endpoints from it, never construct them:

   ```json
   {
     "id": "https://klonkt.example/ap/users/robin",
     "type": "Person",
     "preferredUsername": "robin",
     "name": "Robin",
     "inbox":     ".../inbox",
     "outbox":    ".../outbox",
     "followers": ".../followers",
     "following": ".../following",
     "endpoints": {
       "oauthAuthorizationEndpoint": "https://klonkt.example/oauth/authorize",
       "oauthTokenEndpoint":         "https://klonkt.example/oauth/token",
       "uploadMedia":                ".../uploadMedia"
     }
   }
   ```

3. **Server metadata** (RFC 8414):
   `GET /.well-known/oauth-authorization-server` returns
   `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
   `code_challenge_methods_supported: ["S256"]`,
   `token_endpoint_auth_methods_supported: ["none"]`, `scopes_supported: ["c2s"]`.

If the actor lacks the OAuth endpoints, the server does not support posting from
apps; the client should degrade to read-only.

## 2. Authentication (OAuth 2.0, public client + PKCE)

Public clients only. No client secret. PKCE with S256 is required.

1. **Register** (RFC 7591, once per install):
   `POST /oauth/register` with `{ "client_name": "...", "redirect_uris": ["com.klonkt.shaer:/oauth"] }`
   returns `201 { "client_id": "..." }`. The redirect scheme must contain a dot
   (reverse-DNS custom scheme).
2. **Authorize**: open `authorization_endpoint` in a system browser with
   `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
   `code_challenge_method=S256`, `scope=c2s`, `state`. The user logs into Klonkt
   and picks which of their sites the app may post as. For a non-http
   redirect_uri Klonkt serves a small interstitial that forwards to the custom
   scheme (mobile browsers drop a bare 302 to a custom scheme); web clients get a
   302.
3. **Token**: `POST /oauth/token` (form-encoded) with
   `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`,
   `code_verifier`. Returns `{ "access_token": "...", "token_type": "Bearer" }`.

The bearer is scoped to one user and one site. Send it as
`Authorization: Bearer <token>` on every authenticated call. Tokens are stored
hashed server-side; the client keeps the bearer in the platform keystore. A
`401` means the token is dead: re-run the flow.

## 3. Reads (bearer, owner only)

| Call | Returns |
| --- | --- |
| `GET /ap/users/:slug` | the actor document (add the bearer to also read owner-only fields) |
| `GET /ap/users/:slug/outbox` | OrderedCollection of the account's own `Create(Note)` |
| `GET /ap/users/:slug/inbox` | OrderedCollection of recent inbound posts (accounts you follow) as `Create(Note)`. Owner only; `403` for anyone else. The unified home feed is outbox + inbox merged. |
| `GET /ap/users/:slug/followers` | see below |
| `GET /ap/users/:slug/following` | see below |

**Followers and following** are count-only for the public (privacy). With the
owner's bearer they return the real entries. By default these are bare id
strings; send `Prefer: return=representation` (FEP-9876) to get them enriched as
AS2 actor references with display, so a client shows names and avatars instead of
bare ids. The server echoes `Preference-Applied: return=representation` and sets
`Vary: Prefer`:

```json
{
  "type": "OrderedCollection",
  "totalItems": 2,
  "orderedItems": [
    { "id": "https://r.example/users/anna", "type": "Person",
      "name": "Anna", "preferredUsername": "anna",
      "icon": { "type": "Image", "url": "https://r.example/anna.png" } }
  ]
}
```

Display priority for a contact is `name`, then `preferredUsername`, then a handle
derived from the id. Entries may also arrive as bare id strings (other servers,
or entries with no cached display); a client handles both shapes.

## 4. Writes: `POST /ap/users/:slug/outbox` (bearer)

Post an Activity, or a bare object which the server wraps in a `Create` per the
AP spec. Supported: `Create` (Note), `Like`, `Announce`, `Follow`, and `Undo` of
`Follow` / `Like` / `Announce`. `Delete` and `Update` over C2S are not yet
implemented.

A `Note` carries `content` (HTML) and a `source` object with the plain text:

```json
{ "type": "Note",
  "content": "<p>hoi</p>",
  "source": { "content": "hoi", "mediaType": "text/plain" } }
```

### 4.1 Visibility (addressing)

Visibility comes from the note's `to` / `cc`, the Mastodon model. There is no
separate flag.

| App choice | Addressing | Result |
| --- | --- | --- |
| Public | `to: [as:Public]` | public, boostable, in timelines |
| Quiet public | `to: [<followers>]`, `cc: [as:Public]` | unlisted |
| Friends | `to: [<followers>]` | followers-only, not boostable |
| Participants only | `to: [<actor uris>]`, no Public | a private mention (direct message), see 4.2 |

`as:Public` is `https://www.w3.org/ns/activitystreams#Public`. `<followers>` is
the actor's followers collection URL. No addressing at all is treated as public
(legacy).

### 4.2 Direct notes (private mentions)

A note addressed only to actor URIs (no Public, no followers) is a direct
message, not a post. Klonkt delivers it S2S to exactly those inboxes: no
followers fan-out, empty `cc`, so it can never be boosted or appear in a
timeline. A guardian on any AP server (even plain Mastodon) receives it as a
private mention. Address the recipients as `Mention` tags so their servers
notify them. A direct note with no resolvable recipient is refused
(`400 no_recipients`).

### 4.3 Attachments

Put AS2 `attachment` items on the note (`Image` / `Document` with `url`,
`mediaType`, `name`). Upload first (section 5); Klonkt accepts only its own
`/media/...` URLs, image/audio/video, up to 4.

### 4.4 Help request (FEP-633c)

A ward's call for help is a direct note carrying `"shaer:helpRequest": true`,
addressed to all its guardians, optionally with a capture as an `attachment`, the
subject as an FEP-e232 object link (never a `Mention`, which would add the
subject to the conversation), and a short text quote. Guardian-side clients may
render it as an alert; other servers read a normal private mention. See FEP-633c
5.2.1.

### 4.5 Hardening

- A `Like` or `Announce` of a non-public local post returns `403 not_public`.
- An inbound boost or like of a non-public post is dropped, not stored.

## 5. Media upload: `POST /ap/users/:slug/uploadMedia` (bearer)

`multipart/form-data`, field name `file`, one image/audio/video, up to 32 MB.
Returns `201 { "url": "/media/reply-media/...", "mediaType": "image/png", "name": "..." }`.
Use `url` in an `attachment` on the next note.

## 6. The `shaer:` vocabulary (FEP-633c)

Namespace `https://ns.klonkt.com/shaer#`, declared in the emitted `@context`.

| Term | On | Meaning |
| --- | --- | --- |
| `shaer:guardians` | Actor | array of guardian actor URIs; non-empty marks a ward |
| `shaer:isGuardian` | Actor | `true` marks a guardian |
| `shaer:hasGuardians` | Object | per-object routing hint that the author is a ward |
| `shaer:helpRequest` | Note | marks a direct note as a ward's call for help (4.4) |

The full model (the handshake, gating, emancipation, escalation) is FEP-633c in
`work/klonkt/fep-633c.md`.

## 7. Error reference

| Status | When |
| --- | --- |
| `400 invalid_activity` / `missing_object` / `empty_note` | malformed write |
| `400 no_recipients` | direct note with no resolvable recipient |
| `400 unsupported_type` | a verb C2S does not implement (Delete/Update) |
| `403` (reads) | not the owner (inbox, owner followers/following) |
| `403 not_public` | Like/Announce of a non-public local post |
| `401` | dead or missing bearer: re-authenticate |
| `502 cannot_resolve_inReplyTo` / `direct_failed` | a delivery target could not be resolved |

## 8. Notes and limits

- The enriched followers/following display is a Klonkt convenience. A generic AP
  server returns bare ids; the client falls back to a derived handle.
- This is ActivityPub C2S. There is no Mastodon-compatible client API.
- See `FEDERATION.md` for the server-to-server surface (activities, signatures,
  extension terms, supported FEPs).
