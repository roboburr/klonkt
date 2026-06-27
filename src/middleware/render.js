/**
 * Render helper — THE pattern for the entire app.
 * 
 * Two modes:
 *   1. HTMX request → render just the page content (no shell)
 *   2. Full page request → render content, then embed in shell
 * 
 * Usage:
 *   renderPage(req, res, 'pages/home', { posts, ...data })
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import db from '../config/database.js';
import PermissionsService from '../services/PermissionsService.js';
import { isViewer } from './auth.js';
import { getSetting, apEnabled } from '../services/SettingsService.js';
import { isPremium as isPremiumInstance, premiumEnabled, premiumUnlocked } from '../services/PatreonService.js';
import ActivityPubService from '../services/ActivityPubService.js';
import { audioEnabled as audioFeatureEnabled } from '../config/features.js';
import { PLATFORMS as PLATFORMS_CATALOG } from '../services/PlatformIcons.js';
import { t as i18nT, resolveLang, SUPPORTED as LANGS, LANG_NAMES } from '../services/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'views');

// App version (from package.json) + short commit hash (from .klonkt-version, written by
// the deploy script) — shown in the footer next to "Klonkt Beta". The hash is updated
// automatically on every deploy, so the displayed version is never stale.
let APP_VERSION = '';
try {
  APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || '';
  try {
    const sha = fs.readFileSync(path.join(__dirname, '..', '..', '.klonkt-version'), 'utf8').trim().slice(0, 7);
    if (sha) APP_VERSION += ' · ' + sha;
  } catch { /* no .klonkt-version (local dev) */ }
} catch { /* no version available */ }

// Site timezone (Admin → Settings). Empty = server default (UTC). Applied to
// all server-side formatted dates so they display in the site's timezone instead of UTC.
const siteTimezone = () => getSetting('timezone') || undefined;

const formatDate = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('nl-NL', { timeZone: siteTimezone(), day: 'numeric', month: 'long', year: 'numeric' });
};

const formatDateTime = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleString('nl-NL', { timeZone: siteTimezone(), dateStyle: 'medium', timeStyle: 'short' });
};

// Cross-site Klonkt audio embeds (a followed/boosted site's /embed player) need their
// origins in the DOCUMENT CSP frame-src — the per-/news injection is ignored once you
// navigate there via htmx (the document's CSP governs, not the partial's). Collect the
// distinct origins from the site's timeline (followed + boosted). Cached 60s.
const _embedOriginsCache = new Map(); // slug -> { origins, exp }
function embedOriginsFor(slug) {
  const now = Date.now();
  const c = _embedOriginsCache.get(slug);
  if (c && c.exp > now) return c.origins;
  let origins = [];
  try {
    const rows = db.prepare('SELECT DISTINCT url FROM ap_timeline WHERE slug = ? AND url IS NOT NULL').all(slug);
    const set = new Set();
    for (const r of rows) { try { set.add(new URL(r.url).origin); } catch { /* skip bad url */ } }
    origins = [...set];
  } catch { origins = []; }
  _embedOriginsCache.set(slug, { origins, exp: now + 60000 });
  return origins;
}

export async function renderPage(req, res, viewName, data = {}) {
  // Decide: partial (HTMX) or full?
  const isPartial = req.headers['hx-request'] === 'true' || req.query.partial === '1';

  // Prevent the browser from caching an htmx PARTIAL (only #pcms-main, without <head>/CSS)
  // under the same URL and serving it as a full page on "back" → unstyled HTML.
  // Vary: HX-Request separates partial and full responses in the cache;
  // no-store on the partial forces "back" to always re-fetch the full page.
  // (Vary also applies to intermediate caches / Cloudflare.)
  res.setHeader('Vary', 'HX-Request');
  if (isPartial) res.setHeader('Cache-Control', 'no-store');

  // Does this (non-god) user own a site? Determines whether they see an "Admin"
  // entry (artist self-manage). god always sees admin (by role).
  let _u = req.session?.user || null;
  // Refresh avatar + role from the DB so a stale session (e.g. after an
  // avatar change or role switch) heals itself without a new login.
  if (_u && _u.id) {
    const _fresh = db.prepare('SELECT avatar_url, role, lang FROM users WHERE id = ?').get(_u.id);
    if (_fresh) _u = { ..._u, avatar_url: _fresh.avatar_url, role: _fresh.role, lang: _fresh.lang };
    // One identity: no own account avatar → fall back to the user's site photo,
    // so the same picture shows everywhere (nav, account, comments).
    if (_u && !_u.avatar_url) {
      const _sp = db.prepare("SELECT profile_photo FROM sites WHERE owner_id = ? AND profile_photo IS NOT NULL ORDER BY is_primary DESC, created_at ASC LIMIT 1").get(_u.id);
      if (_sp && _sp.profile_photo) _u = { ..._u, avatar_url: _sp.profile_photo };
    }
  }
  const userOwnsSite = !!(_u && _u.role !== 'god' &&
    db.prepare('SELECT 1 FROM sites WHERE owner_id = ? LIMIT 1').get(_u.id));

  // The avatar of the SITE OWNER (not the viewer!) — for the Klonkt site header,
  // so the artist can use their own account photo as the site photo.
  const _site = data.site || res.locals.site || null;
  const siteOwnerAvatar = (_site && _site.owner_id)
    ? (db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(_site.owner_id)?.avatar_url || null)
    : null;

  // Viewer mode: may view everything, change nothing. Views use canMutate
  // to hide/disable write buttons (post, save, delete).
  const _isViewer = isViewer(_u);

  // Per-domain CSP: let a logged-in site manager frame the Klonkt players of the sites in
  // their timeline (followed + boosted) on the DOCUMENT, so cross-site embeds also work
  // after an htmx/PWA navigation. NEVER on authorize_interaction — that page shows
  // untrusted remote content next to the interact buttons, so no embeds / no frame-src
  // loosening there (clickjacking risk).
  try {
    if (_site && _site.slug && viewName !== 'pages/authorize-interaction' && _u && PermissionsService.canAdminSite(_u, _site)) {
      const origins = embedOriginsFor(_site.slug);
      if (origins.length) {
        const csp = res.getHeader('Content-Security-Policy');
        if (csp) res.setHeader('Content-Security-Policy', String(csp).replace(/frame-src ([^;]*)/i, (m, g) => `frame-src ${g} ${origins.join(' ')}`));
      }
    }
  } catch { /* CSP extension is best-effort */ }

  // Who sees the "Admin" link? god/admin, a site owner (artist self-manage),
  // and a viewer (may view Admin read-only). One source of truth,
  // mirrored in topnav/hub-nav/profile sheet — otherwise the link gets hidden
  // for those who should see it (viewer didn't see it anywhere before).
  const _role = _u ? _u.role : null;
  const canSeeBeheer = !!(_u && (_role === 'god' || _role === 'admin' || _role === 'kijker' || userOwnsSite));
  // Who may use the fediverse client (timeline/notifications/blocking) — actual
  // site managers only (these routes are requireSiteManager; viewers are excluded).
  const canManageFedi = !!(_u && (_role === 'god' || _role === 'admin' || userOwnsSite));

  // Interface language: session choice (this session) → logged-in user's own preference
  // (users.lang) → admin-set default (Admin → Settings) → env → browser → nl.
  const _lang = resolveLang(req, {
    userLang: _u && _u.lang,
    defaultLang: getSetting('default_lang'),
  });

  // Common locals
  const locals = {
    user: _u,
    lang: _lang,
    t: (key, vars) => i18nT(_lang, key, vars),
    langs: LANGS.map((c) => ({ code: c, name: LANG_NAMES[c], active: c === _lang })),
    timezone: getSetting('timezone') || '',
    notifUnread: (canManageFedi && _site) ? ActivityPubService.countUnseenNotifications(_site.slug) : 0,
    userOwnsSite,
    canSeeBeheer,
    canManageFedi,
    apEnabled: apEnabled(),
    // Cirkel = the artists you feature (auto-boost). Shown when AP is on and you
    // auto-boost ≥1 account, or (legacy) on a circle-tenancy site.
    hasCirkel: !!(_site && apEnabled() && (ActivityPubService.autoBoostCount(_site.slug) > 0 || ActivityPubService.boostedCount(_site.slug) > 0)),
    isViewer: _isViewer,
    canMutate: !_isViewer,
    isPremium: isPremiumInstance(),
    premiumEnabled: premiumEnabled(),
    premiumUnlocked: premiumUnlocked(),
    siteOwnerAvatar,
    site: _site,
    audioEnabled: audioFeatureEnabled(),
    audioTracks: data.audioTracks || res.locals.audioTracks || [],
    siteUrlBase: res.locals.siteUrlBase || '',
    tenancy: res.locals.tenancy || 'solo',
    hubTitle: getSetting('hub_title') || '',
    footerNewsletter: getSetting('footer_newsletter') === '1', // newsletter sign-up in footer (premium)
    agendaEnabled: getSetting('agenda_enabled') === '1', // show agenda/events in the pill (premium, opt-in)
    platforms_catalog: PLATFORMS_CATALOG,
    permissions: PermissionsService,
    formatDate,
    formatDateTime,
    pageTitle: data.pageTitle || (data.site && data.site.title) || 'Klonkt Beta',
    appVersion: APP_VERSION,
    bodyClass: data.bodyClass || 'on-home',
    socialDescr: data.socialDescr || '',
    socialImage: data.socialImage || '',
    cspNonce: () => '',
    currentPath: req.path,
    // Absolute origin (for building absolute URLs like the generated og:image).
    ogOrigin: (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host') || ''}`).replace(/\/+$/, ''),
    ...data,
  };

  try {
    // Step 1: Render the page view to HTML
    const viewPath = path.join(VIEWS_DIR, viewName + '.ejs');
    const pageContent = await ejs.renderFile(viewPath, locals, { async: false });

    if (isPartial) {
      // HTMX: just send the content. Set HX-Trigger for body class swap.
      // HTTP-header values are Latin-1 only — a title with an em-dash, smart
      // quote or emoji (e.g. "Welkom — gebouwd met Klonkt") would make
      // setHeader throw ERR_INVALID_CHAR and 500 the partial, so the card
      // looks "unclickable". Escape any non-ASCII to \uXXXX: the header stays
      // ASCII-safe and remains valid JSON that htmx parses back unchanged.
      // Per-site accent + palette live in the shell <head> (style#pcms-site-accent
      // + html[data-palette]) and are NOT swapped during htmx navigation. Send them along
      // so the client updates them — otherwise an artist inherits the previous page's
      // colours (e.g. hub-purple instead of their own green). Same derivation as shell.ejs.
      const _navAccent = (_site && _site.accent && /^#[0-9a-fA-F]{6}$/.test(_site.accent))
        ? _site.accent : '#e8b04b';
      const _navPalette = (_site && _site.palette) ? _site.palette : 'klonkt';
      const triggerJson = JSON.stringify({
        pcmsNav: { bodyClass: locals.bodyClass, accent: _navAccent, palette: _navPalette },
        pcmsPostSwap: data.post ? {
          title: data.post.title,
          slug: data.post.slug,
          pageTitle: locals.pageTitle,
        } : null,
      }).replace(/[-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
      res.setHeader('HX-Trigger-After-Settle', triggerJson);
      // Render the site chrome out-of-band so the header (topnav/profile header/
      // view-switcher) ALWAYS matches the new page/artist on navigation —
      // while the audio player (separate in document.body) keeps playing (no
      // interruption). htmx replaces #pcms-chrome via hx-swap-oob. Non-critical:
      // if it fails, the old chrome remains (no crash).
      let oobChrome = '';
      try {
        oobChrome = await ejs.renderFile(
          path.join(VIEWS_DIR, 'partials', 'chrome.ejs'),
          { ...locals, oob: true },
          { async: false },
        );
      } catch (e) { /* skip chrome OOB */ }
      return res.send(pageContent + oobChrome);
    }

    // Full: wrap content in shell
    locals.pageContent = pageContent;
    res.render('shell', locals);
  } catch (err) {
    console.error('[renderPage] Error rendering', viewName, err);
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).send('Internal Server Error');
    }
    // Dev: surface the underlying cause prominently. EJS rewrites err.message
    // to include the file/line/code-context, so we also surface name+stack
    // separately in case the message was truncated or empty.
    const escape = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.status(500).send(`<!doctype html>
<meta charset="utf-8">
<title>Render error: ${escape(viewName)}</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; background:#1a1a1a; color:#eee; }
  h1 { color:#dc2626; font-family: ui-sans-serif, system-ui; }
  h2 { color:#fb923c; font-size:1rem; margin-top:1.5rem; }
  pre { background:#0a0a0a; border:1px solid #333; border-radius:6px; padding:1rem; overflow:auto; white-space:pre-wrap; word-break:break-word; }
  .cause { background:#3d0a0a; border-color:#7a1a1a; color:#fca5a5; font-weight:600; }
</style>
<h1>Render error in ${escape(viewName)}</h1>
<h2>Cause</h2>
<pre class="cause">${escape(err.name || 'Error')}: ${escape(err.message || '(no message)')}</pre>
<h2>Stack</h2>
<pre>${escape(err.stack || '(no stack)')}</pre>
${err.path ? `<h2>File</h2><pre>${escape(err.path)}</pre>` : ''}
`);
  }
}
