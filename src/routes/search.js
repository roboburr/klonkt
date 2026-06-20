/**
 * GET /search?q=...
 *
 * Doorzoekt de huidige site op twee dingen:
 *   1. Posts via de posts_fts virtuele tabel (FTS5) — published only.
 *   2. Nummers (audio_tracks) op titel / artiest / album.
 *
 * Verbeteringen t.o.v. de oude versie:
 *   - Prefix-matching: elk woord wordt als prefix-term gezocht ("astr"* vindt
 *     "astra"), met AND tussen de woorden — typen-terwijl-je-zoekt werkt nu.
 *   - Nummers zijn doorzoekbaar en direct afspeelbaar in de resultatenlijst,
 *     met een link naar de post/album/playlist waarin het nummer voorkomt.
 *
 * FTS5-randgevallen:
 *   - Lege / whitespace-only query: form zonder resultaten.
 *   - User-input wordt getokeniseerd op niet-letter/cijfer en elk token tussen
 *     dubbele quotes + `*` gezet → geen operator-soup, geen syntax-errors.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { audioUrl } from '../services/AudioStreamService.js';

const router = express.Router();

// Bouw een veilige FTS5-prefix-query: tokeniseer op alles wat geen letter/cijfer
// is, en maak van elk token een prefix-term. Spatie = impliciete AND.
// Bv. 'rock astr' -> '"rock"* "astr"*'. Geeft null als er geen bruikbaar token is.
function buildFtsQuery(q) {
  const terms = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => '"' + t + '"*').join(' ');
}

// Escape LIKE-wildcards in user-input zodat % en _ letterlijk matchen.
function likeArg(q) {
  return '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
}

router.get('/', (req, res) => {
  const site = res.locals.site;
  const rawQ = (req.query.q || '').toString().trim();
  const isHub = res.locals.tenancy === 'hub';
  const urlFor = (slug) => (isHub ? `/user/${site.slug}/${slug}` : `/${slug}`);

  if (!site) return res.status(404).send('No site');

  // Lege query — toon het formulier zonder resultaten.
  if (!rawQ) {
    return renderPage(req, res, 'pages/search', {
      pageTitle: 'Zoeken',
      bodyClass: 'on-special',
      query: '',
      results: [],
      tracks: [],
      total: 0,
    });
  }

  let results = [];
  let tracks = [];
  let queryError = null;

  // ── Posts (FTS5, prefix) ───────────────────────────────────────────
  const ftsQuery = buildFtsQuery(rawQ);
  if (ftsQuery) {
    try {
      results = db.prepare(`
        SELECT
          p.slug,
          p.title,
          p.excerpt,
          p.published_at,
          u.username AS author_username,
          snippet(posts_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
          bm25(posts_fts) AS score
        FROM posts_fts
        JOIN posts p ON p.id = posts_fts.post_id
        JOIN users u ON u.id = p.author_id
        WHERE posts_fts MATCH ?
          AND p.site_id = ?
          AND p.status = 'published'
        ORDER BY score ASC
        LIMIT 50
      `).all(ftsQuery, site.id);
    } catch (err) {
      queryError = err.message;
    }
  }

  // ── Nummers (audio_tracks: titel / artiest / album) ────────────────
  try {
    const like = likeArg(rawQ);
    const trackRows = db.prepare(`
      SELECT t.id, t.title, t.artist, t.album, t.cover_url, t.play_count, m.filename
      FROM audio_tracks t
      LEFT JOIN media m ON m.id = t.media_id
      WHERE t.site_id = @site
        AND ( t.title  LIKE @like ESCAPE '\\'
           OR t.artist LIKE @like ESCAPE '\\'
           OR t.album  LIKE @like ESCAPE '\\' )
      ORDER BY t.play_count DESC, t.title ASC
      LIMIT 25
    `).all({ site: site.id, like });

    // Eén keer alle published posts van de site ophalen om per nummer de
    // post/album/playlist-pagina te vinden waarin 'ie voorkomt (in-memory match).
    const playable = trackRows.filter((t) => t.filename);
    let posts = [];
    if (playable.length) {
      posts = db.prepare(`
        SELECT slug, content FROM posts
        WHERE site_id = ? AND status = 'published'
        ORDER BY published_at DESC
      `).all(site.id);
    }
    const postUrlForTrack = (t) => {
      let hit = posts.find((p) => p.content && p.content.includes('[[track:' + t.id + ']]'));
      if (!hit && t.album) {
        hit = posts.find((p) => p.content && p.content.includes('[[album:' + t.album + ']]'));
      }
      if (!hit) {
        const plids = db.prepare('SELECT playlist_id FROM playlist_tracks WHERE track_id = ?')
          .all(t.id).map((r) => r.playlist_id);
        if (plids.length) {
          hit = posts.find((p) => p.content && plids.some((pl) => p.content.includes('[[playlist:' + pl + ']]')));
        }
      }
      return hit ? urlFor(hit.slug) : null;
    };

    tracks = playable.map((t) => ({
      id: t.id,
      title: t.title || 'Untitled',
      artist: t.artist || '',
      album: t.album || '',
      cover: t.cover_url || '',
      url: audioUrl(t.filename),
      postUrl: postUrlForTrack(t),
    }));
  } catch (err) {
    if (!queryError) queryError = err.message;
  }

  const total = results.length + tracks.length;

  renderPage(req, res, 'pages/search', {
    pageTitle: `Zoeken: ${rawQ}`,
    bodyClass: 'on-special',
    query: rawQ,
    results,
    tracks,
    total,
    queryError,
  });
});

export default router;
