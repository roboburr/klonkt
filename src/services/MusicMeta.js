// Phase 1 of music federation: emit STANDARD schema.org MusicRecording / MusicAlbum
// structured data for an audio post (Google rich results + any generic JSON-LD consumer).
// Deliberately a real, existing web standard — NOT a Klonkt-invented field. The track
// resolution here is reused by the (future) Funkwhale Audio/Library federation (Phase 2).
import db from '../config/database.js';

const COLS = 'title, album, duration, credit, license, cover_url, media_id';

function isoDuration(sec) {
  const n = parseInt(sec, 10);
  if (!n || n < 0) return null;
  return `PT${Math.floor(n / 60)}M${n % 60}S`; // ISO-8601 duration, e.g. PT3M20S
}
function absUrl(base, u) {
  if (!u) return null;
  return /^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`;
}

// Resolve a post's [[track]]/[[album]]/[[playlist]] shortcodes to the HOSTED (playable)
// tracks it references — only file-backed tracks (media_id), mirroring hasPlayableAudio.
function resolveTracks(site, content) {
  const tracks = [];
  try {
    for (const m of content.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) {
      const r = db.prepare(`SELECT ${COLS} FROM audio_tracks WHERE id = ?`).get(m[1]);
      if (r && r.media_id) tracks.push(r);
    }
    for (const m of content.matchAll(/\[\[album:([^\]]+)\]\]/g)) {
      for (const r of db.prepare(`SELECT ${COLS} FROM audio_tracks WHERE site_id = ? AND album = ? AND media_id IS NOT NULL ORDER BY rowid`).all(site.id, m[1].trim())) tracks.push(r);
    }
    for (const m of content.matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) {
      for (const r of db.prepare(`SELECT t.title, t.album, t.duration, t.credit, t.license, t.cover_url, t.media_id FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? AND t.media_id IS NOT NULL ORDER BY pt.position`).all(m[1])) tracks.push(r);
    }
  } catch { /* non-fatal */ }
  return tracks;
}

// Build a schema.org MusicRecording (single track) or MusicAlbum (multiple) for a post,
// or null when the post has no hosted audio. `url` points to the gated player page — the
// anti-steal posture is preserved (no raw file URL is ever emitted).
export function build(base, site, post) {
  if (!post || !site || !post.content) return null;
  if (!/\[\[(track|album|playlist):/i.test(post.content)) return null;
  const b = (base || '').replace(/\/+$/, '');
  const tracks = resolveTracks(site, post.content);
  if (!tracks.length) return null;

  const artist = {
    '@type': 'MusicGroup',
    name: site.title || site.slug,
    url: `${b}/${site.is_primary ? '' : 'user/' + encodeURIComponent(site.slug)}`,
  };
  const postUrl = `${b}/${encodeURIComponent(post.slug)}`;
  const recording = (t, withTop) => {
    const o = { '@type': 'MusicRecording', name: t.title || post.title || 'Untitled' };
    if (withTop) { o.byArtist = artist; o.url = postUrl; }
    if (t.album) o.inAlbum = { '@type': 'MusicAlbum', name: t.album };
    const d = isoDuration(t.duration); if (d) o.duration = d;
    if (t.license) o.license = t.license;     // e.g. "CC BY 4.0" — Klonkt leads on this
    if (t.credit) o.creditText = t.credit;
    const cov = absUrl(b, t.cover_url) || absUrl(b, post.cover_image_url); if (cov) o.image = cov;
    return o;
  };

  let ld;
  if (tracks.length > 1) {
    const albums = [...new Set(tracks.map((t) => t.album).filter(Boolean))];
    ld = {
      '@type': 'MusicAlbum',
      name: albums.length === 1 ? albums[0] : (post.title || 'Album'),
      byArtist: artist,
      url: postUrl,
      numTracks: tracks.length,
      track: tracks.map((t) => recording(t, false)),
    };
    const cov = absUrl(b, post.cover_image_url) || absUrl(b, tracks[0].cover_url); if (cov) ld.image = cov;
    const lic = tracks.find((t) => t.license); if (lic) ld.license = lic.license;
  } else {
    ld = recording(tracks[0], true);
  }
  ld['@context'] = 'https://schema.org';
  const dp = post.published_at || post.created_at;
  if (dp) ld.datePublished = new Date(dp).toISOString();
  return ld;
}

export default { build };
