# Changelog — Klonkt

All notable changes to Klonkt. Newest at the top.
Versions follow [SemVer](https://semver.org/) (`1.0.0-beta.N` during the beta).

> **Two separate version numbers — don't confuse them:**
> - **App version** (this changelog + footer, `package.json`) = cosmetic; bump every release.
> - **Federation proto** (`KLONKT_PROTO` in `CircleFederation.js`, now **2**) = determines whether
>   Klonkt sites can federate into each other's **circle** (it's part of the signed basis).
>   An app-version bump does **not** change the proto and therefore doesn't break circles. Bump the
>   proto **only** for federation/security changes, and then roll it out in **lockstep**
>   to all instances (including the democircles) so they keep working together.

## [Unreleased]

### Added
- Search now also covers **tracks** (by title, artist and album), not just posts.
  Found tracks are directly playable in the results list, with an
  "in post →" link to the post/album/playlist the track appears in.
- Posts search now uses **prefix matching**: type "astr" and you'll find "astra"
  (each word as a prefix, AND between the words) — nicer search-as-you-type.
- **Fediverse client**: follow accounts (WebFinger → signed Follow), a
  **home timeline** (`/tijdlijn`) of who you follow, a **notifications inbox**
  (`/meldingen`), and ⭐-like / 🔁-boost / ↩-reply from the timeline.
- **Like and reply via the fediverse** on a post: visitors only fill in
  their own server (`@you@server` or `server.com`) and handle it on their
  own account (`/authorize_interaction`).
- **HTTP signatures enforced** on the inbox: unsigned or forged
  activities are rejected — no more fake replies/likes/followers.
- **Block/defederate** an account or an entire domain (`/blokkeren`).
- **Live theme preview** in Admin → site settings: accent, theme and palette
  visible immediately before you save.

### Changed
- **Palettes revised** to 8: the neutral **Klonkt** (white/black, gold accent)
  is now the default, plus 7 real-color themes (Forest, Ocean, Teal, Lilac,
  Sunset, Candy, Amber). Accent choice cleaned up; the Klonkt background now
  follows the chosen accent color.

### Removed
- **Hub mode** removed — Klonkt is now **solo or circles**. You now create a
  collective/label via **Circles** (federated standalone sites).
- **Native comments + Google login** removed — interaction now runs entirely
  via the **fediverse**.
- **Local favorites (♥)** removed — replaced by the ⭐ fediverse like.

### Fixed
- Mini player: jump + scroll to the playing track now also works from an
  **album or playlist** (the track id wasn't in the playback queue).
- The currently playing track now gets a **persistent highlight** in the post.
- Empty **album/playlist covers** fixed (a missed reference in the
  WebP conversion) + they now fall back to the cover of the first track.
- Broken **avatar/profile photo** in the header after the WebP conversion: the viewer avatar
  (and role) is now read fresh from the database, so an old session repairs
  itself without logging in again.

### Fixed (earlier)
- Inline content layout on touch simplified: no formatting toolbar/border inline
  anymore (you edit fullscreen anyway) — only the content preview + the tap-to-edit pill.
- Couldn't scroll on the edit page: the fullscreen scroll lock (overflow:hidden
  on html/body) stayed stuck. Lock removed — the fullscreen frame already covers the page
  and on touch the scrollbars are hidden.
- Leaving fullscreen now scrolls to the top of the content (instead of jumping
  down to the footer).
- The "tap to edit" hint on touch is now a pill that sticks to the bottom of the
  container (above the Save bar) instead of being ugly-centered in the text.
- Scrollbars hidden on mobile & tablet (touch) — scrolling still works,
  only the bar UI is gone (no confusing/duplicate bars).
- Fullscreen editor: no more double scrollbar — in fullscreen only the
  text field scrolls; the frame and the page (html+body) behind it are locked.
- Editor: the view no longer jumps when clicking a formatting button.
  On mobile the writing field is now a bounded scroll box with the formatting toolbar
  STICKY at the top: the text scrolls underneath it, the toolbar always stays in view, and
  the caret scroll that mobile Chrome forces stays within the box instead of making the whole
  page jump. (Plus: scroll position is held around each
  formatting command.) `interactive-widget=resizes-content` removed again — it made
  the page scroll up for the keyboard and broke the kb-open detection; the
  action bar + fullscreen handle the keyboard via the visual viewport.
- Post editor on mobile: the Save/Cancel bar now stays just above the
  keyboard (sticky with a dynamic bottom offset = max of keyboard and
  audio-player height), instead of falling behind it or floating in the middle of the screen.
  Viewport scales with the keyboard (`interactive-widget=resizes-content`).
- Mobile keyboard vs. layout (site-wide): as soon as the keyboard opens while
  typing, the fixed bottom bars (bottom-tab + mini player) hide themselves, so
  they no longer float over or overlap the input field. They come back as soon as
  the keyboard closes. (Detection via visualViewport → `body.kb-open`.)
- Editing a post on mobile no longer immediately opened the keyboard: the title no longer
  gets automatic focus (`autofocus` removed). On desktop the title still focuses.
- Writing posts on mobile: a formatting button (bold/italic/…) stole the focus from the
  text field → the selection was lost (bold couldn't be turned off anymore) and the
  page jumped down. The toolbar now keeps the focus in the editor
  (mousedown-preventDefault + focus without scroll), so toggling works and there's no
  more jump. Toolbar taps are also faster (touch-action: manipulation). Active
  formatting is now clearly filled with the accent color (and :hover no longer sticks on
  touch), so it's visible whether e.g. bold is on or off.

### Added
- Images → **WebP**: new uploads (post images/cover, avatar, site photo,
  hub hero, audio cover) are automatically converted to WebP (smaller); existing
  images were converted in one go and all references updated.
- Images are **harder to save** (right-click "save" + dragging
  blocked) — friction, not watertight protection.
- Mini player (desktop): click the playing track → **jump to the post and scroll
  to that track** (with highlight); also works for site-wide tracks via a lookup.
- Text fields (`<textarea>`) now grow site-wide with the content instead of scrolling
  internally (scroll-within-scroll was confusing). The inline writing field also grows
  along naturally; typing on mobile/tablet goes fullscreen anyway.
- On **mobile & tablet** (touch) the content behaves like a post: inline it is
  **not typable** (tap area with a "✎ Tap to edit" pill). One tap opens a
  **fullscreen writing "page"** — with real back-button support, so the
  browser back or the **"✓ Done" button** closes it and you're back in the form
  (all fields intact), after which you save everything together with the normal Save button.
- The writing window can go **fullscreen** (button in the editor toolbar, or Escape to
  go back) — nice for distraction-free writing on mobile. The formatting toolbar
  always stays at the top of the view, even when the mobile keyboard opens
  (frame follows the visual viewport).
- The admin can link their **Google account** (Account → Sign in with Google) and
  then also log in with Google. Safe: linking is only possible while you're logged in
  with a password, and Google login only grants admin access if the exact
  linked Google account (`google_sub`) matches. Unlinking is possible as long as there's a
  password.
- Liking / favoriting posts: logged-in users can like a post with a ♥ button
  (shows the number of likes). Your liked posts are on the new **Favorites** page
  (`/favorieten`, link in the account menu). Not logged in → the button leads to the login.

### Changed
- Post navigation (Newer/Older) now shows a 📌 if the linked post is pinned.
- The Newer/Older post navigation now also appears on the fan gate (login wall of a
  fan-only post), so a visitor doesn't get stuck but can keep browsing.
  Nav moved to a shared partial (`partials/post-nav.ejs`).
- Login split: the public login page (`/auth/login`) now shows visitors
  **only** Google login (listeners/fans). The admin login (username +
  password) is hidden at `/auth/admin` (not linked anywhere).
- Post navigation (Newer/Older) now keeps the same two-card structure on every post:
  if a newer/older post is missing, there's a subtle grayed-out
  placeholder ("Newest post" / "Oldest post") instead of an empty space.
- When opening a related/next post you now jump to the top of the
  page (was: you stayed stuck at the old scroll position).

## [1.0.0-beta.2] — 2026-06-19

First release where we actively track the version (visible in the footer →
click it for this page). Federation proto: **2** (unchanged).

### Added
- Release tracking: the version number in the footer links to this changelog page.
- Eight premium features (Patreon-gated): newsletter/mailing list, download-for-email,
  release scheduling + fan-only previews, EPK/press kit, pro statistics, link-in-bio +
  click stats, embeddable player, and show agenda + notify-me.
- Newsletter signup field in the footer (on/off in Admin → Settings).
- SMTP settings configurable in Admin → Settings (no more `.env` edit needed),
  with a test-mail button.

### Changed
- Admin → Settings: Hub and Circle config now sit directly under the Mode card;
  forms tidier (stacked labels, full-width inputs).
- EPK/press kit shows the top 10 most-listened tracks.
- Nicer 404 page (mobile-friendly) and clearer login error messages.

### Fixed
- The site-wide audio player got no tracks (wrong column in the query).
- Button text became unreadable on hover (same color as the button).
- Date pickers now follow the theme.
- htmx navigation updates the address bar again; no double header on back/forward.
