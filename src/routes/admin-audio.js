/**
 * Admin: Audio Tracks management — Phase C MP3 player.
 *
 * GET  /admin/audio              -> list site tracks + upload form
 * POST /admin/audio/upload       -> multer upload, insert media + audio_tracks
 * POST /admin/audio/:id/delete   -> remove track row + file on disk
 *
 * Files land in storage/media/audio/ (NOT served by /media static handler —
 * everything goes through the signed /audio/stream/ route).
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { transcodeToMp3 } from '../services/AudioTranscoder.js';
import { audioUrl } from '../services/AudioStreamService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Audio files live OUTSIDE storage/media so the public /media static
// handler can't serve them — they must go through the signed /audio/stream/
// endpoint (anti-hotlink). Covers are public and stay in /media.
const AUDIO_DIR = path.resolve(
  process.env.AUDIO_PATH || path.join(__dirname, '..', '..', 'storage', 'audio')
);
const COVER_DIR = path.resolve(
  process.env.COVER_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'audio-covers')
);
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(COVER_DIR, { recursive: true });

const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.oga', '.ogg', '.opus', '.flac', '.wav', '.webm']);
const ALLOWED_COVER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;   // 50 MB — gecomprimeerde formaten (mp3/m4a/ogg/…)
const MAX_WAV_BYTES   = 100 * 1024 * 1024;  // 100 MB — WAV is ongecomprimeerd, dus ruimer
const MAX_COVER_BYTES = 5 * 1024 * 1024;    // 5 MB

// Per-bestand bovengrens op basis van extensie. multer's globale limiet is de
// hoogste (WAV); de echte controle per type gebeurt in de upload-handler.
const audioByteLimitFor = (ext) => (ext.toLowerCase() === '.wav' ? MAX_WAV_BYTES : MAX_AUDIO_BYTES);

// Multer routes audio + cover into separate dirs based on field name.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'cover' ? COVER_DIR : AUDIO_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_WAV_BYTES }, // hoogste bovengrens (WAV) — per-type check in de handler
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'cover') {
      if (!ALLOWED_COVER_EXT.has(ext)) return cb(new Error('Cover must be jpg/png/webp/gif'));
    } else {
      if (!ALLOWED_AUDIO_EXT.has(ext)) return cb(new Error('Unsupported audio type: ' + ext));
    }
    cb(null, true);
  },
});

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const rows = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration, t.cover_url,
           t.position, t.created_at, m.filename, m.size, m.mime_type
    FROM audio_tracks t
    LEFT JOIN media m ON m.id = t.media_id
    WHERE t.site_id = ?
    ORDER BY t.position ASC, t.created_at ASC
  `).all(site.id);

  // Build each track's stream URL so admins can preview audio inline.
  const tracks = rows.map(t => ({
    ...t,
    stream_url: t.filename ? audioUrl(t.filename) : null,
  }));

  renderPage(req, res, 'pages/admin-audio', {
    pageTitle: 'Audio tracks',
    bodyClass: 'on-admin',
    tracks,
    error: req.query.error || null,
    success: req.query.success || null,
    maxBytesMb: Math.round(MAX_AUDIO_BYTES / 1024 / 1024),
    maxWavMb: Math.round(MAX_WAV_BYTES / 1024 / 1024),
  });
});

router.post('/upload', requireGod, (req, res) => {
  // Helper: respond appropriately to JSON-accepting callers (the bulk
  // uploader fetch() calls) vs traditional form posts (redirect).
  // Both code paths cover identical errors below.
  const wantsJson = req.get('Accept')?.includes('application/json') || req.xhr;
  const fail = (status, message) => wantsJson
    ? res.status(status).json({ ok: false, error: message })
    : res.redirect('/admin/audio?error=' + encodeURIComponent(message));
  const ok = (data) => wantsJson
    ? res.json({ ok: true, ...data })
    : res.redirect('/admin/audio?success=' + encodeURIComponent('Uploaded: ' + data.title));

  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, async (err) => {
    if (err) return fail(400, err.message);

    const site = res.locals.site;
    const audioFile = req.files?.audio?.[0];
    const coverFile = req.files?.cover?.[0];

    if (!site || !audioFile) {
      // Clean up any cover that snuck through without an audio file
      if (coverFile) try { fs.unlinkSync(coverFile.path); } catch {}
      return fail(400, 'missing audio file');
    }

    // Per-type audio size check. multer's globale limiet was de WAV-bovengrens
    // (100MB); gecomprimeerde formaten blijven op 50MB.
    const audioExt = path.extname(audioFile.originalname).toLowerCase();
    const audioLimit = audioByteLimitFor(audioExt);
    if (audioFile.size > audioLimit) {
      try { fs.unlinkSync(audioFile.path); } catch {}
      if (coverFile) try { fs.unlinkSync(coverFile.path); } catch {}
      return fail(400, `audio te groot (max ${Math.round(audioLimit / 1024 / 1024)}MB voor ${audioExt || 'dit type'})`);
    }

    // Cover size check (multer's global limit was the audio upper bound)
    if (coverFile && coverFile.size > MAX_COVER_BYTES) {
      try { fs.unlinkSync(audioFile.path); } catch {}
      try { fs.unlinkSync(coverFile.path); } catch {}
      return fail(400, 'cover too large (max 5MB)');
    }

    const { title, artist, album } = req.body;
    const trackId = uuid();
    const mediaId = uuid();
    const coverUrl = coverFile ? `/media/audio-covers/${coverFile.filename}` : null;

    // ── TRANSCODE ────────────────────────────────────────────────
    // Convert whatever the user uploaded to a uniform 192kbps stereo mp3.
    // The original file (whatever its format) is deleted on success.
    // multer named the upload <uuid>.<ext>; we re-use that uuid stem so
    // the final file is just <uuid>.mp3, keeping things tidy.
    const inputBaseName = path.basename(audioFile.filename, path.extname(audioFile.filename));
    // Title fallback strategy:
    //   1. Explicit `title` form field (single-upload form)
    //   2. Original filename minus extension, with underscores → spaces
    //      (cleans up "Track_01_-_Title.mp3" patterns common from CD rips)
    const fallbackTitle = path.basename(audioFile.originalname, path.extname(audioFile.originalname))
      .replace(/_/g, ' ').trim();
    const finalTitle  = title?.trim() || fallbackTitle;
    const finalArtist = artist?.trim() || null;
    const finalAlbum  = album?.trim() || null;

    console.log('[admin-audio] upload received:', {
      original: audioFile.originalname,
      tempPath: audioFile.path,
      size: audioFile.size,
      hasC: !!coverFile,
    });

    let transcoded;
    try {
      transcoded = await transcodeToMp3({
        inputPath: audioFile.path,
        outputDir: AUDIO_DIR,
        outputBaseName: inputBaseName,
        tags: {
          title: finalTitle,
          artist: finalArtist || undefined,
          album: finalAlbum || undefined,
        },
      });
      console.log('[admin-audio] transcode OK:', transcoded);
    } catch (transcodeErr) {
      console.error('[admin-audio] Transcode failed:', transcodeErr);
      // Transcoder kept the original on failure — clean it up ourselves
      // since the upload as a whole has failed.
      try { fs.unlinkSync(audioFile.path); } catch {}
      if (coverFile) try { fs.unlinkSync(coverFile.path); } catch {}
      return fail(500, 'Conversie mislukt: ' + transcodeErr.message);
    }

    try {
      console.log('[admin-audio] inserting media row');
      db.prepare(`
        INSERT INTO media (id, site_id, filename, mime_type, size, storage_path)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(mediaId, site.id, transcoded.filename, transcoded.mimeType, transcoded.size, transcoded.path);

      // Duur automatisch: primair uit de transcode (ffmpeg codecData), anders een
      // optionele client-side waarde (bulk-uploader leest <audio>.duration uit),
      // anders NULL (UI toont dan '—:—', handmatig bij te werken in de editor).
      const clientDur = req.body.duration != null ? parseInt(req.body.duration, 10) : NaN;
      const finalDuration =
        (transcoded.durationSec != null && transcoded.durationSec > 0) ? transcoded.durationSec
        : (Number.isFinite(clientDur) && clientDur > 0) ? clientDur
        : null;

      console.log('[admin-audio] inserting audio_tracks row (duration=' + finalDuration + ')');
      db.prepare(`
        INSERT INTO audio_tracks (id, site_id, title, artist, album, duration, cover_url, media_id, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
          (SELECT MAX(position) + 1 FROM audio_tracks WHERE site_id = ?),
          0
        ))
      `).run(
        trackId, site.id,
        finalTitle, finalArtist, finalAlbum,
        finalDuration,
        coverUrl,
        mediaId, site.id
      );
      console.log('[admin-audio] DB inserts OK — track', trackId);
    } catch (dbErr) {
      console.error('[admin-audio] DB insert failed:', dbErr);
      // DB failed — clean up the transcoded mp3 so we don't leak files
      try { fs.unlinkSync(transcoded.path); } catch {}
      if (coverFile) try { fs.unlinkSync(coverFile.path); } catch {}
      return fail(500, dbErr.message);
    }

    return ok({
      id: trackId,
      title: finalTitle,
      artist: finalArtist,
      album: finalAlbum,
      size: transcoded.size,
    });
  });
});

router.post('/:id/delete', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const track = db.prepare(`
    SELECT t.id AS track_id, m.id AS media_id, m.storage_path
    FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
    WHERE t.id = ? AND t.site_id = ?
  `).get(req.params.id, site.id);

  if (!track) return res.redirect('/admin/audio?error=Not+found');

  db.prepare('DELETE FROM audio_tracks WHERE id = ?').run(track.track_id);
  if (track.media_id) {
    db.prepare('DELETE FROM media WHERE id = ?').run(track.media_id);
  }
  if (track.storage_path) {
    try { fs.unlinkSync(track.storage_path); } catch {}
  }
  res.redirect('/admin/audio?success=Deleted');
});

// ─── Orphan cleanup: rows whose file is missing on disk ───────────
//
// Two-phase to prevent accidental data loss:
//   GET  /admin/audio/cleanup   → dry-run report (no changes, JSON list)
//   POST /admin/audio/cleanup   → actually deletes the orphan rows
//
// "Orphan" = an audio_tracks row whose media_id either points nowhere or
// points to a media row whose storage_path file doesn't exist on disk.
// This is the recovery path when DB and disk drift apart (e.g. AUDIO_PATH
// changed between uploads, disk was wiped, or migration left stragglers).
function findOrphans(siteId) {
  const rows = db.prepare(`
    SELECT t.id AS track_id, t.title, t.artist, t.album,
           m.id AS media_id, m.storage_path
    FROM audio_tracks t
    LEFT JOIN media m ON m.id = t.media_id
    WHERE t.site_id = ?
  `).all(siteId);
  const orphans = [];
  for (const r of rows) {
    if (!r.storage_path) {
      orphans.push({ ...r, reason: 'no media row' });
      continue;
    }
    try { fs.statSync(r.storage_path); }
    catch { orphans.push({ ...r, reason: 'file missing on disk' }); }
  }
  return { total: rows.length, orphans };
}

router.get('/cleanup', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  const result = findOrphans(site.id);
  res.json({
    ok: true,
    siteId: site.id,
    totalTracks: result.total,
    orphanCount: result.orphans.length,
    orphans: result.orphans.map(o => ({
      track_id: o.track_id,
      title: o.title || '(zonder titel)',
      artist: o.artist || '—',
      reason: o.reason,
      storage_path: o.storage_path || null,
    })),
    note: 'POST to this same URL to actually delete these rows.',
  });
});

router.post('/cleanup', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  const { orphans } = findOrphans(site.id);

  // Wrap in a transaction so a partial failure doesn't leave half-deleted state
  const deleteOne = db.transaction((o) => {
    db.prepare('DELETE FROM audio_tracks WHERE id = ?').run(o.track_id);
    if (o.media_id) db.prepare('DELETE FROM media WHERE id = ?').run(o.media_id);
  });
  for (const o of orphans) deleteOne(o);

  res.json({ ok: true, deleted: orphans.length });
});


//
// All write endpoints expect to be hit by the track-editor modal which
// sends X-CSRF-Token and JSON. They return { ok: true, ... } on success
// or { error: '...' } with a 4xx status on failure.

/** GET /admin/audio/api/albums — distinct list of album names (for datalist) */
router.get('/api/albums', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  const rows = db.prepare(`
    SELECT DISTINCT album FROM audio_tracks
    WHERE site_id = ? AND album IS NOT NULL AND album != ''
    ORDER BY album COLLATE NOCASE
  `).all(site.id);
  res.json({ ok: true, albums: rows.map(r => r.album) });
});

/** GET /admin/audio/api/:id — single track with all metadata */
router.get('/api/:id', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  const t = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration, t.cover_url,
           t.position, t.created_at, m.filename
    FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
    WHERE t.id = ? AND t.site_id = ?
  `).get(req.params.id, site.id);
  if (!t) return res.status(404).json({ error: 'Track niet gevonden' });
  // Stream URL so the modal can render an inline preview player.
  const stream_url = t.filename ? audioUrl(t.filename) : null;
  res.json({ ok: true, track: { ...t, stream_url } });
});

/**
 * POST /admin/audio/api/:id — update track metadata.
 * Accepts JSON body with any subset of: title, artist, album, duration, cover_url.
 * `title` is required if present (can't be blanked). Empty strings on optional
 * fields are stored as NULL so the audio embed renderer's `t.artist || ''`
 * fallback keeps working.
 */
router.post('/api/:id', requireGod, express.json(), (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  const exists = db.prepare(
    'SELECT id FROM audio_tracks WHERE id = ? AND site_id = ?'
  ).get(req.params.id, site.id);
  if (!exists) return res.status(404).json({ error: 'Track niet gevonden' });

  const fields = [];
  const values = [];
  const body = req.body || {};

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const v = String(body.title || '').trim();
    if (!v) return res.status(400).json({ error: 'Titel is verplicht' });
    fields.push('title = ?'); values.push(v);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'artist')) {
    fields.push('artist = ?'); values.push(String(body.artist || '').trim() || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'album')) {
    fields.push('album = ?'); values.push(String(body.album || '').trim() || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'duration')) {
    const d = parseInt(body.duration, 10);
    fields.push('duration = ?');
    values.push(Number.isFinite(d) && d > 0 ? d : null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cover_url')) {
    // Accept either a /media/... path or an absolute https URL.
    // Anything else (javascript:, data:, etc) gets blanked for safety.
    const raw = String(body.cover_url || '').trim();
    let safe = null;
    if (raw === '') {
      safe = null;
    } else if (raw.startsWith('/media/') || raw.startsWith('https://') || raw.startsWith('http://')) {
      safe = raw;
    }
    fields.push('cover_url = ?'); values.push(safe);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'Niks om te updaten' });
  }

  try {
    db.prepare(`UPDATE audio_tracks SET ${fields.join(', ')} WHERE id = ? AND site_id = ?`)
      .run(...values, req.params.id, site.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Return fresh row so the caller can update its UI without reloading
  const fresh = db.prepare(`
    SELECT id, title, artist, album, duration, cover_url
    FROM audio_tracks WHERE id = ? AND site_id = ?
  `).get(req.params.id, site.id);
  res.json({ ok: true, track: fresh });
});

/**
 * POST /admin/audio/api/:id/cover — upload a new cover image and set it on
 * the track in one go. Returns { ok, url } so the modal can preview.
 *
 * Reuses the same multer config as the upload form (5MB limit, jpg/png/webp/gif).
 * If the track already had a cover stored under /media/audio-covers/, the old
 * file is deleted to avoid orphaned bytes piling up.
 */
router.post('/api/:id/cover', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });

  const exists = db.prepare(
    'SELECT id, cover_url FROM audio_tracks WHERE id = ? AND site_id = ?'
  ).get(req.params.id, site.id);
  if (!exists) return res.status(404).json({ error: 'Track niet gevonden' });

  upload.single('cover')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Geen bestand' });
    if (file.size > MAX_COVER_BYTES) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(413).json({ error: 'Te groot (max 5 MB)' });
    }

    const newUrl = `/media/audio-covers/${file.filename}`;
    try {
      db.prepare('UPDATE audio_tracks SET cover_url = ? WHERE id = ? AND site_id = ?')
        .run(newUrl, req.params.id, site.id);
    } catch (dbErr) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(500).json({ error: dbErr.message });
    }

    // Clean up the previous cover if it lived in our covers dir
    if (exists.cover_url && exists.cover_url.startsWith('/media/audio-covers/')) {
      const oldName = exists.cover_url.replace(/^\/media\/audio-covers\//, '');
      const oldPath = path.join(COVER_DIR, oldName);
      try { fs.unlinkSync(oldPath); } catch {}
    }

    // Return both keys so any caller using j.url OR j.cover_url works.
    // Frontend (track-editor.ejs) reads j.cover_url — keep this in sync.
    res.json({ ok: true, url: newUrl, cover_url: newUrl });
  });
});

export default router;
