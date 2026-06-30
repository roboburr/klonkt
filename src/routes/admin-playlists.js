/**
 * Admin: Playlists management — first-class playlist entity (v9 feature).
 *
 *   GET  /admin/playlists            -> list page (server-rendered)
 *   GET  /admin/playlists/api/list   -> JSON list  (used by post-editor picker)
 *   GET  /admin/playlists/api/tracks -> JSON list of all audio tracks for picker
 *   GET  /admin/playlists/api/:id    -> JSON get
 *   POST /admin/playlists/api        -> create (id assigned, returned in body)
 *   POST /admin/playlists/api/:id    -> update
 *   POST /admin/playlists/api/:id/delete -> delete
 *
 * All endpoints require god/admin role. CSRF enforced for write ops via the
 * shared csrf middleware mounted in server.js.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { randomUUID } from 'crypto';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import PlaylistService from '../services/PlaylistService.js';

// Cover storage — same convention as track covers so a single physical
// directory holds all album/track artwork. Existing covers in the DB
// already point at /media/audio-covers/<filename> so we reuse the path.
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const COVER_DIR = path.resolve(
  process.env.COVER_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'audio-covers')
);
fs.mkdirSync(COVER_DIR, { recursive: true });

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const COVER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const coverUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, COVER_DIR),
    filename: (req, file, cb) => {
      // <uuid>.<ext> — keep extension so MIME detection works downstream
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_COVER_BYTES },
  fileFilter: (req, file, cb) => {
    if (!COVER_MIMES.has(file.mimetype)) {
      return cb(new Error('Alleen JPEG/PNG/WebP/GIF toegestaan'));
    }
    cb(null, true);
  },
});

const router = express.Router();

// ─── Page render ──────────────────────────────────────────────────────

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const playlists = PlaylistService.list(site.id);
  renderPage(req, res, 'pages/admin-playlists', {
    pageTitleKey: 'admin.t_playlists',
    playlists,
    bodyClass: 'on-admin',
  });
});

// ─── JSON API ─────────────────────────────────────────────────────────

router.get('/api/list', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  res.json({ ok: true, playlists: PlaylistService.list(site.id) });
});

/**
 * List all audio tracks for picker. Includes a flag whether each track has
 * a media file (only those are pickable).
 */
router.get('/api/tracks', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  const tracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.duration, t.cover_url,
           t.link_spotify, t.link_youtube, t.link_soundcloud, m.filename
    FROM audio_tracks t
    LEFT JOIN media m ON m.id = t.media_id
    WHERE t.site_id = ?
    ORDER BY t.created_at DESC
  `).all(site.id);

  res.json({
    ok: true,
    tracks: tracks.map(t => ({
      id: t.id,
      title: t.title || 'Untitled',
      artist: t.artist || '',
      duration: t.duration || 0,
      cover: t.cover_url || '',
      // Insertable if it has a hosted file OR an external link — a link-only track ([[track:]])
      // still renders its Spotify/YouTube card on the post, so it must not be disabled in the picker.
      playable: !!t.filename || !!(t.link_spotify || t.link_youtube || t.link_soundcloud),
    })),
  });
});

router.get('/api/:id', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  // Editor needs the raw track-id list (not stream URLs) — pass no urlFor.
  const playlist = PlaylistService.get(site.id, req.params.id, null);
  if (!playlist) return res.status(404).json({ error: 'Playlist niet gevonden' });
  // Ship just the track ids in order so the editor can populate selection.
  const trackIds = db.prepare(`
    SELECT track_id FROM playlist_tracks
    WHERE playlist_id = ? ORDER BY position ASC
  `).all(playlist.id).map(r => r.track_id);
  res.json({ ok: true, playlist: { ...playlist, track_ids: trackIds } });
});

router.post('/api', requireGod, express.json(), (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  const id = PlaylistService.create(site.id, req.body || {});
  if (!id) return res.status(400).json({ error: 'Aanmaken mislukt (titel verplicht)' });
  res.json({ ok: true, id });
});

router.post('/api/:id', requireGod, express.json(), (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  const ok = PlaylistService.update(site.id, req.params.id, req.body || {});
  if (!ok) return res.status(400).json({ error: 'Bijwerken mislukt' });
  res.json({ ok: true });
});

router.post('/api/:id/delete', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  const ok = PlaylistService.delete(site.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Playlist niet gevonden' });
  res.json({ ok: true });
});

/**
 * POST /admin/playlists/api/:id/cover — upload a new cover image and set
 * it on the playlist in one request. Returns { ok, url, cover_url } for
 * the editor modal to preview. Mirrors the track-cover endpoint pattern.
 */
router.post('/api/:id/cover', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  // Confirm ownership (and grab the previous cover for cleanup)
  const existing = db.prepare(
    'SELECT id, cover_url FROM playlists WHERE id = ? AND site_id = ?'
  ).get(req.params.id, site.id);
  if (!existing) return res.status(404).json({ error: 'Playlist niet gevonden' });

  coverUpload.single('cover')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Geen bestand' });

    const newUrl = `/media/audio-covers/${file.filename}`;
    try {
      db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ? AND site_id = ?')
        .run(newUrl, req.params.id, site.id);
    } catch (dbErr) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(500).json({ error: dbErr.message });
    }

    // Garbage-collect the previous cover if it was in our managed dir
    if (existing.cover_url && existing.cover_url.startsWith('/media/audio-covers/')) {
      const oldName = existing.cover_url.replace(/^\/media\/audio-covers\//, '');
      try { fs.unlinkSync(path.join(COVER_DIR, oldName)); } catch {}
    }

    res.json({ ok: true, url: newUrl, cover_url: newUrl });
  });
});

export default router;
