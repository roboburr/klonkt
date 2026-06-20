/**
 * Audio streaming routes — byte-range streaming.
 *
 * Files live in storage/audio/ and are NOT served by the static /media
 * handler — every fetch goes through this route, which adds byte-range
 * support so HTML5 <audio> can seek.
 *
 * GET /audio/stream/:filename
 *   Streams the file with byte-range support.
 *
 * ANTI-THEFT (Spotify-flavoured, step 1 — 2026-05-20):
 *   The player never exposes this URL to the user — it fetch()es the bytes
 *   and plays from a blob: object URL (no shareable link, no "save audio as").
 *   This route additionally refuses anything that isn't a same-origin browser
 *   fetch, so the raw URL can't be pasted into the address bar, hotlinked from
 *   another site, or pulled with curl/yt-dlp.
 *
 *   A request is allowed when EITHER:
 *     - it carries the X-Audio-Player header (our fetch sets it), OR
 *     - Sec-Fetch-Site is same-origin/same-site (covers the admin <audio>
 *       preview, which can't set custom headers).
 *   Address-bar paste sends Sec-Fetch-Site: none; hotlinks send cross-site;
 *   curl/yt-dlp send neither signal → all rejected.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { recordPlay } from '../services/StatsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Audio files live OUTSIDE storage/media — the public /media static handler
// cannot reach them. Every fetch must go through this gated route.
const AUDIO_DIR = path.resolve(
  process.env.AUDIO_PATH || path.join(__dirname, '..', '..', 'storage', 'audio')
);

const router = express.Router();

// MIME map for the formats v9 supported. Defaults to mpeg.
const MIME = {
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.mp4':  'audio/mp4',
  '.aac':  'audio/aac',
  '.oga':  'audio/ogg',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.webm': 'audio/webm',
};

// Access gate: allow only same-origin browser fetches / media loads.
function isAllowedAudioRequest(req) {
  if (req.get('X-Audio-Player') === '1') return true;  // our blob fetch
  const site = req.get('Sec-Fetch-Site');              // set by modern browsers
  return site === 'same-origin' || site === 'same-site';
}

router.get('/stream/:filename', (req, res) => {
  const { filename } = req.params;

  if (!isAllowedAudioRequest(req)) {
    return res.status(403).send('Direct access not allowed');
  }

  // Sanity: no path traversal, no slashes
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).send('Bad filename');
  }

  const filePath = path.join(AUDIO_DIR, filename);
  // Belt-and-suspenders: confirm the resolved path stays inside AUDIO_DIR
  if (!filePath.startsWith(AUDIO_DIR + path.sep) && filePath !== AUDIO_DIR) {
    return res.status(400).send('Bad path');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return res.status(404).send('Not found');
  }
  if (!stat.isFile()) return res.status(404).send('Not found');

  const ext = path.extname(filename).toLowerCase();
  const mime = MIME[ext] || 'audio/mpeg';
  const total = stat.size;
  const range = req.headers.range;

  // Statistieken: tel één play bij de initiële player-fetch (niet bij scrub/
  // range-continuaties; replays binnen 24u komen uit de browsercache → geen
  // dubbeltelling). Best-effort, mag nooit de stream breken.
  if (req.get('X-Audio-Player') === '1' && (!range || /^bytes=0-/.test(range))) {
    try {
      const tr = db.prepare(`
        SELECT t.id FROM audio_tracks t JOIN media m ON t.media_id = m.id
        WHERE m.storage_path = ? OR m.storage_path LIKE ? LIMIT 1
      `).get(filename, '%' + filename);
      if (tr) recordPlay(tr.id);
    } catch {}
  }

  // Common headers
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  // Allow the browser to cache the file for a day so play/pause/replay
  // doesn't re-fetch the whole stream every time. `private` keeps it out of
  // shared proxies/CDNs (only the user's own browser cache), preserving the
  // signed-URL access model. `immutable` skips the If-Modified-Since
  // round-trip — the URL is content-addressed (signed token tied to file)
  // so its content can't change.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!range) {
    res.setHeader('Content-Length', total);
    return fs.createReadStream(filePath).pipe(res);
  }

  // Parse "bytes=START-END"
  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) {
    res.status(416).setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }
  const start = parseInt(m[1], 10);
  const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  if (start >= total || end < start) {
    res.status(416).setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// Welke post bevat deze track? (voor de mini-speler → "spring naar de post +
// scroll naar de track".) Pakt de nieuwste gepubliceerde post met [[track:<id>]].
router.get('/track/:id/post', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
  const isHub = res.locals.tenancy === 'hub';
  const row = db.prepare(`
    SELECT p.slug, s.slug AS site_slug
    FROM posts p JOIN sites s ON s.id = p.site_id
    WHERE p.status = 'published' AND p.content LIKE ?
    ORDER BY p.published_at DESC LIMIT 1
  `).get('%[[track:' + id + ']]%');
  if (!row) return res.status(404).json({ error: 'not found' });
  const url = isHub ? `/user/${row.site_slug}/${row.slug}` : `/${row.slug}`;
  res.json({ url });
});

// Same-origin proxy voor de YouTube-titel (oEmbed). YouTube's oEmbed stuurt geen
// CORS-header, dus de browser kan 'm niet direct fetchen — wij halen 'm server-
// side op (geen CORS) en cachen 't. Gebruikt door de audio-only YT-embed om de
// echte videotitel te tonen i.p.v. "YouTube".
const ytTitleCache = new Map();
router.get('/yt-title', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https:\/\/(www\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(url)) {
    return res.status(400).json({ error: 'bad url' });
  }
  if (ytTitleCache.has(url)) return res.json({ title: ytTitleCache.get(url) });
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) { ytTitleCache.set(url, ''); return res.json({ title: '' }); }
    const d = await r.json();
    const title = (d && d.title) ? String(d.title).slice(0, 200) : '';
    ytTitleCache.set(url, title);
    res.json({ title });
  } catch (e) {
    res.status(502).json({ error: 'fetch failed' });
  }
});

export default router;
