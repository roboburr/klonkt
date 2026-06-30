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
import { toWebp } from '../services/ImageWebpService.js';
import { requireGod } from '../middleware/auth.js';
import { transcodeToMp3, retagMp3 } from '../services/AudioTranscoder.js';
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
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;   // 50 MB — compressed formats (mp3/m4a/ogg/…)
const MAX_WAV_BYTES   = 100 * 1024 * 1024;  // 100 MB — WAV is uncompressed, so a higher limit
const MAX_COVER_BYTES = 5 * 1024 * 1024;    // 5 MB

// Per-file upper limit based on extension. multer's global limit is the
// highest (WAV); the real per-type check happens in the upload handler.
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
  limits: { fileSize: MAX_WAV_BYTES }, // highest upper bound (WAV) — per-type check in the handler
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

// "Open in" platform links per track: only https + the correct host accepted
// (href arrives unescaped in the view → scheme/host guard against abuse).
const LINK_DOMAINS = {
  spotify: ['spotify.com'],
  youtube: ['youtube.com', 'youtu.be', 'music.youtube.com'],
  soundcloud: ['soundcloud.com'],
};
function platformLink(url, domains) {
  const u = String(url || '').trim();
  if (!u || !/^https:\/\//i.test(u)) return null;
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (domains.some((d) => h === d || h.endsWith('.' + d))) return u;
  } catch (e) { /* invalid URL */ }
  return null;
}

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const rows = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration, t.cover_url,
           t.position, t.created_at, t.downloadable, m.filename, m.size, m.mime_type
    FROM audio_tracks t
    LEFT JOIN media m ON m.id = t.media_id
    WHERE t.site_id = ?
    ORDER BY t.created_at DESC, t.position DESC
  `).all(site.id);

  // Build each track's stream URL so admins can preview audio inline.
  const tracks = rows.map(t => ({
    ...t,
    stream_url: t.filename ? audioUrl(t.filename) : null,
  }));

  const base = (process.env.PUBLIC_BASE_URL || ('https://' + (req.get('host') || ''))).replace(/\/$/, '');
  const embedUrl = base + (res.locals.siteUrlBase || '') + '/embed';
  renderPage(req, res, 'pages/admin-audio', {
    pageTitleKey: 'admin.t_audio',
    bodyClass: 'on-admin',
    tracks,
    embedUrl,
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

    // Per-type audio size check. multer's global limit was the WAV upper bound
    // (100MB); compressed formats stay at 50MB.
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
    // Ownership/licence. credit falls back to the artist; these go both into the
    // DB and into the ID3 tags of the mp3 (copyright + comment).
    const finalCredit  = (req.body.credit  || '').trim() || finalArtist || null;
    const finalLicense = (req.body.license || '').trim() || null;
    const finalLinkSpotify    = platformLink(req.body.link_spotify, LINK_DOMAINS.spotify);
    const finalLinkYoutube    = platformLink(req.body.link_youtube, LINK_DOMAINS.youtube);
    const finalLinkSoundcloud = platformLink(req.body.link_soundcloud, LINK_DOMAINS.soundcloud);

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
          copyright: finalCredit || undefined,
          comment: finalLicense || undefined,
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

      // Duration automatically: primarily from the transcode (ffmpeg codecData), then
      // an optional client-side value (bulk uploader reads <audio>.duration),
      // otherwise NULL (UI then shows '—:—', editable manually in the editor).
      const clientDur = req.body.duration != null ? parseInt(req.body.duration, 10) : NaN;
      const finalDuration =
        (transcoded.durationSec != null && transcoded.durationSec > 0) ? transcoded.durationSec
        : (Number.isFinite(clientDur) && clientDur > 0) ? clientDur
        : null;

      console.log('[admin-audio] inserting audio_tracks row (duration=' + finalDuration + ')');
      db.prepare(`
        INSERT INTO audio_tracks (id, site_id, title, artist, album, duration, cover_url, credit, license, link_spotify, link_youtube, link_soundcloud, media_id, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
          (SELECT MAX(position) + 1 FROM audio_tracks WHERE site_id = ?),
          0
        ))
      `).run(
        trackId, site.id,
        finalTitle, finalArtist, finalAlbum,
        finalDuration,
        coverUrl,
        finalCredit, finalLicense,
        finalLinkSpotify, finalLinkYoutube, finalLinkSoundcloud,
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

// Download-for-email per track on/off (premium #2). No-JS toggle from the
// audio admin list → flip + back.
router.post('/:id/downloadable', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  const row = db.prepare('SELECT downloadable FROM audio_tracks WHERE id = ? AND site_id = ?').get(req.params.id, site.id);
  if (row) {
    db.prepare('UPDATE audio_tracks SET downloadable = ? WHERE id = ? AND site_id = ?')
      .run(row.downloadable ? 0 : 1, req.params.id, site.id);
  }
  res.redirect('/admin/audio');
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
// Create a track WITHOUT an audio file (title + open-in links only). Appears
// in albums/playlists in the list, with open-in icons but no play button.
router.post('/create-link', requireGod, express.json(), (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  const trackId = uuid();
  const title = ((req.body && req.body.title) || 'Nieuwe track').toString().trim().slice(0, 200) || 'Nieuwe track';
  try {
    db.prepare(`
      INSERT INTO audio_tracks (id, site_id, title, media_id, position)
      VALUES (?, ?, ?, NULL, COALESCE((SELECT MAX(position) + 1 FROM audio_tracks WHERE site_id = ?), 0))
    `).run(trackId, site.id, title, site.id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, id: trackId });
});

router.get('/api/:id', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'Site required' });
  const t = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration, t.cover_url,
           t.credit, t.license, t.link_spotify, t.link_youtube, t.link_soundcloud,
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
router.post('/api/:id', requireGod, express.json(), async (req, res) => {
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

  if (Object.prototype.hasOwnProperty.call(body, 'downloadable')) {
    fields.push('downloadable = ?'); values.push(body.downloadable ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'credit')) {
    fields.push('credit = ?'); values.push(String(body.credit || '').trim() || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'license')) {
    fields.push('license = ?'); values.push(String(body.license || '').trim() || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'link_spotify')) {
    fields.push('link_spotify = ?'); values.push(platformLink(body.link_spotify, LINK_DOMAINS.spotify));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'link_youtube')) {
    fields.push('link_youtube = ?'); values.push(platformLink(body.link_youtube, LINK_DOMAINS.youtube));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'link_soundcloud')) {
    fields.push('link_soundcloud = ?'); values.push(platformLink(body.link_soundcloud, LINK_DOMAINS.soundcloud));
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

  // Fresh row + (if tag fields changed) retag the mp3, so that the owner/
  // licence is also IN the file (ID3) and travels with it on download.
  const fresh = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration, t.cover_url, t.credit, t.license, m.storage_path
    FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
    WHERE t.id = ? AND t.site_id = ?
  `).get(req.params.id, site.id);

  const tagsChanged = ['title', 'artist', 'album', 'credit', 'license']
    .some((f) => Object.prototype.hasOwnProperty.call(body, f));
  if (fresh && fresh.storage_path && tagsChanged) {
    try {
      await retagMp3({ filePath: fresh.storage_path, tags: {
        title: fresh.title || undefined,
        artist: fresh.artist || undefined,
        album: fresh.album || undefined,
        copyright: fresh.credit || undefined,
        comment: fresh.license || undefined,
      } });
    } catch (e) {
      console.warn('[admin-audio] ID3 retag failed (DB was still updated):', e.message);
    }
  }
  const { storage_path, ...trackOut } = fresh || {};
  res.json({ ok: true, track: trackOut });
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

    const newUrl = `/media/audio-covers/${toWebp(file)}`;
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

// Replace the audio FILE of an existing track (keeps all metadata + the track id, so any
// [[track:id]] in posts keeps pointing here). Transcodes the new upload to a uniform mp3,
// swaps the track's media_id + duration, and deletes the old media file/row.
router.post('/api/:id/replace-audio', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ ok: false, error: 'Site required' });
  const track = db.prepare('SELECT id, media_id FROM audio_tracks WHERE id = ? AND site_id = ?').get(req.params.id, site.id);
  if (!track) return res.status(404).json({ ok: false, error: 'Track niet gevonden' });

  upload.single('audio')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'Geen bestand' });
    const ext = path.extname(file.originalname).toLowerCase();
    const limit = audioByteLimitFor(ext);
    if (file.size > limit) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(413).json({ ok: false, error: `Te groot (max ${Math.round(limit / 1024 / 1024)}MB voor ${ext || 'dit type'})` });
    }

    let transcoded;
    try {
      transcoded = await transcodeToMp3({
        inputPath: file.path, outputDir: AUDIO_DIR,
        outputBaseName: path.basename(file.filename, path.extname(file.filename)), tags: {},
      });
    } catch (e) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(500).json({ ok: false, error: 'Conversie mislukt: ' + e.message });
    }

    const newMediaId = uuid();
    try {
      db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
        .run(newMediaId, site.id, transcoded.filename, transcoded.mimeType, transcoded.size, transcoded.path);
      db.prepare('UPDATE audio_tracks SET media_id = ? WHERE id = ? AND site_id = ?').run(newMediaId, track.id, site.id);
      const dur = (transcoded.durationSec != null && transcoded.durationSec > 0) ? transcoded.durationSec : null;
      if (dur) db.prepare('UPDATE audio_tracks SET duration = ? WHERE id = ?').run(dur, track.id);
      // Remove the OLD media (file + row), best-effort.
      if (track.media_id && track.media_id !== newMediaId) {
        try { const old = db.prepare('SELECT storage_path FROM media WHERE id = ?').get(track.media_id); if (old && old.storage_path) fs.unlinkSync(old.storage_path); } catch {}
        try { db.prepare('DELETE FROM media WHERE id = ?').run(track.media_id); } catch {}
      }
      return res.json({ ok: true, stream_url: audioUrl(transcoded.filename), duration: dur });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
});

export default router;
