/**
 * Export van een draagbaar inhoudsarchief (shaer-1a6).
 *
 * Bouwt precies wat docs/EXPORT-FORMAT.md beschrijft. Lees dat eerst; hier staat
 * alleen wat de code doet, niet waarom het formaat zo is.
 *
 * Twee dingen zijn geen implementatiedetail maar eis:
 *
 *   REPRODUCEERBAAR  Twee exports van ongewijzigde inhoud horen byte-voor-byte
 *                    gelijk te zijn, anders is een diff of een checksum nutteloos.
 *                    Vandaar gesorteerde sleutels, vaste volgorde, geen tijdstip
 *                    in de postbestanden en een vaste mtime in de zip.
 *   GEEN CREDENTIALS Dit is niet de storage-zip uit shaer-190t. Hier komt geen
 *                    sleutel, sessie, hash of DM van een ander in.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../config/database.js';
import { MEDIA_ROOT } from '../config/paths.js';

export const FORMAT_VERSION = 1;

/** JSON met gesorteerde sleutels: zonder vaste volgorde is byte-gelijkheid toeval. */
export function stableJson(value) {
  const sorteer = (v) => {
    if (Array.isArray(v)) return v.map(sorteer);
    if (v && typeof v === 'object') {
      const uit = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) uit[k] = sorteer(v[k]);
      return uit;
    }
    return v;
  };
  return `${JSON.stringify(sorteer(value), null, 2)}\n`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// SQLite's CURRENT_TIMESTAMP schrijft 'YYYY-MM-DD HH:MM:SS' in UTC, zonder marker.
// Kale Date.parse leest dat als LOKALE tijd, dus op een server op UTC+2 ging er twee
// uur van elke stempel af voordat hij het archief in ging. Die verschuiving wordt bij
// het exporteren ingebakken en valt niet weg bij het importeren: exporteer je in
// Amsterdam, dan is die post overal permanent twee uur te vroeg, en in zomer- en
// wintertijd verschillend. Het raakte de stempels die de database zelf zet (concepten,
// ingeplande posts, gearchiveerde antwoorden), niet die uit de editor, dus de schade
// was stil en gedeeltelijk. EXPORT-FORMAT.md schreef altijd al "ISO 8601, UTC" voor.
// Zelfde regel als isoStamp() in ActivityPubService en stampMs() in guardianship/offers.
const SQL_STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const toISO = (d) => {
  const s = String(d == null ? '' : d);
  const t = Date.parse(SQL_STAMP.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return isNaN(t) ? null : new Date(t).toISOString();
};

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
};
const extOf = (u) => ((String(u).split('?')[0].match(/\.(\w+)$/) || [])[1] || '').toLowerCase();
const mimeOf = (u) => MIME_BY_EXT[extOf(u)] || 'application/octet-stream';
const as2TypeOf = (mime) => (mime.startsWith('video/') ? 'Video' : mime.startsWith('audio/') ? 'Audio' : 'Image');

/**
 * Van een media-URL naar een bestand op schijf.
 *
 * /media is een kale express.static op MEDIA_ROOT, dus het URL-pad IS het pad
 * onder die map. Een absolute URL naar onze eigen origin telt net zo goed als
 * een pad -- de content slaat allebei op.
 *
 * De ../-controle is geen formaliteit: een verzonnen pad in oude inhoud zou
 * anders een willekeurig bestand van de schijf het archief in trekken.
 */
function localMediaPath(url, origin) {
  let p = String(url || '');
  if (!p) return null;
  if (/^https?:/i.test(p)) {
    try {
      const u = new URL(p);
      if (`${u.protocol}//${u.host}` !== origin) return null;   // andermans host: nooit van onze schijf
      p = u.pathname;
    } catch { return null; }
  }
  if (!p.startsWith('/media/')) return null;
  const abs = path.resolve(MEDIA_ROOT, decodeURIComponent(p.slice('/media/'.length)));
  const root = path.resolve(MEDIA_ROOT);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  return abs;
}

/** Alle media waar een post naar wijst, in vaste volgorde en zonder dubbelen. */
function mediaRefsOf(post, origin) {
  const uit = [];
  const zie = new Set();
  const voegToe = (url, name, rol, extra = {}) => {
    const u = String(url || '').trim();
    if (!u || zie.has(u)) return;
    zie.add(u);
    uit.push({ url: u, name: name || null, rol, ...extra });
  };
  // De ROL is niet decoratief. Zonder rol staat er in het archief wel een
  // bestand, maar niet dat het de cover was of bij de speler hoorde -- en dan
  // komt de post na een herstel zonder cover en zonder speler terug. Gevonden
  // door bij de oefenherstel ALLE kolommen te vergelijken in plaats van een
  // handjevol.
  voegToe(post.cover_image_url, post.cover_alt, 'cover');
  voegToe(post.cover_video_url, post.cover_alt, 'coverVideo');
  for (const m of String(post.content || '').matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) voegToe(m[1], null, 'inline');
  try {
    for (const a of JSON.parse(post.c2s_attachments || '[]')) {
      voegToe(a && a.url, a && a.name, 'c2s');
      // Een audio-bijlage draagt een poster (de omslag die de speler toont). Die
      // staat in een eigen veld en zou anders stil wegvallen -- op beta viel dat
      // pas op bij de export van echte data.
      voegToe(a && a.poster, a && a.name ? `${a.name} (poster)` : null, 'poster', { posterFor: a && a.url });
    }
  } catch { /* kapotte kolom blokkeert de export niet */ }
  // Gehoste audio: [[track:id]] verwijst naar een audio_tracks-rij met een media-rij eronder.
  for (const m of String(post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) {
    try {
      const t = db.prepare('SELECT t.title, m.storage_path FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id WHERE t.id = ?').get(m[1]);
      if (t && t.storage_path) voegToe(`/media/${path.relative(path.resolve(MEDIA_ROOT), path.resolve(t.storage_path))}`, t.title, 'track');
    } catch { /* geen audio-tabellen: niets te doen */ }
  }
  return uit;
}

/**
 * De audio-metadata die alleen in de database staat en nergens anders uit te
 * halen is: titel, artiest, credit, licentie, externe links.
 *
 * `shaer:media` koppelt de track aan zijn bestand in het archief. Zonder die
 * verwijzing weet een importer wel dát er een track was en hoe hij heette, maar
 * niet wélk van de bijlagen erbij hoort -- en dan valt [[track:]] bij een
 * herstel op niets terug.
 */
function audioOf(post, attachments) {
  const uit = [];
  for (const m of String(post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) {
    try {
      const t = db.prepare('SELECT t.*, md.storage_path FROM audio_tracks t LEFT JOIN media md ON md.id = t.media_id WHERE t.id = ?').get(m[1]);
      if (!t) continue;
      let bestand;
      if (t.storage_path) {
        const rel = `/media/${path.relative(path.resolve(MEDIA_ROOT), path.resolve(t.storage_path))}`;
        const bij = attachments.find((a) => String(a['shaer:originalUrl'] || '').endsWith(rel));
        bestand = bij ? bij.url : undefined;
      }
      uit.push({
        'shaer:ref': `[[track:${t.id}]]`,
        'shaer:media': bestand,
        name: t.title, artist: t.artist || undefined, album: t.album || undefined,
        duration: t.duration || undefined, credit: t.credit || undefined, license: t.license || undefined,
        url: [t.link_spotify, t.link_youtube, t.link_soundcloud].filter(Boolean),
      });
    } catch { /* idem */ }
  }
  return uit.length ? uit : undefined;
}

/** Eén post als AS2-object volgens het formaat. Bijlagen komen van de beller. */
function postObject(post, site, origin, attachments) {
  const heeftTitel = !!(post.title && String(post.title).trim());
  const published = toISO(post.published_at || post.created_at) || toISO(post.created_at);
  const updated = toISO(post.updated_at);
  const poll = (() => {
    try {
      const d = JSON.parse(post.poll_json || 'null');
      if (!d || !Array.isArray(d.options) || d.options.length < 2) return null;
      const opties = d.options.map((o) => ({ type: 'Note', name: String(o && o.name != null ? o.name : o) }));
      return { multiple: !!d.multiple, opties, endTime: d.endTime || null, closed: !!d.closed };
    } catch { return null; }
  })();
  const tags = [];
  try {
    for (const t of String(post.tags || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      tags.push({ type: 'Hashtag', name: t.startsWith('#') ? t : `#${t}`, href: `${origin}/tag/${encodeURIComponent(t.replace(/^#/, ''))}` });
    }
  } catch { /* tags zijn optioneel */ }

  return {
    '@context': ['https://www.w3.org/ns/activitystreams', { shaer: 'https://klonkt.com/ns#', toot: 'http://joinmastodon.org/ns#', Hashtag: 'as:Hashtag', sensitive: 'as:sensitive' }],
    id: `${origin}/ap/notes/${encodeURIComponent(post.id)}`,
    type: poll ? 'Question' : (heeftTitel ? 'Article' : 'Note'),
    attributedTo: `${origin}/ap/users/${encodeURIComponent(site.slug)}`,
    name: heeftTitel ? post.title : undefined,
    content: post.content || '',
    contentMap: post.language ? { [post.language]: post.content || '' } : undefined,
    summary: post.content_warning || undefined,
    sensitive: post.nsfw ? true : undefined,
    published,
    updated: (updated && updated !== published) ? updated : undefined,
    url: `${origin}/${encodeURIComponent(post.slug)}`,
    attachment: attachments.length ? attachments : undefined,
    tag: tags.length ? tags : undefined,
    ...(poll ? (poll.multiple ? { anyOf: poll.opties } : { oneOf: poll.opties }) : {}),
    endTime: poll ? (poll.endTime || undefined) : undefined,
    // AS2 kent `closed` op een Question. Zonder dit staat een poll die vroegtijdig
    // is gesloten na een herstel weer open -- gevonden op echte beta-data.
    closed: (poll && poll.closed) ? true : undefined,
    quoteUrl: post.quote_uri || undefined,
    'shaer:quoteActor': post.quote_actor || undefined,
    'shaer:slug': post.slug,
    'shaer:status': post.status || 'draft',
    'shaer:excerpt': post.excerpt || undefined,
    'shaer:type': post.type || undefined,
    'shaer:pinned': post.pinned ? true : undefined,
    'shaer:noindex': post.noindex ? true : undefined,
    'shaer:fanOnly': post.fan_only ? true : undefined,
    'shaer:paid': post.paid ? true : undefined,
    'shaer:paidMinCents': post.paid ? (post.paid_min_cents || undefined) : undefined,
    'shaer:apVisibility': post.ap_visibility || undefined,
    'shaer:publishAt': toISO(post.publish_at) || undefined,
    'shaer:coverAlt': post.cover_alt || undefined,
    'shaer:viewCount': post.view_count || undefined,
    'shaer:audio': audioOf(post, attachments),
  };
}

/** De leesbare kopie. Afgeleid, eenrichtingsverkeer -- de importer kijkt hier nooit naar. */
function readableMarkdown(post, obj) {
  const fm = [
    '---',
    `title: ${JSON.stringify(post.title || post.slug)}`,
    `slug: ${JSON.stringify(post.slug)}`,
    `date: ${obj.published || ''}`,
    `status: ${post.status || 'draft'}`,
    post.content_warning ? `content_warning: ${JSON.stringify(post.content_warning)}` : null,
    '---',
  ].filter((l) => l !== null).join('\n');
  return `${fm}\n${post.content || ''}\n`;
}

/**
 * Bouw het archief als een lijst bestanden: pad -> inhoud (Buffer).
 *
 * Bewust geen schrijven naar schijf hier: dat maakt de vorm testbaar zonder
 * tijdelijke mappen, en de beller bepaalt of het een map of een zip wordt.
 */
export function buildArchive(slug, opts = {}) {
  const origin = (opts.origin || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
  if (!site) throw new Error(`onbekende site: ${slug}`);

  const bestanden = new Map();       // pad -> Buffer
  const tellingen = { posts: 0, replies: 0, media: 0, mediaMissing: 0 };
  const ontbrekend = [];             // voor de rapportage van de beller

  // Vaste volgorde: eerst op publicatiedatum, dan op id. Zonder tweede sleutel
  // is de volgorde van twee posts op dezelfde seconde niet bepaald.
  const posts = db.prepare(`SELECT * FROM posts WHERE site_id = ?
                             ORDER BY COALESCE(published_at, created_at) ASC, id ASC`).all(site.id);

  for (const post of posts) {
    const attachments = [];
    for (const ref of mediaRefsOf(post, origin)) {
      const schijf = localMediaPath(ref.url, origin);
      const mime = mimeOf(ref.url);
      let bytes = null;
      if (schijf) { try { bytes = fs.readFileSync(schijf); } catch { bytes = null; } }
      if (bytes) {
        const hash = sha256(bytes);
        const naam = `media/${hash}${extOf(ref.url) ? `.${extOf(ref.url)}` : ''}`;
        if (!bestanden.has(naam)) { bestanden.set(naam, bytes); tellingen.media += 1; }
        attachments.push({
          type: as2TypeOf(mime), mediaType: mime, name: ref.name || undefined,
          url: naam, 'shaer:availability': 'included',
          'shaer:originalUrl': /^https?:/i.test(ref.url) ? ref.url : `${origin}${ref.url}`,
          'shaer:sha256': hash,
          'shaer:role': ref.rol,
          'shaer:posterFor': ref.posterFor || undefined,
        });
      } else {
        // De derde staat uit het formaat: we weten DAT het bestond en waar het
        // stond, maar we hebben de bytes niet. Stil weglaten zou een leugen zijn.
        tellingen.mediaMissing += 1;
        const orig = /^https?:/i.test(ref.url) ? ref.url : `${origin}${ref.url}`;
        ontbrekend.push({ post: post.slug, url: orig });
        attachments.push({
          type: as2TypeOf(mime), mediaType: mime, name: ref.name || undefined,
          url: orig, 'shaer:availability': 'missing', 'shaer:originalUrl': orig,
          'shaer:role': ref.rol,
          'shaer:posterFor': ref.posterFor || undefined,
        });
      }
    }

    const obj = postObject(post, site, origin, attachments);
    bestanden.set(`posts/${post.id}.json`, Buffer.from(stableJson(obj), 'utf8'));
    bestanden.set(`readable/${post.slug}.md`, Buffer.from(readableMarkdown(post, obj), 'utf8'));
    tellingen.posts += 1;

    // Antwoorden van anderen: alleen-lezen archief, nooit opnieuw bezorgd.
    let replies = [];
    try {
      replies = db.prepare(`SELECT * FROM ap_interactions WHERE post_id = ? AND kind = 'reply'
                             ORDER BY COALESCE(published, created_at) ASC, id ASC`).all(post.id);
    } catch { /* tabel kan ontbreken op een heel oude database */ }
    if (replies.length) {
      const coll = {
        '@context': ['https://www.w3.org/ns/activitystreams', { shaer: 'https://klonkt.com/ns#' }],
        type: 'OrderedCollection',
        'shaer:archive': true,
        'shaer:inReplyTo': obj.id,
        totalItems: replies.length,
        orderedItems: replies.map((r) => ({
          id: r.object_uri || undefined,
          type: 'Note',
          attributedTo: r.actor_uri || undefined,
          inReplyTo: r.parent_uri || obj.id,
          content: r.content || '',
          published: toISO(r.published || r.created_at) || undefined,
          'shaer:actorName': r.actor_name || undefined,
          'shaer:actorHandle': r.actor_handle || undefined,
        })),
      };
      bestanden.set(`replies/${post.id}.json`, Buffer.from(stableJson(coll), 'utf8'));
      tellingen.replies += replies.length;
    }
  }

  const files = {};
  for (const pad of [...bestanden.keys()].sort()) files[pad] = sha256(bestanden.get(pad));
  const manifest = {
    formatVersion: FORMAT_VERSION,
    generator: `klonkt/${opts.version || 'dev'}`,
    exportedAt: opts.exportedAt || new Date().toISOString(),
    origin,
    actor: `${origin}/ap/users/${encodeURIComponent(site.slug)}`,
    site: { slug: site.slug, title: site.title || site.slug },
    counts: tellingen,
    files,
  };
  bestanden.set('manifest.json', Buffer.from(stableJson(manifest), 'utf8'));

  return { files: bestanden, manifest, counts: tellingen, missing: ontbrekend };
}

// ── Zip, store-only en deterministisch ────────────────────────────
// Geen nieuwe afhankelijkheid, en zonder compressie is byte-gelijkheid geen
// kwestie van vertrouwen in de instellingen van een bibliotheek. De mtime is
// vast (1980-01-01, de nul van het zip-formaat) om dezelfde reden.

const _crcTabel = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ _crcTabel[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

export function zipArchive(files) {
  const paden = [...files.keys()].sort();
  const lokaal = [];
  const centraal = [];
  let offset = 0;
  for (const pad of paden) {
    const naam = Buffer.from(pad, 'utf8');
    const data = files.get(pad);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);                       // store, geen compressie
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(33, 12);   // vaste tijd: 1980-01-01
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(naam.length, 26); lh.writeUInt16LE(0, 28);
    lokaal.push(lh, naam, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(33, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(naam.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centraal.push(ch, naam);
    offset += 30 + naam.length + data.length;
  }
  const cd = Buffer.concat(centraal);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(paden.length, 8); eocd.writeUInt16LE(paden.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokaal, cd, eocd]);
}

/** Schrijf het archief als losse bestanden naar een map. */
export function writeArchiveDir(files, dir) {
  for (const pad of [...files.keys()].sort()) {
    const doel = path.join(dir, pad);
    fs.mkdirSync(path.dirname(doel), { recursive: true });
    fs.writeFileSync(doel, files.get(pad));
  }
}
