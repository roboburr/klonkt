# Klonkt Content Archive, format version 1

A portable archive of **your own content**: posts, their media, and — as a
read-only historical record — the replies other people wrote underneath them.
It can be exported from one Klonkt and imported into another, and it stays
readable when Klonkt is gone.

This is the format specification. It is written before the exporter and the
importer exist, on purpose: without a written format each of them writes down
its own assumptions, and then there are two sources of truth instead of one.

## What this is not

| | |
|---|---|
| **Storage backup** (`shaer-190t`) | A byte-level zip of the storage directory, including password hashes, sessions and the per-actor private RSA keys. A backup for Klonkt-to-Klonkt restore. Never hand it to anyone. |
| **GDPR data export** (`shaer-0j2`) | Personal data for inspection. Different scope, different audience. |
| **This format** | Your content, portable, importable, reproducible, and free of every credential. |

They may share serialisation code. They do not share a purpose, and they must
not quietly become the same file.

## Container layout

```
manifest.json              format version, origin, counts, checksums
posts/<post-id>.json       ONE post — canonical, the only thing import reads
replies/<post-id>.json     replies received under that post — read-only archive
media/<sha256>.<ext>       the bytes, content-addressed
readable/<slug>.md         rendered for humans — derived, NEVER read on import
```

Delivered as a zip. `<post-id>` is Klonkt's own post id, which is also the tail
of the ActivityPub object id (`<origin>/ap/notes/<post-id>`). Using it as the
filename means the identity is visible in the tree and no character escaping is
needed. The slug lives inside the file, where it can change without renaming
anything.

## manifest.json

```json
{
  "formatVersion": 1,
  "generator": "klonkt/1.6.0",
  "exportedAt": "2026-08-06T13:00:00Z",
  "origin": "https://boiert.eu",
  "actor": "https://boiert.eu/ap/users/boiert",
  "site": { "slug": "boiert", "title": "Boiert" },
  "counts": { "posts": 412, "replies": 1180, "media": 233, "mediaMissing": 7 },
  "files": { "posts/abc123.json": "<sha256>", "media/<sha256>.jpg": "<sha256>" }
}
```

`origin` is the field the importer cannot work without. It decides whether the
ActivityPub ids may be kept (see [Import rules](#import-rules)). Everything else
in the manifest is verification and reporting.

`exportedAt` lives **only** here. It must not appear in any post file, or two
exports of unchanged content would differ.

## posts/&lt;post-id&gt;.json

An ActivityStreams 2.0 object carrying the post **as authored**, with Klonkt's
own fields in the `shaer:` namespace.

### It is not what we federate, and that is deliberate

`buildNote()` produces a *projection* for the fediverse, and that projection is
lossy by design:

- the title is baked into the content as a bold first line, because Mastodon
  ignores a Note's `name`;
- a paid post federates a **teaser only**, never the body;
- `<img>` is stripped from the content and moved into `attachment`, because
  Mastodon drops inline images;
- when a post carries an external embed the image attachments are suppressed, so
  the link card wins.

Exporting that projection would mean archiving a paid post as its teaser. So the
archive carries the authoring truth instead, and the differences are:

| | federated (`buildNote`) | archive |
|---|---|---|
| type | always `Note` | `Article` when the post has a title, else `Note` |
| title | inside `content` | `name` |
| paid post body | teaser | full content |
| inline images | stripped from `content` | left in `content`, and also listed in `attachment` |

### Fields

| AS2 / `shaer:` | source | notes |
|---|---|---|
| `id` | `<origin>/ap/notes/<posts.id>` | the federation identity; see import rules |
| `type` | `posts.title` present? | `Article` / `Note` |
| `attributedTo` | site actor | |
| `name` | `posts.title` | plain text, not HTML |
| `content` | `posts.content` | authored HTML, shorthand intact |
| `contentMap` | `posts.language` | omitted when the post has no language |
| `summary` | `posts.content_warning` | AS2 summary is the content warning |
| `sensitive` | `posts.nsfw` | |
| `published` | `posts.published_at` ?? `created_at` | ISO 8601, UTC. Klonkt stores timestamps in two spellings (`YYYY-MM-DD HH:MM:SS` and full ISO); the archive normalises to ISO. The **instant** survives a round trip, the spelling does not. |
| `updated` | `posts.updated_at` | omitted when equal to `published` |
| `url` | `<origin>/<slug>` | the human permalink |
| `attachment` | cover, inline `<img>`, `c2s_attachments` **and their `poster`**, hosted audio tracks | see [Media](#media); each carries a `shaer:role` |
| `tag` | `posts.tags`, mentions, custom emoji | `Hashtag`, `Mention`, `toot:Emoji` |
| `oneOf` / `anyOf` / `endTime` | `posts.poll_json` | a poll exports as a `Question` |
| `quoteUrl`, `shaer:quoteActor` | `posts.quote_uri`, `quote_actor` | FEP-044f |
| `shaer:slug` | `posts.slug` | |
| `shaer:status` | `posts.status` | `draft` posts are yours too and are exported |
| `shaer:excerpt` | `posts.excerpt` | |
| `shaer:type` | `posts.type` | |
| `shaer:pinned`, `shaer:noindex`, `shaer:fanOnly` | idem | |
| `shaer:paid`, `shaer:paidMinCents` | idem | **see the warning below** |
| `shaer:apVisibility` | `posts.ap_visibility` | |
| `shaer:publishAt` | `posts.publish_at` | a scheduled post keeps its schedule |
| `shaer:coverAlt` | `posts.cover_alt` | |
| `shaer:viewCount` | `posts.view_count` | optional; a restore without it loses history |
| `shaer:audio` | `audio_tracks` rows referenced from the content | title, artist, duration, credit, license, external links, `shaer:ref` (the `[[track:id]]` it belongs to) and `shaer:media` (which attachment holds its file) |

**Deliberately not exported:** `yjs_binary` (collaborative editor state — large,
regenerable, and meaningless elsewhere), `content_rendered` (derived from
`content`; exporting it would create a second truth that can drift),
`origin_server`, and every id that belongs to a foreign server.

> **Warning — a paid post exports in the clear.** The archive contains the full
> body of paywalled posts, because an archive that silently drops your own
> content is worse than useless. An export of a site with paid posts must be
> handled like the content itself.

### Klonkt shorthand inside `content`

`content` may contain Klonkt shorthand that other software will not understand:

```
[[track:<id>]]      a hosted audio track       → see shaer:audio
[[album:<id>]]      an album of tracks
[[playlist:<id>]]   a playlist
[[embed:<url>]]     an external player (Spotify, YouTube, SoundCloud, …)
```

They are left in place, because resolving them at export would destroy the
authored source. A foreign consumer should either strip them or resolve them
using `shaer:audio`. `readable/<slug>.md` has them rendered.

## Media

Media are content-addressed by the SHA-256 of the bytes, so two exports of the
same content produce the same filenames and duplicates collapse on their own.

An attachment has three possible states, and the format must be able to say
which one applies. Two are not enough: at Boiert we will know that a picture
existed and where it lived, without having the bytes. An empty attachment list
would be a lie, and a reference to a missing file would be a broken archive.

```json
{
  "type": "Image",
  "mediaType": "image/jpeg",
  "name": "alt text",
  "url": "media/9f86d0….jpg",
  "shaer:availability": "included",
  "shaer:originalUrl": "https://boiert.eu/media/2026/cover.jpg",
  "shaer:sha256": "9f86d0…"
}
```

| `shaer:availability` | meaning | `url` |
|---|---|---|
| `included` | the bytes are in `media/` | container-relative path |
| `missing` | it existed, we know where, we do not have it | the original absolute URL |

Every attachment also carries **`shaer:role`**, saying what it was for:

| role | restored to |
|---|---|
| `cover` / `coverVideo` | `posts.cover_image_url` / `cover_video_url` |
| `inline` | already referenced from `content` |
| `c2s` | an entry in `posts.c2s_attachments` |
| `poster` | the `poster` of the `c2s` entry named in `shaer:posterFor` |
| `track` | the file behind a `[[track:id]]`, linked from `shaer:audio` |

The role is not decoration. Without it the archive holds the bytes but not the
fact that they *were the cover*, and the post comes back without one — which is
invisible until you compare every column, not a handful.

`url` for an included attachment is a **container-relative path**, not a URL. An
importer must rewrite it. This is the one place where the archive deviates from
strict AS2, and it is the price of carrying bytes at all.

An importer must **count and report** every `missing` attachment. It must never
silently drop one: a post whose picture has vanished should say so.

## replies/&lt;post-id&gt;.json

An AS2 `OrderedCollection` of the replies received under that post, as received.

```json
{
  "type": "OrderedCollection",
  "shaer:archive": true,
  "shaer:inReplyTo": "https://boiert.eu/ap/notes/abc123",
  "orderedItems": [ { "id": "https://mstdn.social/users/x/statuses/1", "…": "…" } ]
}
```

This is **other people's content**. Three rules follow, and none is optional:

1. It is never re-delivered, produces no notifications and no push. It is
   history, not traffic.
2. Their ids belong to their servers. We carry them as they are and never claim
   them.
3. Because of this section an export is not purely "your data". That is exactly
   why this format and the GDPR export (`shaer-0j2`) have different scopes and
   must not silently become the same file.

`shaer:archive: true` is what an importer keys on. An importer that does not
understand this section must skip it, never read it as own content.

## readable/&lt;slug&gt;.md

Markdown with YAML front matter, rendered from the canonical file: title, date,
content with the shorthand resolved, images as links into `media/`.

It exists so the archive survives Klonkt itself. It is **derived** and travels
in one direction only — the importer never reads it. This is not tidiness: an
archive whose Markdown and JSON are both read is an archive with two sources of
truth, and they will drift.

## Versioning

`formatVersion` is an integer in `manifest.json`.

- Adding a property does **not** bump it. Readers must ignore properties they do
  not know.
- Changing or removing the meaning of a property bumps it.
- An importer that meets a `formatVersion` **higher than it knows must refuse the
  whole archive** and say so. It must never read it partially: a half-understood
  restore is worse than no restore, because it looks like it worked.

## Import rules

**Identity.** Compare `manifest.origin` with the importing site's own origin.

- Equal → **keep the ActivityPub ids**. This is what makes a restore a restore:
  the boosts, likes and replies that already point at those ids find their post
  again.
- Different → **mint new ids**, and keep the original `url` as a historical
  reference. Keeping foreign ids would mean publishing objects under an id you
  do not control; remote servers resolve such an id at its original host, and it
  is a forgery surface besides.

The importer determines this itself. It is not a question for the user, because
a wrong answer cannot be taken back.

**Consequences of keeping ids.** The post id is part of the identity, so the
importer must be able to *set* the primary key rather than let it be generated.
That is a different write path from creating a post, and it must not be reachable
outside the import.

**No `Update` broadcast.** If the restored content differs from what other
servers cached long ago, their copy stays stale. Sending `Update` activities
would fix that, but it is a broadcast to the whole fediverse and must never be a
side effect of an import. Separate, deliberate action.

**Dry run.** The importer offers a mode that reports what would happen —
including the missing-media count — before anything is written.

**Idempotent.** Importing the same archive twice produces no duplicates. On a
collision with an existing id the importer follows one documented rule (skip,
overwrite, or refuse and report); it never guesses per post.

## Reproducibility

Two exports of unchanged content must be **byte-identical except for
`manifest.exportedAt`**, which is by definition the moment of export. Everything
else — every post file, every media file, and the `files` checksum map — must
match. That is what makes an archive verifiable and a diff meaningful: if the
checksum map is equal, nothing changed.

- JSON: keys sorted, two-space indent, LF, trailing newline.
- Posts ordered by `published`, then by `id` for ties.
- No timestamps inside post files; `exportedAt` lives only in the manifest.
- Zip entries in sorted path order, with a fixed modification time.
- Media names derive from the bytes, so they never depend on export order.

## Worked example: the hardest post

The format is tested against the most demanding post Klonkt can produce, not the
easiest: a **poll** with **attachments**, a **quote card**, **custom emoji**, a
**content warning**, and **paid** access.

- poll → `type: "Question"` with `oneOf`/`anyOf` and `endTime`; the votes are
  federation state, not content, and are not exported;
- attachments → `attachment[]`, each with its own availability;
- quote → `quoteUrl` + `shaer:quoteActor` (FEP-044f);
- custom emoji → `tag[]` entries of `toot:Emoji`, whose icons are media like any
  other and are content-addressed the same way;
- content warning → `summary` + `sensitive: true`;
- paid → full `content` plus `shaer:paid`, with the warning above.

A post that survives this round trip unchanged is the acceptance test for
slices 2 and 3.
