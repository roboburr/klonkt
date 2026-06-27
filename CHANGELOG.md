# Changelog — Klonkt

All notable changes to Klonkt. Newest at the top.
Versions follow [SemVer](https://semver.org/) (`1.0.0-beta.N` during the beta).

## [Unreleased]

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

### Changed
- **Palettes revised to 8**: the neutral **Klonkt** (gold accent) is the new default,
  plus seven full-colour themes — Forest, Ocean, Teal, Lilac, Sunset, Candy and Amber.

### Removed
- **Hub mode** — Klonkt is now **solo or Circles**; you build a collective or label
  through **Circles** (federated, standalone sites).
- **Native comments and Google login** — replies, likes and boosts now run entirely
  through the fediverse.
- **Local favourites (♥)** — replaced by the ⭐ fediverse like.

### Fixed
- The mini-player jumps and scrolls to the track that's playing — also from an album or
  playlist — and keeps it highlighted.
- Empty album/playlist covers now fall back to the first track's cover.
- A profile photo that broke in the header after the WebP switch now repairs itself.
- Many **mobile post-editor** fixes: reliable scrolling, a formatting toolbar that stays
  put, no page jumps when you tap a button, and a Save bar that sits just above the keyboard.

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
