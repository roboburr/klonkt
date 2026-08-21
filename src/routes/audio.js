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
import AP from '../services/ActivityPubService.js';

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

// Access gate: same-origin browser fetches / media loads — PLUS fediverse-shared tracks.
function isAllowedAudioRequest(req, filename) {
  if (req.get('X-Audio-Player') === '1') return true;  // our blob fetch
  const site = req.get('Sec-Fetch-Site');              // set by modern browsers
  if (site === 'same-origin' || site === 'same-site') return true;
  // fedi_open tracks are deliberately served ungated so remote servers (Mastodon, …) can
  // fetch + play the file inline. The operator opted this specific track in (per-track flag).
  if (filename) {
    try {
      const r = db.prepare(`SELECT 1 FROM audio_tracks t JOIN media m ON t.media_id = m.id
        WHERE t.fedi_open = 1 AND (m.storage_path = ? OR m.storage_path LIKE ?) LIMIT 1`).get(filename, '%' + filename);
      if (r) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * FEP-1580: de instantie waar dit account naartoe verhuisd is mag ALLE audio
 * ophalen, ook wat niet fedi_open is.
 *
 * Zonder deze tak ziet de nieuwe Klonkt de tracklijst wel en krijgt hij de
 * bestanden niet, en dan verhuis je een bibliotheek met alleen titels. Dat is
 * precies de halve waarheid die deze hele ronde moest opruimen.
 *
 * Smal gehouden: een geldige handtekening, van precies de actor in moved_to, en
 * alleen voor een bestand dat van DIE site is. moved_to komt er alleen te staan
 * als de doel-actor ons in alsoKnownAs had, dus er heeft iemand met beheer aan
 * beide kanten ja gezegd.
 */
async function isMoveTargetAudio(req, filename) {
  if (!req.headers['signature'] || !filename) return false;
  let rij;
  try {
    rij = db.prepare(`SELECT s.slug FROM audio_tracks t
                        JOIN media m ON t.media_id = m.id
                        JOIN sites s ON s.id = t.site_id
                       WHERE m.storage_path = ? OR m.storage_path LIKE ? LIMIT 1`)
      .get(filename, `%${filename}`);
  } catch { return false; }
  if (!rij || !rij.slug) return false;
  const v = await AP.verifyRequest(req).catch(() => null);
  return !!(v && v.id && AP.isMoveTarget(rij.slug, v.id));
}

router.get('/stream/:filename', async (req, res) => {
  const { filename } = req.params;

  if (!isAllowedAudioRequest(req, filename) && !(await isMoveTargetAudio(req, filename))) {
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

  // Statistics: count one play on the initial player fetch (not on scrub/
  // range continuations; replays within 24h come from the browser cache → no
  // double counting). Best-effort, must never break the stream.
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
  // Same lesson /media already learned: Helmet's default CORP is same-origin,
  // and the browser then refuses to hand a cross-origin <audio> the bytes —
  // the file arrives, the player stays silent. These URLs are precisely what
  // we advertise in federated Audio objects (Funkwhale, the hub) to be played
  // elsewhere; WHO may fetch is decided by the gate above, not by CORP.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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

// Which post contains this track? (for the mini-player → "jump to the post +
// scroll to the track".) Fetches the newest published post with [[track:<id>]].
router.get('/track/:id/post', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
  const row = db.prepare(`
    SELECT p.slug, s.slug AS site_slug
    FROM posts p JOIN sites s ON s.id = p.site_id
    WHERE p.status = 'published' AND p.content LIKE ?
    ORDER BY p.published_at DESC LIMIT 1
  `).get('%[[track:' + id + ']]%');
  if (!row) return res.status(404).json({ error: 'not found' });
  const url = `/${row.slug}`;
  res.json({ url });
});

export default router;
