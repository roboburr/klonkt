/**
 * PlaylistService — first-class playlist entity (port of v9's pcms-playlists.php).
 *
 * Two responsibilities:
 *   1. CRUD on the playlists + playlist_tracks tables.
 *   2. Hydration: turn a playlist record into the shape AudioEmbedService
 *      expects (tracks with signed URLs, inherited covers, etc.).
 *
 * Posts reference playlists via [[playlist:<id>]] shortcodes. Editing a
 * playlist propagates to every post that embeds it — that's the whole point
 * of having playlists as a separate entity instead of inline JSON blobs.
 */

import db from '../config/database.js';
import { v4 as uuid } from 'uuid';

class PlaylistService {

  // ─── ID NORMALIZATION ─────────────────────────────────────────────

  /** Slugify to lowercase a-z 0-9 dashes, max 80 chars. */
  static normalizeId(raw) {
    if (!raw) return '';
    return String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  /** Generate a unique id for a new playlist within a site. */
  static generateId(siteId, title) {
    let base = this.normalizeId(title);
    if (!base) base = 'playlist-' + uuid().slice(0, 6);
    let id = base, i = 2;
    const exists = db.prepare(
      'SELECT 1 FROM playlists WHERE site_id = ? AND id = ?'
    );
    while (exists.get(siteId, id)) {
      id = `${base}-${i++}`;
    }
    return id;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────

  /**
   * List playlists for a site (lightweight — no tracks expanded).
   * Used by admin grid and the picker in post editor.
   */
  static list(siteId) {
    const rows = db.prepare(`
      SELECT p.id, p.title, p.artist, p.year, p.cover_url, p.kind,
             p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS track_count
      FROM playlists p
      WHERE p.site_id = ?
      ORDER BY p.updated_at DESC
    `).all(siteId);
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      artist: r.artist || '',
      year: r.year || 0,
      cover: r.cover_url || '',
      kind: r.kind || 'album',
      track_count: r.track_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Get a playlist with tracks fully hydrated. Tracks NOT in the audio
   * library anymore are silently dropped (matches v9 behavior).
   *
   * Returns null if the playlist doesn't exist.
   *
   * `urlFor` is an optional callback that takes a media filename and returns
   * its stream URL. If not provided, tracks come back with no `url` and the
   * caller has to resolve them. The render pipeline in posts.js always passes
   * urlFor.
   */
  static get(siteId, id, urlFor) {
    id = this.normalizeId(id);
    if (!id) return null;
    const p = db.prepare(`
      SELECT id, title, artist, year, cover_url, kind, created_at, updated_at
      FROM playlists WHERE site_id = ? AND id = ?
    `).get(siteId, id);
    if (!p) return null;

    // Pull tracks via junction, in order. LEFT JOIN media so we can resolve
    // filenames (only tracks with a media file are playable).
    const tracks = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration, t.cover_url, m.filename
      FROM playlist_tracks pt
      JOIN audio_tracks t   ON t.id = pt.track_id
      LEFT JOIN media m     ON m.id = t.media_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `).all(id);

    const mappedTracks = tracks
      .filter(t => t.filename)  // skip orphaned references
      .map(t => ({
        id: t.id,
        title: t.title || 'Untitled',
        artist: t.artist || p.artist || '',
        cover: t.cover_url || p.cover_url || '',
        duration: t.duration || 0,
        url: urlFor ? urlFor(t.filename) : null,
      }));
    // Geen eigen cover? Val terug op de eerste track-cover, zodat de kaart niet leeg is.
    const fallbackCover = (mappedTracks.find(t => t.cover) || {}).cover || '';
    return {
      id: p.id,
      title: p.title,
      artist: p.artist || '',
      year: p.year || 0,
      cover: p.cover_url || fallbackCover,
      kind: (p.kind === 'playlist') ? 'playlist' : 'album',
      tracks: mappedTracks,
    };
  }

  /**
   * Create a new playlist. Returns new id, or null on validation failure.
   * `data.tracks` is an ordered array of audio_tracks.id values.
   */
  static create(siteId, data) {
    const title = String(data.title || '').trim();
    if (!title) return null;

    const id = this.generateId(siteId, title);
    const now = new Date().toISOString();
    const kind = data.kind === 'playlist' ? 'playlist' : 'album';

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO playlists (id, site_id, title, artist, year, cover_url, kind, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, siteId, title,
        String(data.artist || '').trim() || null,
        Number.isFinite(+data.year) && +data.year > 0 ? +data.year : null,
        String(data.cover || '').trim() || null,
        kind, now, now,
      );
      this._writeTracks(id, siteId, data.tracks);
    });
    try {
      tx();
      return id;
    } catch (err) {
      console.error('[PlaylistService.create]', err);
      return null;
    }
  }

  /**
   * Update an existing playlist. Fields not present in `data` are left alone.
   * Returns true on success.
   */
  static update(siteId, id, data) {
    id = this.normalizeId(id);
    if (!id) return false;
    const existing = db.prepare(
      'SELECT id FROM playlists WHERE site_id = ? AND id = ?'
    ).get(siteId, id);
    if (!existing) return false;

    const fields = [];
    const values = [];
    if (Object.prototype.hasOwnProperty.call(data, 'title')) {
      const v = String(data.title || '').trim();
      if (!v) return false;  // title is required, can't blank it
      fields.push('title = ?'); values.push(v);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'artist')) {
      fields.push('artist = ?'); values.push(String(data.artist || '').trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'year')) {
      const y = +data.year;
      fields.push('year = ?'); values.push(Number.isFinite(y) && y > 0 ? y : null);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'cover')) {
      fields.push('cover_url = ?'); values.push(String(data.cover || '').trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'kind')) {
      fields.push('kind = ?'); values.push(data.kind === 'playlist' ? 'playlist' : 'album');
    }
    fields.push('updated_at = ?'); values.push(new Date().toISOString());

    const tx = db.transaction(() => {
      if (fields.length > 1) {  // > 1 because updated_at is always there
        db.prepare(`UPDATE playlists SET ${fields.join(', ')} WHERE id = ? AND site_id = ?`)
          .run(...values, id, siteId);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'tracks')) {
        // Replace track set wholesale — simpler and matches v9 semantics.
        db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
        this._writeTracks(id, siteId, data.tracks);
      }
    });
    try {
      tx();
      return true;
    } catch (err) {
      console.error('[PlaylistService.update]', err);
      return false;
    }
  }

  /**
   * Delete a playlist. Track references in playlist_tracks are removed
   * automatically via ON DELETE CASCADE. Posts that embed this playlist
   * will render a "playlist niet gevonden" placeholder.
   */
  static delete(siteId, id) {
    id = this.normalizeId(id);
    if (!id) return false;
    const result = db.prepare(
      'DELETE FROM playlists WHERE site_id = ? AND id = ?'
    ).run(siteId, id);
    return result.changes > 0;
  }

  // ─── INTERNAL ──────────────────────────────────────────────────────

  /**
   * Replace a playlist's track list. Skips track ids that don't belong to
   * this site (defensive — admin form should never send those, but better
   * safe than cross-site leak).
   */
  static _writeTracks(playlistId, siteId, trackIds) {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return;

    // Filter to ids that actually exist for this site, preserving order
    const placeholders = trackIds.map(() => '?').join(',');
    const valid = new Set(
      db.prepare(`
        SELECT id FROM audio_tracks WHERE site_id = ? AND id IN (${placeholders})
      `).all(siteId, ...trackIds).map(r => r.id)
    );

    const insert = db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `);
    let pos = 0;
    const seen = new Set();
    for (const tid of trackIds) {
      if (!valid.has(tid)) continue;
      if (seen.has(tid)) continue;  // dedupe while preserving order
      seen.add(tid);
      insert.run(playlistId, tid, pos++);
    }
  }
}

export default PlaylistService;
