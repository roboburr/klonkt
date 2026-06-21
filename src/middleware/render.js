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
import { getSetting } from '../services/SettingsService.js';
import { isPremium as isPremiumInstance, premiumEnabled, premiumUnlocked } from '../services/PatreonService.js';
import { PLATFORMS as PLATFORMS_CATALOG } from '../services/PlatformIcons.js';
import { t as i18nT, resolveLang, SUPPORTED as LANGS, LANG_NAMES } from '../services/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'views');

// App-versie (uit package.json) — getoond in de footer naast "Klonkt Beta".
let APP_VERSION = '';
try {
  APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || '';
} catch { /* geen versie beschikbaar */ }

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
};

export async function renderPage(req, res, viewName, data = {}) {
  // Decide: partial (HTMX) or full?
  const isPartial = req.headers['hx-request'] === 'true' || req.query.partial === '1';

  // Bezit deze (niet-god) user een eigen site? Bepaalt of 'ie een "Beheer"-
  // ingang ziet (artiest-zelfbeheer). god ziet beheer sowieso (op rol).
  let _u = req.session?.user || null;
  // Ververs avatar + rol uit de DB zodat een stale sessie (bv. na een
  // avatar-wijziging of rolwissel) zichzelf herstelt zonder opnieuw inloggen.
  if (_u && _u.id) {
    const _fresh = db.prepare('SELECT avatar_url, role, lang FROM users WHERE id = ?').get(_u.id);
    if (_fresh) _u = { ..._u, avatar_url: _fresh.avatar_url, role: _fresh.role, lang: _fresh.lang };
  }
  const userOwnsSite = !!(_u && _u.role !== 'god' &&
    db.prepare('SELECT 1 FROM sites WHERE owner_id = ? LIMIT 1').get(_u.id));

  // De avatar van de SITE-EIGENAAR (niet de kijker!) — voor de Klonkt-site-kop,
  // zodat de artiest z'n eigen account-foto als sitefoto kan gebruiken.
  const _site = data.site || res.locals.site || null;
  const siteOwnerAvatar = (_site && _site.owner_id)
    ? (db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(_site.owner_id)?.avatar_url || null)
    : null;

  // Kijker-modus: alles bekijken mag, niets wijzigen. Views gebruiken canMutate
  // om schrijf-knoppen (posten, opslaan, verwijderen) te verbergen/uit te zetten.
  const _isViewer = isViewer(_u);

  // Wie ziet de "Beheer"-link? god/admin, een site-eigenaar (artiest-zelfbeheer),
  // én een kijker (mag het Beheer alleen-lezen inzien). Eén bron van waarheid,
  // gespiegeld in topnav/hub-nav/profielsheet — anders raakt de link verborgen
  // voor wie 'm wél mag zien (kijker zag 'm eerst nergens).
  const _role = _u ? _u.role : null;
  const canSeeBeheer = !!(_u && (_role === 'god' || _role === 'admin' || _role === 'kijker' || userOwnsSite));

  // Interface-taal: sessie-keuze (deze sessie) → eigen voorkeur van de ingelogde
  // gebruiker (users.lang) → admin-ingestelde standaard (Beheer) → env → browser → nl.
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
    userOwnsSite,
    canSeeBeheer,
    isViewer: _isViewer,
    canMutate: !_isViewer,
    isPremium: isPremiumInstance(),
    premiumEnabled: premiumEnabled(),
    premiumUnlocked: premiumUnlocked(),
    siteOwnerAvatar,
    site: _site,
    audioTracks: data.audioTracks || res.locals.audioTracks || [],
    siteUrlBase: res.locals.siteUrlBase || '',
    tenancy: res.locals.tenancy || 'solo',
    hubTitle: getSetting('hub_title') || '',
    footerNewsletter: getSetting('footer_newsletter') === '1', // nieuwsbrief-aanmelding in footer (premium)
    agendaEnabled: getSetting('agenda_enabled') === '1', // Agenda/evenementen tonen in de pill (premium, opt-in)
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
      // Per-site accent + palette zitten in de shell-<head> (style#pcms-site-accent
      // + html[data-palette]) en worden NIET mee-geswapt bij htmx-nav. Stuur ze mee
      // zodat de client ze bijwerkt — anders erft een artiest de kleuren van de
      // vorige pagina (bv. hub-paars i.p.v. eigen groen). Zelfde afleiding als shell.ejs.
      const _navAccent = (_site && _site.accent && /^#[0-9a-fA-F]{6}$/.test(_site.accent))
        ? _site.accent : '#c2410c';
      const _navPalette = (_site && _site.palette) ? _site.palette : 'sage';
      const triggerJson = JSON.stringify({
        pcmsNav: { bodyClass: locals.bodyClass, accent: _navAccent, palette: _navPalette },
        pcmsPostSwap: data.post ? {
          title: data.post.title,
          slug: data.post.slug,
          pageTitle: locals.pageTitle,
        } : null,
      }).replace(/[-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
      res.setHeader('HX-Trigger-After-Settle', triggerJson);
      // Site-chrome out-of-band mee-renderen, zodat de kop (topnav/profielkop/
      // view-switcher) bij navigatie ALTIJD bij de nieuwe pagina/artiest hoort —
      // terwijl de audioplayer (los in document.body) blijft leven (geen
      // verspringen). htmx vervangt #pcms-chrome via hx-swap-oob. Niet kritisch:
      // faalt 't, dan blijft de oude chrome staan (geen crash).
      let oobChrome = '';
      try {
        oobChrome = await ejs.renderFile(
          path.join(VIEWS_DIR, 'partials', 'chrome.ejs'),
          { ...locals, oob: true },
          { async: false },
        );
      } catch (e) { /* chrome-OOB overslaan */ }
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
