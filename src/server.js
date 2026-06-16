/**
 * Klonkt Hub Beta — server bootstrap
 *
 * Persoonlijk multi-site platform — Node + SQLite + htmx.
 * Stack: Express + better-sqlite3 + EJS + htmx + ws.
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import db, { initializeDatabase } from './config/database.js';
import { SqliteSessionStore } from './services/SqliteSessionStore.js';
import PrutterService from './services/PrutterService.js';
import { WebSocketServer } from 'ws';

import { resolveSite, loadAudioTracks, loadTheme } from './middleware/site.js';
import { isViewer } from './middleware/auth.js';
import { renderPage } from './middleware/render.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import adminAudioRoutes from './routes/admin-audio.js';
import adminPlaylistsRoutes from './routes/admin-playlists.js';
import adminSitesRoutes from './routes/admin-sites.js';
import adminUsersRoutes from './routes/admin-users.js';
import adminCommentsRoutes from './routes/admin-comments.js';
import adminSettingsRoutes from './routes/admin-settings.js';
import prutterRoutes from './routes/prutter.js';
import audioRoutes from './routes/audio.js';
import searchRoutes from './routes/search.js';
import commentsRoutes from './routes/comments.js';
import tagsRoutes from './routes/tags.js';
import typesRoutes from './routes/types.js';
import usersRoutes from './routes/users.js';
import feedRoutes from './routes/feed.js';
import hubRoutes from './routes/hub.js';
import artistsRoutes from './routes/artists.js';
import postsRoutes from './routes/posts.js';
import federationRoutes from './routes/federation.js';
import { startCircleSyncLoop } from './services/CircleService.js';
import adminCircleRoutes from './routes/admin-circle.js';
import adminUpdatesRoutes from './routes/admin-updates.js';
import circleRoutes from './routes/circle.js';

if (!process.env.SESSION_SECRET) {
  console.error('❌ FATAL: SESSION_SECRET is required');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && process.env.SESSION_SECRET.length < 32) {
  console.error('❌ FATAL: SESSION_SECRET too weak for production');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
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
        // Eigen custom-embeds (embed-player.js) laden de OFFICIELE player-API's
        // van deze hosts. Zonder deze whitelist blokkeert de CSP ze stil (alleen
        // een console-fout) en faalt de embed-speler.
        "https://www.youtube.com",   // YouTube IFrame Player API (+ www-widgetapi.js)
        "https://s.ytimg.com",       // YouTube player-assets
        "https://w.soundcloud.com",  // SoundCloud Widget API (api.js)
        "https://open.spotify.com",  // Spotify iFrame API
      ],
      // Helmet's default zet script-src-attr op 'none', wat ALLE inline event-
      // handlers (onchange/onclick/onsubmit) blokkeert — daardoor deed o.a. de
      // avatar-upload (<input onchange="this.form.submit()">) en de rol-dropdown
      // niets. We staan inline handlers expliciet toe, consistent met de al
      // toegestane inline <script> hierboven.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
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
        "https://www.youtube.com",   // YouTube IFrame API maakt soms een www.youtube.com-iframe
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
app.use('/media', express.static(process.env.MEDIA_PATH || './storage/media'));

// (Verwijderd) TWA / digital-asset-links — alleen nodig voor de APK/TWA-variant.
// Klonkt is PWA-only; geen assetlinks.json meer.

initializeDatabase();

// Cirkels: periodieke achtergrond-sync van remote instances (no-op tenzij tenancy='circle').
startCircleSyncLoop();

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

// Singleton PrutterService — routes get it via req.app.locals.prutter.
const prutter = new PrutterService(db);
app.locals.prutter = prutter;

// Cirkels-federatie: publieke, site-agnostische endpoints (/.klonkt/*).
// Vóór resolveSite/theme — ze hebben geen site-context nodig.
app.use(federationRoutes);

app.use(resolveSite);
app.use(loadAudioTracks);
app.use(loadTheme);

// Lichtgewicht CSRF-defense: weiger cross-origin state-wijzigende requests.
// Same-origin forms + HTMX sturen een matchende Origin; ontbreekt Origin dan
// laten we door (non-browser clients). sameSite:'lax' op de sessiecookie is de
// tweede laag. (Geldt niet voor GET/HEAD/OPTIONS.)
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next(); // geen Origin -> geen browser-CSRF-vector
  let originHost;
  try { originHost = new URL(origin).host; } catch { return res.status(403).send('Ongeldige origin'); }
  if (originHost !== req.get('host')) return res.status(403).send('Cross-origin request geweigerd');
  next();
});

// Kijker-accounts: alles bekijken mag (incl. Beheer), niets wijzigen. Dit is de
// ENIGE schrijf-blokkade — fail-closed, vóór alle route-handlers. Elke state-
// wijzigende methode wordt geweigerd (de login-POST zet de sessie pas ná deze
// guard, dus die valt er niet onder). I.p.v. rauwe 403-tekst tonen we een nette
// pagina (of, bij HTMX, een ingeswapte melding).
app.use((req, res, next) => {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (mutating && isViewer(req.session?.user)) {
    if (req.headers['hx-request'] === 'true') {
      // htmx swapt niet op 4xx; stuur 200 + retarget zodat de melding in #pcms-main verschijnt.
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
app.use('/admin/audio', adminAudioRoutes);
app.use('/admin/playlists', adminPlaylistsRoutes);
app.use('/admin/sites', adminSitesRoutes);
app.use('/admin/users', adminUsersRoutes);
app.use('/admin/comments', adminCommentsRoutes);
app.use('/admin/settings', adminSettingsRoutes);
app.use('/admin/circle', adminCircleRoutes);
app.use('/admin/updates', adminUpdatesRoutes);
app.use('/admin', adminRoutes);
app.use('/prutter', prutterRoutes);
app.use('/audio', audioRoutes);
app.use('/search', searchRoutes);
app.use('/comments', commentsRoutes);
app.use('/tag', tagsRoutes);
app.use('/type', typesRoutes);
app.use('/users', usersRoutes);
// Feed/sitemap routes are mounted at root because they're at well-known paths
app.use('/', feedRoutes);
app.use('/leden', artistsRoutes); // doorzoekbare leden-directory (alleen hub; solo: next())
app.get('/artiesten', (req, res) => res.redirect(301, req.originalUrl.replace(/^\/artiesten/, '/leden'))); // oude URL -> /leden
app.use('/', hubRoutes); // hub-overview op '/' (solo: next() -> postsRoutes)
app.use('/', circleRoutes); // /cirkel-feed (solo/hub: next() -> postsRoutes)
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

  // A stable identity per site so installs don't collide (Chromium uses `id`)
  const idBase = site?.slug ? `prutfolio-${site.slug}` : 'prutfolio';

  res.set('Cache-Control', 'no-cache');
  res.json({
    id: idBase,
    name: site?.title || 'Klonkt Hub Beta',
    short_name: (site?.title || 'Klonkt').slice(0, 12),
    description: site?.description || site?.tagline || '',
    scope,
    start_url: startUrl,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#1a1a17',
    theme_color: site?.accent || '#c2410c',
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
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#c2410c';
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
const CACHE_VERSION = 'pcms-v10-' + new Date().toISOString().split('T')[0];
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
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
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
  res.status(404).send(`
    <div style="font-family:system-ui;max-width:500px;margin:4rem auto;text-align:center;padding:2rem;">
      <h1 style="font-size:5rem;margin:0;color:#c33;">404</h1>
      <p>Not found</p>
      <a href="/" style="color:#c2410c;">← Home</a>
    </div>
  `);
});

// ==================== WebSocket: Prutter real-time ====================
// Authenticate via the existing session cookie. We reuse sessionMiddleware
// during the HTTP upgrade so req.session is populated; if no user, abort.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/prutter') {
    socket.destroy();
    return;
  }
  // Run session middleware on the upgrade request.
  // (Express's middleware accepts (req, res, next); we pass a stub res.)
  const stubRes = { setHeader: () => {}, getHeader: () => undefined, on: () => {}, end: () => {} };
  sessionMiddleware(req, stubRes, () => {
    if (!req.session?.user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Kijker-accounts zijn alleen-lezen: weiger de WS-upgrade. De HTTP-guard
    // dekt geen WS, dus dit is de plek om schrijven via een (toekomstige)
    // message-handler te voorkomen.
    if (isViewer(req.session.user)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = req.session.user.id;
      wss.emit('connection', ws, req);
    });
  });
});

wss.on('connection', (ws) => {
  prutter.addConnection(ws.userId, ws);
  ws.on('close', () => prutter.removeConnection(ws.userId, ws));
  ws.on('error', () => prutter.removeConnection(ws.userId, ws));
  // Optional: ping every 30s to keep connections alive through proxies
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
const wsPing = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
if (wsPing.unref) wsPing.unref();

server.listen(PORT, () => {
  console.log('');
  console.log('🪶 Klonkt Hub Beta');
  console.log(`   http://localhost:${PORT}`);
  console.log('');
  console.log(`   ✓ Security: Helmet, CSP, secure sessions`);
  console.log(`   ✓ Privacy:  Self-hosted fonts, no third-party requests`);
  console.log(`   ✓ Layout:   v9 editorial feel (top nav, profile header)`);
  console.log(`   ✓ Auth:     wachtwoord (beheer) + Google (luisteraars) / logout`);
  console.log(`   ✓ Posts:    create / edit / view / archive`);
  console.log(`   ✓ Realtime: WebSocket server ready (Prutter)`);
  console.log('');
  console.log(`   Mode: ${isDev ? 'development' : 'PRODUCTION'}`);
  console.log('');
});

export default app;
