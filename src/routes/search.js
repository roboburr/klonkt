/**
 * GET /search?q=...          -> volledige resultatenpagina
 * GET /search/suggest?q=...  -> compacte JSON voor live resultaten in de overlay
 *
 * Doorzoekt de huidige site op:
 *   1. Posts via posts_fts (FTS5, prefix-matching) — published only.
 *   2. Nummers (audio_tracks) op titel / artiest / album.
 *   3. Evenementen (shows) op plaats / locatie / land / notitie — als de agenda aan staat.
 *   4. Pagina's (Agenda / Downloads / Links / Perskit / Archief) op naam — alleen
 *      de beschikbare.
 *
 * FTS5: user-input wordt getokeniseerd op niet-letter/cijfer en elk token tussen
 * dubbele quotes + `*` gezet → prefix-match, geen operator-soup/syntax-errors.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { audioUrl } from '../services/AudioStreamService.js';
import { getSetting } from '../services/SettingsService.js';
import { premiumUnlocked } from '../services/PatreonService.js';

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

// ── De kern: alle bronnen doorzoeken voor één site. `lim` begrenst per groep
//    (klein voor de live-suggesties, ruim voor de volle pagina). ──────────────
function searchSite(req, res, rawQ, lim) {
  const site = res.locals.site;
  const isHub = res.locals.tenancy === 'hub';
  const base = res.locals.siteUrlBase || '';
  const urlFor = (slug) => (isHub ? `/user/${site.slug}/${slug}` : `/${slug}`);
  const t = res.locals.t || ((k) => k);

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

  // 2. Nummers
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

  // 3. Evenementen (agenda) — alleen als de agenda publiek aan staat.
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

  // 4. Pagina's — curated, alleen de beschikbare; match op de (vertaalde) naam.
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

// ── Volledige resultatenpagina ───────────────────────────────────────────────
router.get('/', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');
  const rawQ = (req.query.q || '').toString().trim();

  if (!rawQ) {
    return renderPage(req, res, 'pages/search', {
      pageTitle: 'Zoeken', bodyClass: 'on-special', query: '',
      results: [], tracks: [], events: [], pages: [], total: 0,
    });
  }

  const r = searchSite(req, res, rawQ, { posts: 50, tracks: 25, events: 25, pages: 8 });
  const total = r.results.length + r.tracks.length + r.events.length + r.pages.length;
  renderPage(req, res, 'pages/search', {
    pageTitle: `Zoeken: ${rawQ}`, bodyClass: 'on-special', query: rawQ,
    results: r.results, tracks: r.tracks, events: r.events, pages: r.pages,
    total, queryError: r.queryError,
  });
});

// ── Live suggesties (JSON) ───────────────────────────────────────────────────
router.get('/suggest', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.json({ posts: [], tracks: [], events: [], pages: [] });
  const rawQ = (req.query.q || '').toString().trim().slice(0, 100);
  if (rawQ.length < 2) return res.json({ posts: [], tracks: [], events: [], pages: [] });

  const isHub = res.locals.tenancy === 'hub';
  const urlFor = (slug) => (isHub ? `/user/${site.slug}/${slug}` : `/${slug}`);
  const r = searchSite(req, res, rawQ, { posts: 5, tracks: 4, events: 3, pages: 4 });
  res.json({
    posts: r.results.map((p) => ({ title: p.title || '(zonder titel)', url: urlFor(p.slug) })),
    tracks: r.tracks.map((tr) => ({ title: tr.title, artist: tr.artist, url: tr.postUrl })),
    events: r.events.map((e) => ({ when: [e.date, e.time].filter(Boolean).join(' '), where: e.where, url: e.url })),
    pages: r.pages,
  });
});

export default router;
