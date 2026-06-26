/**
 * Klonkt Beta — server bootstrap
 *
 * Personal multi-site platform — Node + SQLite + htmx.
 * Stack: Express + better-sqlite3 + EJS + htmx + ws.
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import http from 'http';
import db, { initializeDatabase } from './config/database.js';
import { startScheduler } from './services/Scheduler.js';
import { SqliteSessionStore } from './services/SqliteSessionStore.js';
import { ensurePrimarySite } from './services/ensurePrimarySite.js';
import { resolveSite, loadAudioTracks, loadTheme } from './middleware/site.js';
import { isViewer } from './middleware/auth.js';
import { renderPage } from './middleware/render.js';
import { audioEnabled } from './config/features.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import notificationsRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import adminAudioRoutes from './routes/admin-audio.js';
import adminPlaylistsRoutes from './routes/admin-playlists.js';
import adminSitesRoutes from './routes/admin-sites.js';
import adminUsersRoutes from './routes/admin-users.js';
import adminSettingsRoutes from './routes/admin-settings.js';
import adminSeoRoutes from './routes/admin-seo.js';
import audioRoutes from './routes/audio.js';
import searchRoutes from './routes/search.js';
import tagsRoutes from './routes/tags.js';
import typesRoutes from './routes/types.js';
import usersRoutes from './routes/users.js';
import feedRoutes from './routes/feed.js';
import postsRoutes from './routes/posts.js';
import langRoutes from './routes/lang.js';
import adminUpdatesRoutes from './routes/admin-updates.js';
import adminPatreonRoutes from './routes/admin-patreon.js';
import adminStatsRoutes from './routes/admin-stats.js';
import circleRoutes from './routes/circle.js';
import epkRoutes from './routes/epk.js';
import newsletterRoutes from './routes/newsletter.js';
import adminNewsletterRoutes from './routes/admin-newsletter.js';
import downloadRoutes from './routes/download.js';
import linkbioRoutes from './routes/linkbio.js';
import embedRoutes from './routes/embed.js';
import showsRoutes from './routes/shows.js';
import adminShowsRoutes from './routes/admin-shows.js';
import adminEpkRoutes from './routes/admin-epk.js';
import changelogRoutes from './routes/changelog.js';
import ogRoutes from './routes/og.js';
import apRoutes from './routes/activitypub.js';
import { apWants, startDeliveryWorker, autoMigrateCircles } from './services/ActivityPubService.js';

// SESSION_SECRET: use the env var if set. Otherwise auto-generate a strong one
// and persist it next to the database, so it stays stable across restarts and
// updates. This lets Docker / bare-Node installs run with zero manual config.
if (!process.env.SESSION_SECRET) {
  const dataDir = path.dirname(process.env.DATABASE_PATH || './storage/database.sqlite');
  const secretFile = path.join(dataDir, '.session-secret');
  try { process.env.SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* not yet generated */ }
  if (!process.env.SESSION_SECRET) {
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, process.env.SESSION_SECRET, { mode: 0o600 });
    console.log(`🔑 Generated a SESSION_SECRET (stored in ${secretFile})`);
  }
}

// A SESSION_SECRET that was explicitly set in the env must still be strong in prod.
if (process.env.NODE_ENV === 'production' && process.env.SESSION_SECRET.length < 32) {
  console.error('❌ FATAL: SESSION_SECRET is too weak for production (set a longer, random one in .env)');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Interface to bind. Default 0.0.0.0 (needed for Docker port-forwarding). Behind a
// reverse proxy on the same host, set HOST=127.0.0.1 so the app is NOT reachable
// directly from the internet (only via the proxy) — see README/install docs.
const HOST = process.env.HOST || '0.0.0.0';
const isDev = process.env.NODE_ENV !== 'production';

const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        // Our custom embeds (embed-player.js) load the OFFICIAL player APIs
        // from these hosts. Without this whitelist the CSP silently blocks them
        // (only a console error) and the embed player fails.
        "https://www.youtube.com",   // YouTube IFrame Player API (+ www-widgetapi.js)
        "https://s.ytimg.com",       // YouTube player assets
        "https://w.soundcloud.com",  // SoundCloud Widget API (api.js)
        "https://open.spotify.com",  // Spotify iFrame API (loader)
        "https://*.spotifycdn.com",  // Spotify iFrame API (real bundle: embed-cdn.spotifycdn.com)
      ],
      // Helmet's default sets script-src-attr to 'none', which blocks ALL inline
      // event handlers (onchange/onclick/onsubmit) — causing e.g. the avatar
      // upload (<input onchange="this.form.submit()">) and the role dropdown to
      // silently do nothing. We explicitly allow inline handlers, consistent with
      // the already-allowed inline <script> above.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // blob: required for the image editor (Cropper) — it displays the chosen
      // photo via URL.createObjectURL(blob:…). Without blob: the CSP silently
      // blocks the <img> → empty edit window. (media-src already has blob: for audio.)
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://*.spotifycdn.com", "https://*.scdn.co"],
      // blob: is required for the audio player — it fetch()es track bytes and
      // plays from a blob: object URL (Spotify-style). Without blob: here the
      // CSP silently blocks <audio>.src = blob:… → the player fires 'error' and
      // auto-skips every track. 'self'/https: do NOT imply blob:.
      mediaSrc: ["'self'", "https:", "blob:"],
      fontSrc: ["'self'"],
      frameSrc: [
        "'self'",
        "https://open.spotify.com",
        "https://w.soundcloud.com",
        "https://bandcamp.com",
        "https://embed.music.apple.com",
        "https://www.youtube-nocookie.com",
        "https://www.youtube.com",   // YouTube IFrame API sometimes creates a www.youtube.com iframe
        "https://player.vimeo.com",
      ],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'sameorigin' },
  referrerPolicy: { policy: 'no-referrer-when-downgrade' },
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));

// Trust one upstream proxy in production. NPM (or Caddy / nginx) terminates
// HTTPS and forwards to us over plain HTTP, setting X-Forwarded-Proto: https.
// Without this, Express sees req.protocol === 'http' and won't issue secure
// cookies — sessions never persist past the redirect after login.
if (!isDev) app.set('trust proxy', 1);

// Create/migrate the schema BEFORE anything touches the DB: the session store
// queries the `sessions` table on construction, so on a fresh install the tables
// must exist first (otherwise: "no such table: sessions" → crash loop on first boot).
initializeDatabase();
startScheduler(); // release planning: publish scheduled posts when publish_at is reached
startDeliveryWorker(); // retry failed fediverse deliveries with backoff
autoMigrateCircles(); // one-time: convert legacy circle_links -> AP auto-boost follows

// Safety net: guarantee that there is always a primary site (solo/hub/circle).
// Idempotent — does nothing if a site already exists or there is no admin yet.
ensurePrimarySite();

// Session middleware extracted into a variable so the WebSocket upgrade
// handler can reuse it (it needs req.session to authenticate sockets).
const sessionMiddleware = session({
  store: new SqliteSessionStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'pcms.sid',
  cookie: {
    httpOnly: true,
    secure: !isDev,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: isDev ? 0 : '1y' }));
app.use('/media', express.static(process.env.MEDIA_PATH || './storage/media', {
  // Public media (post covers, avatars) must be cross-origin embeddable by other
  // Klonkt sites in their CIRCLE. Helmet sets CORP=same-origin by default, which
  // causes the browser to block those images (the file arrives, but the browser
  // refuses to render it). Set cross-origin explicitly for /media.
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
}));

// (Removed) TWA / digital-asset-links — only needed for the APK/TWA variant.
// Klonkt is PWA-only; assetlinks.json is no longer served.

// Bundle HTMX: copy from node_modules into our own assets dir so we can serve
// it locally (no third-party CDN). Idempotent — only copies if size differs.
(function ensureLocalHtmx() {
  const src = path.join(__dirname, '..', 'node_modules', 'htmx.org', 'dist', 'htmx.min.js');
  const dest = path.join(__dirname, 'assets', 'js', 'htmx.min.js');
  try {
    const srcStat = fs.statSync(src);
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (!destStat || destStat.size !== srcStat.size) {
      fs.copyFileSync(src, dest);
      console.log(`📦 HTMX bundled locally: ${srcStat.size} bytes`);
    }
  } catch (e) {
    console.warn('⚠️  Could not bundle HTMX:', e.message, '— run `npm install`');
  }
})();

// ActivityPub: WebFinger + /ap/* (site-agnostic, resolves the site by slug).
app.use(apRoutes);

// Themed OG cards (/og/:slug.png) — resolve the site by slug themselves, so they
// run before resolveSite and need no site context.
app.use('/og', ogRoutes);

app.use(resolveSite);
app.use(loadAudioTracks);
app.use(loadTheme);

// ActivityPub content negotiation on the human URLs: an AP request (Accept:
// application/activity+json) to a profile/post URL is redirected to its /ap/*
// representation — same URL serves HTML to browsers, AP-JSON to servers (this is
// how Mastodon resolves a pasted profile/post URL). Gated on apWants() so normal
// browser requests pay nothing.
app.use((req, res, next) => {
  if (req.method !== 'GET' || !apWants(req)) return next();
  const site = res.locals.site;
  if (!site || !site.slug) return next();
  const seg = req.path.replace(/^\/+|\/+$/g, '');
  if (seg === '') return res.redirect(302, `/ap/users/${encodeURIComponent(site.slug)}`);
  if (!seg.includes('/')) {
    try {
      const post = db.prepare(
        "SELECT id FROM posts WHERE site_id = ? AND slug = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)"
      ).get(site.id, seg);
      if (post) return res.redirect(302, `/ap/notes/${post.id}`);
    } catch { /* fall through to normal HTML handling */ }
  }
  return next();
});

// Lightweight CSRF defense: reject cross-origin state-mutating requests.
// Same-origin forms + HTMX send a matching Origin; missing Origin is allowed
// through (non-browser clients). sameSite:'lax' on the session cookie is the
// second layer. (Does not apply to GET/HEAD/OPTIONS.)
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next(); // no Origin → no browser CSRF vector
  let originHost;
  try { originHost = new URL(origin).host; } catch { return res.status(403).send('Ongeldige origin'); }
  if (originHost !== req.get('host')) return res.status(403).send('Cross-origin request geweigerd');
  next();
});

// Viewer accounts: may view everything (including Admin), change nothing. This is
// the ONLY write gate — fail-closed, before all route handlers. Every state-mutating
// method is rejected (the login POST sets the session after this guard, so it is
// not affected). Instead of raw 403 text we render a clean page (or, for HTMX,
// a swapped-in message).
app.use((req, res, next) => {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (mutating && isViewer(req.session?.user)) {
    if (req.headers['hx-request'] === 'true') {
      // htmx doesn't swap on 4xx; send 200 + retarget so the message appears in #pcms-main.
      res.setHeader('HX-Retarget', '#pcms-main');
      res.setHeader('HX-Reswap', 'innerHTML');
      res.status(200);
    } else {
      res.status(403);
    }
    return renderPage(req, res, 'pages/viewer-blocked', {
      pageTitle: 'Kijker-modus',
      bodyClass: 'on-special',
    });
  }
  next();
});

app.use('/auth', authRoutes);
app.use('/account', accountRoutes);
app.use('/notifications', notificationsRoutes);
if (audioEnabled()) {
  app.use('/admin/audio', adminAudioRoutes);
  app.use('/admin/playlists', adminPlaylistsRoutes);
}
app.use('/admin/sites', adminSitesRoutes);
app.use('/admin/users', adminUsersRoutes);
app.use('/admin/settings', adminSettingsRoutes);
app.use('/admin/seo', adminSeoRoutes);
app.use('/admin/updates', adminUpdatesRoutes);
app.use('/admin/patreon', adminPatreonRoutes);
app.use('/admin/stats', adminStatsRoutes);
app.use('/admin/newsletter', adminNewsletterRoutes);
app.use('/admin/shows', adminShowsRoutes);
app.use('/admin/epk', adminEpkRoutes);
app.use('/admin', adminRoutes);
if (audioEnabled()) app.use('/audio', audioRoutes);
app.use('/search', searchRoutes);
app.use('/tag', tagsRoutes);
app.use('/type', typesRoutes);
app.use('/users', usersRoutes);
// Feed/sitemap routes are mounted at root because they're at well-known paths
app.use('/', feedRoutes);
app.use('/', circleRoutes); // /cirkel-feed (solo: next() -> postsRoutes)
app.use('/', epkRoutes); // /pers perskit (premium; niet-premium: next() -> 404)
app.use('/', newsletterRoutes); // /nieuwsbrief in/uitschrijven (premium; niet-premium: next())
if (audioEnabled()) app.use('/', downloadRoutes); // /downloads + /download/:id (audio; lite: uit)
app.use('/', linkbioRoutes); // /links link-in-bio + klikstats (premium)
if (audioEnabled()) app.use('/', embedRoutes); // /embed inbedbare audiospeler (audio; lite: uit)
app.use('/', showsRoutes); // /shows agenda + notify-me (premium)
app.use('/', changelogRoutes); // /changelog publieke release-/wijzigingen-pagina
app.use('/', langRoutes); // /lang/:code — interface-taal kiezen (vóór de catch-all)
app.use('/', postsRoutes);

app.get('/manifest.webmanifest', (req, res) => {
  const site = res.locals.site;

  // PWA scope: confines installed apps to ONE site. If a user is in the
  // bedrijf1 PWA and clicks a link to /sites/bedrijf2/..., the browser will
  // open it in a regular tab (out-of-scope) instead of within the PWA.
  // Same applies to APK packaging — the WebView is locked to this scope.
  //
  // For path-mounted sites: scope = /sites/<slug>/
  // For root/subdomain sites:  scope = /
  const base = res.locals.siteUrlBase || '';   // '' or '/sites/<slug>'
  const scope = (base || '') + '/';
  const startUrl = (base || '') + '/?source=pwa';

  // A stable identity per site so installs don't collide (Chromium uses `id`).
  // NB: changing the id orphans existing PWA installs (no migration carries an
  // install across an id change) — anyone who already installed the site as a
  // PWA will need to reinstall once. Data stays server-side, so nothing is lost.
  const idBase = site?.slug ? `klonkt-${site.slug}` : 'klonkt';

  res.set('Cache-Control', 'no-cache');
  res.json({
    id: idBase,
    name: site?.title || 'Klonkt',
    short_name: (site?.title || 'Klonkt').slice(0, 12),
    description: site?.description || site?.tagline || '',
    scope,
    start_url: startUrl,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#1a1a17',
    theme_color: site?.accent || '#e8b04b',
    lang: site?.language || 'nl',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/favicon.ico', sizes: '64x64', type: 'image/x-icon' },
    ],
    // Hint to capable browsers: capture all in-scope links inside the PWA
    capture_links: 'existing-client-navigate',
  });
});

// Favicon — served as SVG so it picks up the site's accent color dynamically.
// Browsers also request /favicon.ico by convention; we serve the same SVG
// content there with a forgiving content-type since modern browsers accept it.
function _renderFavicon(res, accent) {
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#e8b04b';
  // Site mark: rounded square in the site accent + bold white 'K' (Klonkt)
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${safeAccent}"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="42" font-weight="800" fill="#fff">K</text>
</svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
}

app.get('/favicon.svg', (req, res) => {
  _renderFavicon(res, res.locals.site?.accent);
});
app.get('/favicon.ico', (req, res) => {
  // Browsers requesting .ico will accept SVG content; chrome/firefox both fine.
  // Keeping the route prevents 404 spam in the console.
  _renderFavicon(res, res.locals.site?.accent);
});

app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.send(`
const CACHE_VERSION = 'pcms-v11-' + new Date().toISOString().split('T')[0];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(['/'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
  )));
  self.clients.claim();
});
// ONLY intercept navigations (HTML pages) for an offline fallback.
// Do NOT touch images, CSS, JS or /media — let the browser handle those natively.
// Otherwise a failed network fetch could fall back to an empty cache match
// (undefined) and "break" an image on a normal refresh (hard reload bypasses
// the SW, which is why that case worked fine).
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode !== 'navigate') return; // page loads only
  e.respondWith(
    fetch(e.request).catch(() => caches.match('/').then(r => r || Response.error()))
  );
});
  `);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection:', reason);
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).send(
    isDev ? `<pre>${err.stack || err.message}</pre>` : 'Internal Server Error'
  );
});

app.use((req, res) => {
  res.status(404);
  // Clean, mobile-friendly 404 via the shell (viewport + nav + site theme).
  // Falls back to bare HTML if rendering unexpectedly fails.
  try {
    return renderPage(req, res, 'pages/404', {
      pageTitle: '404 — niet gevonden',
      bodyClass: 'on-special on-404',
    });
  } catch (e) {
    return res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:system-ui;max-width:500px;margin:4rem auto;text-align:center;padding:2rem"><h1 style="font-size:4rem;margin:0">404</h1><p>Pagina niet gevonden</p><a href="/">← Home</a></div>');
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('🪶 Klonkt Beta');
  console.log(`   http://localhost:${PORT}`);
  console.log('');
  console.log(`   ✓ Security: Helmet, CSP, secure sessions`);
  console.log(`   ✓ Privacy:  Self-hosted fonts, no third-party requests`);
  console.log(`   ✓ Layout:   v9 editorial feel (top nav, profile header)`);
  console.log(`   ✓ Auth:     wachtwoord (beheer) + Google (luisteraars) / logout`);
  console.log(`   ✓ Posts:    create / edit / view / archive`);
  console.log('');
  console.log(`   Mode: ${isDev ? 'development' : 'PRODUCTION'}`);
  console.log('');
});

export default app;
