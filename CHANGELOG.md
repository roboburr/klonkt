# Changelog — Klonkt

All notable changes to Klonkt. Newest at the top.
Versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
