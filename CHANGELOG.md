# Changelog — Klonkt

All notable changes to Klonkt. Newest at the top.
Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **The owner can read their inbox over C2S.** A GET on the inbox with the
  account's own bearer returns recent inbound posts (the accounts you follow)
  as Create(Note) items, so a connected app (Shaer) can build a unified feed.
  For everyone else the inbox stays write-only.
- **"Load more" on the feeds.** Solo (home), Cirkel, News and Messages now page
  in blocks of 72 with a "Load more" button instead of a hard cap, so older
  items are reachable. 72 divides by 2, 3 and 4, so the grid views always end on
  a full row. Appending is instant (htmx), the Messages search and filters keep
  working across pages, and the button disappears on the last page.
- **"Interact via the fediverse" next to Share.** On a post, visitors get a
  button beside Share to reply, like or boost from their own fediverse server
  (it asks for your server, then hands off to your instance). Hidden for the
  site owner and when federation is off.
- **FEDERATION.md (FEP-67ff).** The repository root now documents what Klonkt
  speaks on the wire: ActivityPub S2S and C2S, WebFinger, HTTP Signatures,
  NodeInfo 2.1, OAuth (PKCE), the activities and object types it sends and
  receives, the Mastodon-compatible extension terms, and the FEPs it supports or
  tracks. Helps other implementations interoperate.
- **Messages: your poll finished.** When one of your own polls closes, Messages
  shows a "poll finished" item with the final result: a bar per option with its
  percentage, and the number of voters. It lives under the Activity chip and is
  searchable like the rest.
- **Messages: sharper filters and a search box.** The filter chips are now
  Messages (@mentions and private/DM replies), Conversations (public replies),
  Activity (likes, boosts, follows), Moderation (reports) and Sent, next to All.
  A search box filters the list by sender and message text, and combines with
  the active chip. All client-side, instant.
- **The reply editor got a visual clean-up.** Its toolbar now uses the same
  icon set and 32px buttons as the post editor, with active formatting shown
  filled in the accent colour, a framed editor box with a focus ring, and
  tidier language, mention and attachment chips. One editor family across the
  site.
- **The reply editor shows who you are addressing (rich replies, phase 3).** A
  "To:" bar above the editor lists the conversation partners (the author you
  reply to plus the thread's earlier authors) as removable chips, instead of
  cluttering your text with @mentions. Remove a chip and that person is no
  longer mentioned, tagged or pinged; mentions you type yourself stay in the
  text. Editing a sent reply keeps every co-mention intact.
- **Editing a sent reply uses the rich editor too.** The edit forms on Messages
  and the interact page open the same editor as new replies (formatting kept,
  language adjustable, full-screen on phones). Attachments on the reply survive
  an edit untouched.
- **Media in replies (rich replies, phase 2).** Drop, paste or pick images,
  audio and video straight into the reply editor (the paperclip works on
  phones). Files upload to your own site, show as removable chips while you
  write, travel as real attachments on the federated note, and render in your
  thread. A media-only reply (no text) works too.
- **Rich replies (phase 1).** Replying to fediverse comments (inline in the
  thread and on the interact page) now uses a shared rich editor: bold, italic,
  links, lists and quotes, plus a language picker for your reply (sent along as
  the note's language map). On phones the editor opens as a full-screen compose
  view, the pattern that actually works on mobile. Without JavaScript the plain
  text box keeps working. Media in replies is the next phase.
- **Revoke connected apps from your account page.** A "Connected apps" section
  lists every app you authorized over OAuth (name, site, scope, last used) with
  a Revoke button. Tokens you already granted show up too, since they were
  always stored (hashed); the bearer itself is never kept, so revocation is keyed
  on the token hash.
- **The account owner can read their own followers and following over C2S.** The
  `followers` and `following` collections stay count-only for the public
  (privacy), but a request carrying a C2S bearer scoped to that site now returns
  the real actor URIs, so an app (Shaer) can build a friends list. Anonymous
  callers are unchanged.
- **App access via OAuth 2.0 (ActivityPub Client-to-Server, phase 1).** Klonkt
  now speaks the standard AP C2S auth handshake so native and web clients (the
  Shaer apps first) can connect: dynamic client registration (RFC 7591), a
  PKCE authorization-code flow with a consent screen that picks which of your
  sites the app may post as, and bearer tokens (stored hashed, single-use
  codes). The actor document advertises the OAuth and uploadMedia endpoints and
  `/.well-known/oauth-authorization-server` (RFC 8414) exposes the metadata, so
  clients discover everything instead of hardcoding paths. Public clients + PKCE
  only, no client secrets.
- **The outbox accepts posts from apps (C2S, phase 1 complete).** A
  bearer-authenticated `POST` to `/ap/users/:slug/outbox` now drives your account
  from a client: publish a note, reply, like, boost, follow, and undo any of
  those. Activities are translated onto the same delivery machinery the web UI
  uses; a bare Note is wrapped in a Create per the spec; content is sanitized;
  the token is scoped to one site so it can't post as another. Note: this is
  ActivityPub C2S, which the Shaer apps speak. Mastodon clients (Ivory etc.) use
  Mastodon's own API and are not supported by this.

### Fixed
- **OAuth consent now hands off reliably to native apps.** After Allow/Deny, a
  redirect to a native custom scheme (e.g. `com.klonkt.shaer:/oauth`) was a plain
  302, which mobile browsers silently drop. The consent step now serves a tiny
  interstitial for non-http redirect URIs that auto-forwards and offers an "Open
  the app" tap link (a tap reliably launches the app on Android; iOS's web-auth
  session intercepts either way). Web (http/https) clients still get a 302.
- **Visitors can reply to the site owner's own comments.** The "reply via the
  fediverse" button only appeared on comments from others; the site's own
  comments in a thread offered visitors nothing, so you could not respond to
  the author from your own instance.

## [1.5.0] · 2026-07-18

### Added
- **Messages: your replies and notifications on one page.** A single Messages
  tab replaces Replies and Notifications. One stream with filter chips (All,
  Conversations, Activity, Sent): your own sent replies join the conversation
  (with edit and delete), likes and boosts on the same post group into one line,
  private replies carry a lock badge, and items new since your last visit get a
  dot. The interact bookmarklet moved along. Old /fediverse and /notifications
  links redirect to /messages.
- **Connect: your following and followers on one page.** A single Connect tab
  replaces the separate Following and Followers pages, showing each connection's
  direction (following →, follower ←, mutual ↔) and, for accounts you deliver to,
  when they were last reached. Accounts you can no longer reach move to a
  collapsed "Unreachable" section for cleanup. Old /following and /followers
  links redirect to /connect.
- **Moderate incoming replies on your own posts.** As the site owner you can now
  remove a reply from your thread (it stays removed: re-delivery and
  thread-filling are blocked by a tombstone) and report it to its author's
  server, straight from the thread. This also works for private replies, which
  cannot be handled via the fediverse interact flow.

### Fixed
- **A boosted video post keeps its video in the Circle.** Boosting a video-only
  post (Loops.video) stored it without its media, so the Circle showed a bare
  text tile instead of a video thumbnail; re-boosting could even wipe the video
  from an already-cached copy. Boosts now carry the full typed media, and a
  refresh never erases cached media.
- **The interact page title follows your language.** "Interacteer via de
  fediverse" was hardcoded Dutch in the browser tab, even on an English site.
- **The Apple Music icon looks like the Apple logo again.** The old icon was a
  garbled shape.
- **Statistics columns no longer jump around in the 30 and 90 day views.**
  Columns without a date label collapsed slightly; every column now keeps its
  label line.
- **Private replies no longer show on the public post page.** A followers-only
  or direct (DM) reply to your post was rendered in the public thread for
  everyone. Incoming replies now record their fediverse addressing; the public
  thread only shows public and unlisted replies. Private ones still reach you in
  notifications, with the post they belong to.
- **Bare video/audio embeds no longer overflow their column.** A `.webm` /
  `.mp4` / `.mp3` player now fits the content width like the iframe embeds do;
  the width rule previously covered only `iframe`.

## [1.4.0] · 2026-07-14

### Added
- **Followers list with delivery health.** A new Fediverse tab shows who follows
  you and when each account was last reached, so dead accounts stand out and you
  can remove them after a check.
- **Bare media links play inline.** A plain `.webm`, `.mp4` or `.mp3` link now
  renders a native player instead of a dead link.
- **Hashtags, links and mentions are clickable on your site too.** `#tags`, URLs
  and `@mentions` in a post become links on the site itself, not only on the
  federated copy. Mentions are resolved once when you save, so pages stay fast.

### Fixed
- **Replies, comment deletes and reply edits always arrive.** They used to be
  dropped when a server was briefly unreachable; they now go through the retry
  queue like posts do.
- **Video thumbnails for more videos.** Covers from videos with their metadata at
  the end of the file (Loops.video, phone exports) now get a thumbnail instead of
  none.
- **A video-only cover shows a poster on the post page.** It no longer renders
  blank in the Solo view.
- **The installed app no longer shows old data on a shaky start.** A cold launch
  on a poor connection refreshes instead of showing a stale page.
- **The Updates page follows your branch.** On the stable branch you no longer
  see main's changes flagged as "latest".

## [1.3.5] — 2026-07-04

### Fixed
- **Polls keep their cover art when boosted.** A poll with music or an embed was
  federating without its cover, so a boosted poll showed a blank tile; the cover
  now travels with it.
- **The Android app's Updates page shows what's actually installable.** It read
  the newest release branch, which could be ahead of the phone build for a short
  while — pressing update then reinstalled the same version. It now reads the
  version of the phone bundle itself.

## [1.3.4] — 2026-07-04

### Fixed
- **Boosts that lost their cover get it back automatically.** Posts you boosted
  before the cover fix were cached without their artwork; they are refreshed
  once on the next restart. If a post's home server is briefly unreachable at
  that moment, it is retried on the next restarts instead of being skipped for
  good. Boosting a post again now also refreshes its cached copy (cover,
  content) — from the feed as well as the interact page.

## [1.3.3] — 2026-07-03

### Fixed
- **Boosted music posts keep their cover.** When you boosted a track from
  someone you don't follow, the cover art went missing; it now shows, just like
  for people you do follow.

## [1.3.2] — 2026-07-02

### Fixed
- **The Updates page now works in the Android app.** It now shows the newest
  available version, and the update button downloads and installs it right on
  your phone (your posts and settings are kept).

## [1.3.1] — 2026-07-02

### Fixed
- **Music keeps playing in the background on Android.** When a track ended while
  your phone was locked or the app was in the background, the next track would
  start and stop again after a second. The player now feeds the whole queue as
  one continuous stream, so auto-advancing to the next track no longer counts
  as "new" playback that the browser is allowed to pause.

## [1.3.0] — 2026-07-02

### Added
- **Choose a light or dark share card.** The auto-generated share image follows your site theme;
  under Admin → SEO you can now force it light or dark.
- **A mention is now a notification.** When someone on the fediverse mentions you in a post —
  even one that isn't a reply to you — it shows up in your fediverse notifications with a link
  to the original.
- **Cover art on openly shared audio.** A track shared openly on the fediverse now carries its
  cover art (or the post cover), so audio players that support artwork show it instead of a blank tile.
- **Report a post to the fediverse.** From a fediverse post you can now report it to the moderators
  of its own home server, with an optional reason — and if someone reports your site, the report
  shows up in your fediverse notifications.
- **Set a post's language.** Choose the language you wrote a post in — on the fediverse it enables
  timeline language filtering and the translate button.
- **Alt text for images.** Give your cover image a description (and inline images keep their own
  alt text) — it federates to the fediverse and lets screen readers describe the picture.
- **Mention people in a post.** Typing `@user@server` in a post now links to their profile and
  notifies them on the fediverse — even if they don't follow you — just like a mention in a reply.
- **Short videos in the feed autoplay and loop.** An animated cover or a short (≤30s) clip in the
  News feed now plays automatically and loops muted, like a GIF; longer videos keep their controls.
- **Vote on fediverse polls.** A poll from an account you follow now shows in the News feed with its
  options and current results, and you can cast your vote — it federates back like any Mastodon vote.
- **Create your own polls.** A post can now carry a poll (single or multiple choice, with a set
  duration). It federates as a real fediverse poll, so your Mastodon followers can vote from their own
  app; the live results show on the post and the poll closes itself when the time is up.

### Changed
- **Sharing audio openly is now one-way.** Once a track is shared openly on the fediverse the file
  has spread, so "closing" it again would be false security — the editor now locks the choice after
  opening and warns you before you tick it.

### Fixed
- **Remote videos show a preview frame.** A video in the News feed or a Circle tile (e.g. from
  Loops or PeerTube) used to appear as a black box until you pressed play; it now shows a real
  poster frame. (Longer videos keep their player controls by design — only clips under 30 seconds
  autoplay like a GIF.)
- **Mentions, hashtags and links inside brackets now work.** A mention like `(@user@server)`, a
  `(#hashtag)` or a bracketed URL federated as plain text — and the mentioned person was never
  notified. They now link (and notify) like their unbracketed forms.
- **Plain web addresses become links on the fediverse.** A bare URL typed in a post or reply now
  federates as a clickable link instead of plain text.

## [1.2.0] — 2026-07-01

### Added
- **PeerTube videos in the feed.** A PeerTube link in a post now shows an inline player in the News
  feed, like YouTube, Spotify and SoundCloud already did.
- **Light share images.** Sites whose default theme is Light now get a matching light Open Graph card
  when a page is shared, instead of always a dark one.
- **Leave your own visits out of the stats.** As the admin you can now exclude your own IP address
  from your site statistics, for a truer picture of real visitors.
- **Right-click "Save" is turned off on covers, images and videos** — a light bit of friction so the
  artwork isn't one click from being saved (it's friction, not protection).

### Fixed
- **Animated video covers now render correctly everywhere.** In the Circle and the grid they could
  show up as a broken image or a blank tile; they now display as a proper looping video that fills the
  square, centred. Right-clicking a cover gives the normal link menu instead of the browser's video controls.
- **Following someone no longer gets stuck.** A follow whose first delivery fails (the other server
  briefly unreachable) is now retried automatically with backoff, instead of staying on "pending" forever.
- **Boosted posts show their real text** in the Circle, instead of a "RE: <link>" prefix.
- **Hardened fediverse handling** — stricter signature checks on incoming activity, blocks now also
  cover a boost of a blocked author, and pinned-post syncing no longer races when you save several times quickly.

## [1.1.0] — 2026-06-30

### Added
- **Animated covers play smoothly everywhere.** Upload an animated WebP as a cover and Klonkt also
  makes a muted, looping video of it. iOS Safari — where animated WebP is janky — gets the smooth
  video, every other browser keeps the crisp WebP, and on the fediverse the cover federates as a
  video that plays in Mastodon and its apps. Shown on the post, the grid, the feed and related posts.
- **Media library (Admin → Media).** See every uploaded image, where each one is used, copy its URL,
  and clean up unused files in one click — including the leftover video/poster of an animated cover.
  Images, Audio and Playlists now share one tab bar.
- **Share button** at the bottom of every post (native share sheet, or copy link).
- **Replace a track's audio file** without re-creating the track.
- **Music on the fediverse (first step).** Audio posts now carry schema.org *MusicRecording* /
  *MusicAlbum* data, and a per-post toggle can share a hosted track as a real fediverse audio
  attachment that plays in followers' feeds.

### Changed
- **Cleaner embeds on Mastodon.** A post with a YouTube/Spotify/SoundCloud link now lets Mastodon
  show its player card; link-only tracks share their streaming links. The cover still shows in other
  Klonkt feeds. (On your own site nothing changes — the player and cover render as before.)
- **Circles stay in sync the fediverse way** — edits and missed posts catch up automatically via
  standard ActivityPub, so a Circle no longer drifts out of date.
- **Everything Klonkt federates is now valid AS2 / JSON-LD**, guarded by a test, so stricter servers
  accept it.
- The track list is sorted **newest-first**.

### Fixed
- **Animated WebP covers are no longer frozen to a single frame** (the crop editor and the thumbnailer
  left them static).
- **Link-only tracks** (Spotify/YouTube, no uploaded file) can be inserted into a post again.
- **Link previews** (og:image / Twitter card) now use absolute image URLs, so they show on Signal,
  WhatsApp and other scrapers.
- Several **fediverse delivery fixes**: covers/links no longer turn into a black tile on Mastodon,
  raw audio files don't clutter a post that already has a player, and dead links from a renamed
  remote post heal themselves.
- The **mobile feed** loads full-resolution covers; long titles wrap instead of overflowing.
- **Self-hosting updates** are more reliable: re-running the installer keeps your channel, and the
  updater no longer restarts or claims an update when you're already up to date.

## [1.0.0] — 2026-06-30

### Added
- **Klonkt is now on the fediverse (ActivityPub).** Your site is a real fediverse
  account: people on Mastodon — or another Klonkt — can follow you, and your posts
  reach their feeds. You can follow accounts and read their posts in a **News** feed,
  get **notifications**, and **like, boost and reply** to posts. Incoming activity is
  verified, so fake replies, likes and followers are rejected.
- **Anyone can reply, like or boost your posts from the fediverse** — visitors interact
  from their own account (they just enter their server); no account on your site needed.
- **Circles**: follow other Klonkt sites and show each other's public posts in your
  Circle — decentralised, with no central platform.
- **Sensitive (NSFW) posts** with your own content-warning text: blurred with
  click-to-reveal across the site, and shown as a content warning on the fediverse.
- **Block** an account or an entire domain you'd rather not hear from.
- Search now also finds **tracks** (by title, artist and album), playable straight from
  the results with a link to the post they appear in — and post search matches as you type.
- **Live theme preview** in Admin → site settings: accent, theme and palette update
  instantly, before you save.
- Uploaded images are automatically optimised to **WebP** for faster pages.
- A roomier **mobile writing experience**: tap to open a distraction-free fullscreen
  editor, with the formatting toolbar staying in view above the keyboard.
- **Long posts collapse in the News feed** with a *read more* toggle, so a long post no
  longer fills the whole screen — tap to expand or collapse it.
- **See everyone in a Circle**: when a Circle has more than five sites, the member count
  opens a popup that lists them all, so a big Circle no longer hides its members.

### Changed
- **Palettes revised to 8**: the neutral **Klonkt** (gold accent) is the new default,
  plus seven full-colour themes — Forest, Ocean, Teal, Lilac, Sunset, Candy and Amber.
- **Your profile federates more completely**: the links on your profile, the date you
  joined and the accounts you follow now travel along to other servers, so your profile
  looks complete when someone views it from Mastodon or elsewhere.
- **Cover images and avatars are sharper** — resized on the server instead of being
  squeezed by the browser.

### Removed
- **Hub mode** — Klonkt is now **solo or Circles**; you build a collective or label
  through **Circles** (federated, standalone sites).
- **Native comments and Google login** — replies, likes and boosts now run entirely
  through the fediverse.
- **Local favourites (♥)** — replaced by the ⭐ fediverse like.

### Fixed
- **Hashtags and mentions now work in every language and script** (e.g. Japanese, Cyrillic,
  Arabic), both on your site and when federating — not just the Latin alphabet.
- **Switching a site to solo (federation off) works again.** Turning the fediverse off could
  make the whole site return “page not found” instead of just disabling federation; it now
  cleanly switches federation off while the rest of the site keeps working. (Self-hosters:
  update to pick up the fix.)
- The Fediverse and Notifications items now disappear from the menu when federation is off,
  instead of lingering.
- The mini-player jumps and scrolls to the track that's playing — also from an album or
  playlist — and keeps it highlighted.
- Empty album/playlist covers now fall back to the first track's cover.
- A profile photo that broke in the header after the WebP switch now repairs itself.
- Many **mobile post-editor** fixes: reliable scrolling, a formatting toolbar that stays
  put, no page jumps when you tap a button, and a Save bar that sits just above the keyboard.
- **Boosts now reach the original poster** — their server registers the boost and notifies
  them, just like a boost from Mastodon — and a boost is retried if a server is briefly
  unreachable instead of being sent once and forgotten.
- **Unfollowing an account now takes effect on the other server** (it could previously fail
  to register, leaving you still following on their side).

## [1.0.0-beta.2] — 2026-06-19

First release where we actively track the version (shown in the footer — click it for
this page).

### Added
- Release tracking: the version number in the footer links to this changelog page.
- Eight premium features (Patreon-gated): newsletter/mailing list, download-for-email,
  release scheduling + fan-only previews, EPK/press kit, pro statistics, link-in-bio +
  click stats, embeddable player, and show agenda + notify-me.
- Newsletter signup field in the footer (on/off in Admin → Settings).
- SMTP settings configurable in Admin → Settings (no more config-file edit needed), with
  a test-mail button.

### Changed
- Tidier settings forms (stacked labels, full-width inputs).
- EPK/press kit shows the top 10 most-listened tracks.
- Nicer 404 page (mobile-friendly) and clearer login error messages.

### Fixed
- The site-wide audio player wasn't loading any tracks.
- Button text became unreadable on hover.
- Date pickers now follow the theme.
- Back/forward navigation no longer shows a doubled header.
