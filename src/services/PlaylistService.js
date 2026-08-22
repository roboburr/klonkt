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
import { SOORTEN } from '../assets/js/shared/post-music-type.js';

/**
 * Een volledige datum of niets (shaer-756s).
 *
 * STRIKT, en dat is de hele functie. `year` bestaat al en blijft; dit veld
 * bestaat juist omdat een jaartal geen uitgavedatum is. Zou hij "2024"
 * doorlaten en er 2024-01-01 van maken, dan stond er straks een dag op de
 * federatie die niemand ooit heeft ingevoerd -- en dan hadden we het veld net
 * zo goed niet kunnen toevoegen.
 *
 * Ook 2024-02-31 valt af: dat is geen strengheid om de strengheid, Date rolt
 * hem stilletjes door naar 2 maart en dan slaan we iets anders op dan er
 * ingetypt is.
 */
function normDatum(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** Een MusicBrainz-id of niets. Zelfde vorm als sites.mb_artist_id. */
function normMbid(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : null;
}

/**
 * De drie soorten die een playlist kan zijn, op EEN plek.
 *
 * Stond eerder vijf keer als `data.kind === 'playlist' ? 'playlist' : 'album'`
 * verspreid over dit bestand. Met twee soorten kon dat nog; bij een derde is
 * het een fout die staat te wachten, want een van de vijf vergeten betekent dat
 * een mixtape stilletjes als album wordt opgeslagen en als Album de deur uit
 * gaat.
 *
 * Album blijft de terugval: een onbekende waarde hoort niet stilzwijgend iets
 * nieuws te worden. De lijst zelf staat in de gedeelde pure module, want de
 * editor in de browser moet dezelfde drie kennen.
 */
export function normKind(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return SOORTEN.includes(s) ? s : 'album';
}

/**
 * Draagt deze soort uitgavegegevens? Alleen een album. Een afspeellijst en een
 * mixtape hebben geen uitgavedatum en geen release-id: het zijn samenstellingen
 * van andermans of eigen werk, geen uitgave op zichzelf.
 */
export const isUitgave = (kind) => normKind(kind) === 'album';

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
             p.release_date, p.mb_release_id,
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
      kind: normKind(r.kind),
      release_date: r.release_date || '',
      mb_release_id: r.mb_release_id || '',
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
      SELECT id, title, artist, year, cover_url, kind, release_date, mb_release_id, created_at, updated_at
      FROM playlists WHERE site_id = ? AND id = ?
    `).get(siteId, id);
    if (!p) return null;

    // Pull tracks via junction, in order. LEFT JOIN media so we can resolve
    // filenames (only tracks with a media file are playable).
    const tracks = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration, t.cover_url,
             t.link_spotify, t.link_youtube, t.link_soundcloud, m.filename
      FROM playlist_tracks pt
      JOIN audio_tracks t   ON t.id = pt.track_id
      LEFT JOIN media m     ON m.id = t.media_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `).all(id);

    const mappedTracks = tracks
      // Link-only tracks (no media file) remain in the list with url ''.
      .map(t => ({
        id: t.id,
        title: t.title || 'Untitled',
        artist: t.artist || p.artist || '',
        cover: t.cover_url || p.cover_url || '',
        duration: t.duration || 0,
        link_spotify: t.link_spotify || '',
        link_youtube: t.link_youtube || '',
        link_soundcloud: t.link_soundcloud || '',
        url: (t.filename && urlFor) ? urlFor(t.filename) : '',
      }));
    // No playlist cover? Fall back to the first track cover so the card isn't empty.
    const fallbackCover = (mappedTracks.find(t => t.cover) || {}).cover || '';
    return {
      id: p.id,
      title: p.title,
      artist: p.artist || '',
      year: p.year || 0,
      cover: p.cover_url || fallbackCover,
      kind: normKind(p.kind),
      // created_at hoort erbij omdat de AP-kant er `published` van maakt. Zonder
      // dit veld viel buildAlbumObject terug op 1970, en dat stond op 16-8
      // gewoon op de federatie.
      created_at: p.created_at,
      // Leeg als het een afspeellijst is -- de opslag houdt ze daar al leeg,
      // maar dit is de plek waar de editor leest en die mag niet afhangen van
      // wat er toevallig in de kolom stond.
      release_date: isUitgave(p.kind) ? (p.release_date || '') : '',
      mb_release_id: isUitgave(p.kind) ? (p.mb_release_id || '') : '',
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
    const kind = normKind(data.kind);

    // Alleen een UITGAVE draagt deze twee. Een afspeellijst heeft geen
    // uitgavedatum en geen release-id, en dat onderscheid is precies wat de
    // keuze album/playlist betekent (shaer-cyg). Het afdwingen gebeurt HIER en
    // niet alleen in het scherm: een scherm kun je omzeilen -- de API ligt open
    // voor de post-editor -- en dan staat er stille rommel op een mixtape die
    // later als Album de deur uit gaat.
    const uitgave = isUitgave(kind);
    const releaseDate = uitgave ? normDatum(data.release_date) : null;
    const mbRelease = uitgave ? normMbid(data.mb_release_id) : null;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO playlists (id, site_id, title, artist, year, cover_url, kind, release_date, mb_release_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, siteId, title,
        String(data.artist || '').trim() || null,
        Number.isFinite(+data.year) && +data.year > 0 ? +data.year : null,
        String(data.cover || '').trim() || null,
        kind, releaseDate, mbRelease, now, now,
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
      'SELECT id, kind FROM playlists WHERE site_id = ? AND id = ?'
    ).get(siteId, id);
    if (!existing) return false;

    const fields = [];
    const values = [];
    // Wat wordt het NA deze wijziging? `kind` hoeft niet in data te staan, dus
    // val terug op wat er ligt.
    const nieuwKind = Object.prototype.hasOwnProperty.call(data, 'kind')
      ? normKind(data.kind)
      : normKind(existing.kind);
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
      fields.push('kind = ?'); values.push(nieuwKind);
    }
    // De uitgavevelden. Wordt dit een afspeellijst, dan gaan ze ALTIJD leeg --
    // ook als de aanroeper er niets over zei. Anders houdt een album dat je tot
    // mixtape ombouwt zijn uitgavedatum en zijn release-id, en die duiken dan
    // weer op zodra iemand hem terugzet. Een veld dat niet meer mag bestaan
    // hoort weg te zijn, niet te wachten.
    if (nieuwKind !== 'album') {
      fields.push('release_date = ?'); values.push(null);
      fields.push('mb_release_id = ?'); values.push(null);
    } else {
      if (Object.prototype.hasOwnProperty.call(data, 'release_date')) {
        fields.push('release_date = ?'); values.push(normDatum(data.release_date));
      }
      if (Object.prototype.hasOwnProperty.call(data, 'mb_release_id')) {
        fields.push('mb_release_id = ?'); values.push(normMbid(data.mb_release_id));
      }
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
   * will render a "playlist not found" placeholder.
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
