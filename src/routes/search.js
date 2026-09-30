/**
 * GET /search?q=...          -> full results page
 * GET /search/suggest?q=...  -> compact JSON for live results in the overlay
 *
 * Searches the current site across:
 *   1. Posts via posts_fts (FTS5, prefix-matching) — published only.
 *   2. Tracks (audio_tracks) on title / artist / album.
 *   3. Events (shows) on city / venue / country / notes — when the agenda is enabled.
 *   4. Pages (Agenda / Downloads / Links / Press kit / Archive) by name — only
 *      the available ones.
 *   5. Een ADRES van een andere server (shaer-utpi): plak je een link naar een
 *      fediverse-post of -profiel, dan is dat geen zoekterm maar een aanwijzing.
 *      Die halen we op en tonen we, met dezelfde knoppen als
 *      /authorize_interaction: antwoorden, waarderen, boosten, stemmen,
 *      volgen, melden.
 *
 * FTS5: user input is tokenised on non-letter/digit chars and each token is wrapped
 * in double quotes + `*` → prefix-match, no operator-soup/syntax-errors.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage, formatDate } from '../middleware/render.js';
import { audioUrl } from '../services/AudioStreamService.js';
import { getSetting } from '../services/SettingsService.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { t as i18nT, resolveLang } from '../services/i18n.js';
import ActivityPubService from '../services/ActivityPubService.js';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import PermissionsService from '../services/PermissionsService.js';

const router = express.Router();

function buildFtsQuery(q) {
  const terms = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => '"' + t + '"*').join(' ');
}

function likeArg(q) {
  return '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
}

function cleanSnippet(html, excerpt) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const s = (html || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[[^\]]*?\]\]/g, ' ')
    .replace(/\[\[|\]\]/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^[…\s]*$/.test(s)) return esc((excerpt || '').slice(0, 160));
  return s;
}

/**
 * Is dit een ADRES en geen zoekterm? Dan het genormaliseerde adres, anders null.
 *
 * HET SCHEMA IS VERPLICHT, en dat is een keuze. "soundfabrics.nl" is een
 * geldige zoekterm -- iemand zoekt naar de naam -- en een bare domeinnaam als
 * adres opvatten maakt van elke zoekopdracht met een punt erin een
 * netwerkverzoek. Met https:// ervoor is er geen twijfel over de bedoeling.
 *
 * De fragmentverwijzing gaat eraf: die hoort bij de browser, niet bij het
 * object, en met #comment eraan is het een andere sleutel voor hetzelfde ding.
 */
export function lookupUri(q) {
  const s = String(q || '').trim();
  if (!/^https?:\/\//i.test(s) || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Een naam zonder punt is geen adres op het open net (localhost, een
    // intern hostname). De SSRF-bewaking in de transportlaag houdt de rest
    // tegen; dit scheelt het verzoek.
    if (!u.hostname.includes('.')) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Is dit een HANDLE (@naam@server) en geen zoekterm? Dan de genormaliseerde
 * handle, anders null.
 *
 * Met of zonder @ vooraan, zoals Mastodon het ook aanneemt. De server moet een
 * echte domeinnaam zijn (met een punt en een extensie): "@robin" is een naam om
 * naar te zoeken, geen adres. Een spatie maakt er een zoekopdracht van.
 *
 * WebFinger zelf is openbaar en gaat niet ondertekend; het profiel erachter
 * wel, via resolveRemoteActor, en alleen namens een ingelogde beheerder.
 */
export function lookupHandle(q) {
  const m = /^@?([a-z0-9_.-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})$/i.exec(String(q || '').trim());
  return m ? `@${m[1]}@${m[2].toLowerCase()}` : null;
}

/**
 * Mag deze bezoeker een adres laten OPHALEN?
 *
 * Dezelfde grens als /authorize_interaction (requireSiteManager), en met opzet:
 * ophalen is een uitgaand verzoek dat deze server namens iemand anders doet.
 * Voor een willekeurige bezoeker zou de zoekbalk daarmee een haalservice zijn
 * waarmee je andermans server kunt laten aankloppen op adressen naar keuze.
 *
 * Dit spiegelt requireSiteManager in plaats van hem aan te roepen: die stuurt
 * je naar het inlogscherm, en een zoekopdracht hoort niemand weg te sturen.
 */
function mayLookUp(req, res) {
  const u = req.session && req.session.user;
  if (!u) return false;
  if (u.role === 'god' || u.role === 'kijker') return true;
  const site = res.locals.site;
  return !!(site && PermissionsService.canAdminSite(u, site));
}

/**
 * Haal het object achter een adres op: eerst als post, dan als profiel.
 *
 * Eén weg voor de zoekpagina en de live-preview. Staan ze los, dan verschilt er
 * vroeg of laat iets -- de ondertekening bijvoorbeeld, en dan toont de preview
 * een post als ontbrekend die de pagina wel vindt.
 *
 * ONDERTEKEND als de site: een post die alleen voor volgers zichtbaar is weigert
 * een anonieme GET, en dan lijkt een bestaande post te ontbreken.
 */
async function lookUpRemote(remoteUri, site, { handle = false } = {}) {
  let remote = null;
  let remoteKind = null;
  // Een handle wijst altijd naar een persoon: geen post-poging, die zou alleen
  // een verzoek kosten dat niets kan opleveren.
  if (!handle) {
    try { remote = await ActivityPubService.resolveRemoteNote(remoteUri, { asSlug: site.slug }); } catch { /* onbereikbaar */ }
  }
  if (remote) remoteKind = 'note';
  if (!remote) {
    // Ook ondertekend: een profiel op een instance met authorized fetch
    // (mastodon.social) geeft anders een 401 en leek dan niet te bestaan.
    try { remote = await ActivityPubService.resolveRemoteActor(remoteUri, { asSlug: site.slug }); } catch { /* onbereikbaar */ }
    if (remote) remoteKind = 'actor';
  }
  const reacted = remoteKind === 'note'
    ? ActivityPubService.getReaction(site.slug, remote.object_uri || remoteUri)
    : { liked: false, boosted: false };
  return { remote, remoteKind, reacted };
}

// ── Core: search all sources for one site. `lim` caps results per group
//    (small for live suggestions, large for the full page). ──────────────────
function searchSite(req, res, rawQ, lim) {
  const site = res.locals.site;
  const base = res.locals.siteUrlBase || '';
  const urlFor = (slug) => `/${slug}`;
  // Eigen vertaler (werkt ook in de JSON-route, waar res.locals.t niet bestaat).
  const lang = resolveLang(req);
  const t = (k) => i18nT(lang, k);

  const out = { results: [], tracks: [], events: [], pages: [], queryError: null };
  if (!site || !rawQ) return out;
  const like = likeArg(rawQ);

  // 1. Posts (FTS5)
  const ftsQuery = buildFtsQuery(rawQ);
  if (ftsQuery) {
    try {
      out.results = db.prepare(`
        SELECT p.slug, p.title, p.excerpt, p.published_at, u.username AS author_username,
               snippet(posts_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet, bm25(posts_fts) AS score
        FROM posts_fts
        JOIN posts p ON p.id = posts_fts.post_id
        JOIN users u ON u.id = p.author_id
        WHERE posts_fts MATCH ? AND p.site_id = ? AND p.status = 'published'
        ORDER BY score ASC LIMIT ?
      `).all(ftsQuery, site.id, lim.posts);
      out.results = out.results.map((r) => ({ ...r, snippet: cleanSnippet(r.snippet, r.excerpt) }));
    } catch (err) { out.queryError = err.message; }
  }

  // 2. Tracks
  try {
    const trackRows = db.prepare(`
      SELECT t.id, t.title, t.artist, t.album, t.cover_url, t.play_count, m.filename
      FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
      WHERE t.site_id = @site
        AND ( t.title LIKE @like ESCAPE '\\' OR t.artist LIKE @like ESCAPE '\\' OR t.album LIKE @like ESCAPE '\\' )
      ORDER BY t.play_count DESC, t.title ASC LIMIT @lim
    `).all({ site: site.id, like, lim: lim.tracks });
    const playable = trackRows.filter((t) => t.filename);
    let posts = [];
    if (playable.length) {
      posts = db.prepare("SELECT slug, content FROM posts WHERE site_id = ? AND status = 'published' ORDER BY published_at DESC").all(site.id);
    }
    const postUrlForTrack = (tr) => {
      let hit = posts.find((p) => p.content && p.content.includes('[[track:' + tr.id + ']]'));
      if (!hit && tr.album) hit = posts.find((p) => p.content && p.content.includes('[[album:' + tr.album + ']]'));
      if (!hit) {
        const plids = db.prepare('SELECT playlist_id FROM playlist_tracks WHERE track_id = ?').all(tr.id).map((r) => r.playlist_id);
        if (plids.length) hit = posts.find((p) => p.content && plids.some((pl) => p.content.includes('[[playlist:' + pl + ']]')));
      }
      return hit ? urlFor(hit.slug) : null;
    };
    out.tracks = playable.map((tr) => ({
      id: tr.id, title: tr.title || 'Untitled', artist: tr.artist || '', album: tr.album || '',
      cover: tr.cover_url || '', url: audioUrl(tr.filename), postUrl: postUrlForTrack(tr),
    }));
  } catch (err) { if (!out.queryError) out.queryError = err.message; }

  // 3. Events (agenda) — only when the agenda is publicly enabled.
  if (premiumUnlocked() && getSetting('agenda_enabled') === '1') {
    try {
      out.events = db.prepare(`
        SELECT date, time, city, venue, country FROM shows
        WHERE site_id = @site
          AND ( city LIKE @like ESCAPE '\\' OR venue LIKE @like ESCAPE '\\'
             OR country LIKE @like ESCAPE '\\' OR notes LIKE @like ESCAPE '\\' OR date LIKE @like ESCAPE '\\' )
        ORDER BY date ASC LIMIT @lim
      `).all({ site: site.id, like, lim: lim.events }).map((e) => ({
        date: e.date, time: e.time || '',
        where: [e.venue, e.city, e.country].filter(Boolean).join(', '),
        url: base + '/shows',
      }));
    } catch (err) { if (!out.queryError) out.queryError = err.message; }
  }

  // 4. Pages — curated, available ones only; matched against the (translated) name.
  const ql = rawQ.toLowerCase();
  const candidates = [
    { key: 'search.page_agenda', url: base + '/shows', on: premiumUnlocked() && getSetting('agenda_enabled') === '1' },
    { key: 'search.page_downloads', url: base + '/downloads', on: premiumUnlocked() },
    { key: 'search.page_links', url: base + '/links', on: premiumUnlocked() },
    { key: 'search.page_perskit', url: base + '/pers', on: premiumUnlocked() },
    { key: 'search.page_archive', url: urlFor('archive'), on: !site || site.show_archive_link === undefined || site.show_archive_link },
  ];
  out.pages = candidates
    .filter((c) => c.on)
    .map((c) => ({ label: t(c.key), url: c.url }))
    .filter((c) => c.label.toLowerCase().includes(ql))
    .slice(0, lim.pages);

  return out;
}

// ── Wat er bij een zoekopdracht hoort ────────────────────────────────────────
//
// EEN verzameling voor beide ingangen: de pagina /search?q=... en het live vak
// onder de zoekbalk (/search/results). Ze tonen sinds Robins ontwerp van 30-9
// hetzelfde, dus ze horen ook hetzelfde op te halen.
//
// Een adres wordt OPGEHAALD, niet doorzocht (shaer-utpi). Eerst als post, dan
// als profiel; ondertekend, en alleen namens een ingelogde beheerder.
async function gather(req, res, rawQ) {
  const site = res.locals.site;
  // Een adres (https://...) of een handle (@naam@server): allebei iets dat van
  // een andere server moet komen, dus allebei achter dezelfde rechtengrens.
  const uri = lookupUri(rawQ);
  const handle = uri ? null : lookupHandle(rawQ);
  const remoteUri = uri || handle;
  const mayLookup = remoteUri ? mayLookUp(req, res) : false;
  const { remote, remoteKind, reacted: remoteReacted } = (remoteUri && mayLookup)
    ? await lookUpRemote(remoteUri, site, { handle: !!handle })
    : { remote: null, remoteKind: null, reacted: { liked: false, boosted: false } };
  const r = searchSite(req, res, rawQ, { posts: 50, tracks: 25, events: 25, pages: 8 });
  return {
    query: rawQ,
    results: r.results, tracks: r.tracks, events: r.events, pages: r.pages,
    total: r.results.length + r.tracks.length + r.events.length + r.pages.length,
    queryError: r.queryError,
    remoteUri, remote, remoteKind, mayLookup, remoteReacted,
    siteTitle: site.title || '',
  };
}

// ── De pagina: het zoekvlak, open, met de resultaten erin ────────────────────
router.get('/', async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');
  const rawQ = (req.query.q || '').toString().trim().slice(0, 2048);
  const data = rawQ ? await gather(req, res, rawQ) : { query: '' };
  renderPage(req, res, 'pages/search', {
    pageTitle: rawQ ? `Zoeken: ${rawQ}` : 'Zoeken', bodyClass: 'on-special',
    ...data,
  });
});

// ── Het live vak onder de zoekbalk (HTML-fragment) ───────────────────────────
//
// Dezelfde render als de pagina (partials/search-results.ejs), zodat het vak
// en de pagina er per constructie hetzelfde uitzien. Dit verving twee routes:
// /suggest (JSON, dat de browser zelf tot een lijstje bouwde, anders dan de
// pagina) en /remote (alleen het adres).
//
// De rechtengrens voor het ophalen zit in gather en is dezelfde als voor de
// pagina; hier weegt hij zwaarder, want dit wordt bij elke toetsaanslag
// geraakt. Een bezoeker die een link plakt krijgt de gewone resultaten en de
// zin waarom er verder niets staat, en er gaat geen verzoek uit.
const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');

router.get('/results', async (req, res) => {
  const site = res.locals.site;
  const rawQ = String(req.query.q || '').trim().slice(0, 2048);
  if (!site || rawQ.length < 2) return res.status(204).end();
  const data = await gather(req, res, rawQ);
  // Dezelfde taal als de pagina eromheen, anders staat er een Engelse lijst
  // in een Nederlandse zoekbalk.
  const lang = resolveLang(req, { userLang: req.session?.user?.lang, defaultLang: getSetting('default_lang') });
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'search-results.ejs'), {
    ...data,
    t: (k, vars) => i18nT(lang, k, vars),
    formatDate,
    siteUrlBase: res.locals.siteUrlBase || '',
  }, { async: false });
  // Wat deze bezoeker ziet hangt van zijn rechten en zijn reacties af: niet
  // bewaren, niet delen.
  res.set('Cache-Control', 'private, no-store');
  res.type('html').send(html);
});

export default router;
