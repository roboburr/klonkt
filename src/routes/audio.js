/**
 * Audio streaming routes — v9-style signed URL + byte-range support.
 *
 * Files live in storage/media/audio/ and are NOT served by the static
 * /media handler — every fetch must go through this verified route.
 *
 * GET /audio/stream/:filename?t=<hmac>&exp=<unix>
 *   Verifies the token. If valid, streams the file with byte-range support
 *   so HTML5 <audio> can seek. Anything invalid returns 403.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyToken } from '../services/AudioStreamService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Audio files live OUTSIDE storage/media — the public /media static handler
// cannot reach them. Every fetch must go through this signed route.
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

router.get('/stream/:filename', (req, res) => {
  const { filename } = req.params;
  const { t, exp } = req.query;

  // Sanity: no path traversal, no slashes
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).send('Bad filename');
  }

  if (!verifyToken(filename, t, exp)) {
    return res.status(403).send('Invalid or expired token');
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

export default router;
