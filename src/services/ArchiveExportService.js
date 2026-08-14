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
import { MEDIA_ROOT, resolveAudioPath } from '../config/paths.js';

// v2: audio zit er eindelijk echt in. Tot v1 kon dat niet: gehoste audio staat
// BUITEN MEDIA_ROOT (eigen gated route, zie routes/audio.js), en het archief
// droeg alleen bestanden onder media/. De exporter rekende er met path.relative
// een /media/../audio/x.mp3 van, en de importer weigerde dat pad terecht. Er
// stond dus wel een track in de database van de nieuwe site, maar nooit een
// bestand. v2 heeft een eigen audio/-gebied, exporteert de HELE bibliotheek in
// plaats van alleen wat in een bericht staat, en neemt de playlists mee.
export const FORMAT_VERSION = 2;

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
/**
 * Naar ISO 8601 in UTC.
 *
 * SQLite schrijft CURRENT_TIMESTAMP als "2026-07-01 12:56:10" -- in UTC, maar
 * ZONDER zone erbij. Date.parse leest die vorm als LOKALE tijd, en dan schuift
 * elk tijdstempel in het archief mee met de tijdzone van de machine die de export
 * draait. Op een server in Amsterdam is dat twee uur, en dat merk je pas als je
 * ergens anders importeert.
 *
 * Gevonden doordat Bart vroeg of dit wel naar UTC normaliseert. De testmachine
 * draait op UTC, dus geen enkele test kon het zien.
 */
const toISO = (d) => {
  if (!d) return null;
  const s = String(d).trim();
  const zonderZone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const t = Date.parse(zonderZone ? `${s.replace(' ', 'T')}Z` : s);
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
  // Gehoste audio staat hier NIET meer bij. Die leeft buiten MEDIA_ROOT en gaat
  // sinds v2 via het audio/-gebied (zie audioBibliotheek). De oude regel rekende
  // met path.relative een pad naar buiten MEDIA_ROOT uit, en dat kon nooit
  // aankomen: de importer weigert zo'n pad, terecht.
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
function audioOf(post, audioKaart) {
  const uit = [];
  for (const m of String(post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) {
    try {
      const t = db.prepare('SELECT * FROM audio_tracks WHERE id = ?').get(m[1]);
      if (!t) continue;
      // Sinds v2 wijst dit naar het audio/-gebied. Staat de track er niet in
      // (bestand onvindbaar), dan blijft het veld LEEG in plaats van naar een
      // bijlage te wijzen die er niet is.
      const bestand = audioKaart.get(t.id) || undefined;
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

/**
 * De HELE audiobibliotheek, plus de playlists.
 *
 * Tot v1 ging alleen mee wat met [[track:]] in een bericht stond. Op
 * sound-fabrics.com waren dat er 14 van de 140, en de 11 playlists gingen
 * helemaal niet mee. Een verhuizing die je bibliotheek achterlaat is geen
 * verhuizing.
 *
 * Het bestand wordt gezocht met resolveAudioPath, dus op DEZELFDE manier als de
 * speler het zoekt. Dat verschil was de stille moordenaar: 124 van de 139
 * storage_paths waren verouderd na een dataverhuizing, de site speelde gewoon
 * door, en de export liet ze weg zonder dat iemand het merkte.
 *
 * @returns {Map<string,string>} trackId -> pad in het archief
 */
/**
 * Een hoes in het archief leggen.
 *
 * cover_url reisde wel mee als STRING en het bestand niet, dus kwam een track
 * aan met een verwijzing naar een plaatje dat er niet was. Precies dezelfde
 * fout als bij de audio zelf, een laag hoger: een verwijzing zonder bytes.
 *
 * @returns {string|null} het pad in het archief, of null
 */
function hoesToevoegen(url, origin, bestanden, tellingen) {
  const schijf = localMediaPath(url, origin);
  if (!schijf) return null;
  let bytes = null;
  try { bytes = fs.readFileSync(schijf); } catch { return null; }
  const hash = sha256(bytes);
  const naam = `media/${hash}${extOf(url) ? `.${extOf(url)}` : ''}`;
  if (!bestanden.has(naam)) { bestanden.set(naam, bytes); tellingen.media += 1; }
  return naam;
}

function audioBibliotheek(site, origin, bestanden, tellingen, ontbrekend) {
  const kaart = new Map();
  let tracks = [];
  try {
    tracks = db.prepare(`SELECT t.*, m.storage_path, m.mime_type FROM audio_tracks t
                          LEFT JOIN media m ON m.id = t.media_id
                         WHERE t.site_id = ?
                         ORDER BY COALESCE(t.position, 999999), t.created_at, t.id`).all(site.id);
  } catch { return kaart; }              // installatie zonder audio-tabellen
  if (!tracks.length) return kaart;

  const items = [];
  for (const t of tracks) {
    const schijf = resolveAudioPath(t.storage_path, fs);
    let naam = null;
    let hash = null;
    if (schijf) {
      try {
        const bytes = fs.readFileSync(schijf);
        hash = sha256(bytes);
        const ext = (path.extname(schijf).slice(1) || 'mp3').toLowerCase();
        naam = `audio/${hash}.${ext}`;
        if (!bestanden.has(naam)) { bestanden.set(naam, bytes); tellingen.audio += 1; }
        kaart.set(t.id, naam);
      } catch { naam = null; }           // onleesbaar telt als ontbrekend, niet als stilte
    }
    if (!naam) {
      tellingen.audioMissing += 1;
      ontbrekend.push({ track: t.title || t.id, url: t.storage_path || '(geen mediarij)' });
    }
    items.push({
      id: t.id, name: t.title || '', artist: t.artist || undefined, album: t.album || undefined,
      duration: t.duration || undefined, position: t.position ?? undefined,
      credit: t.credit || undefined, license: t.license || undefined,
      'shaer:coverUrl': t.cover_url || undefined,
      // De BYTES van de hoes, niet alleen de verwijzing.
      'shaer:coverFile': hoesToevoegen(t.cover_url, origin, bestanden, tellingen) || undefined,
      'shaer:downloadable': t.downloadable ? 1 : 0,
      'shaer:fediOpen': t.fedi_open ? 1 : 0,
      'shaer:mediaType': t.mime_type || 'audio/mpeg',
      'shaer:file': naam || undefined,
      'shaer:sha256': hash || undefined,
      // Derde staat, net als bij media: we weten DAT het bestond en waar het
      // stond. Stil weglaten zou een leugen zijn, en de importer moet hierop
      // kunnen weigeren in plaats van een track zonder bestand aan te maken.
      'shaer:availability': naam ? 'included' : 'missing',
      'shaer:originalPath': naam ? undefined : (t.storage_path || undefined),
      url: [t.link_spotify, t.link_youtube, t.link_soundcloud].filter(Boolean),
    });
  }
  bestanden.set('tracks.json', Buffer.from(stableJson({
    '@context': ['https://www.w3.org/ns/activitystreams', { shaer: 'https://klonkt.com/ns#' }],
    type: 'OrderedCollection', 'shaer:archive': true, totalItems: items.length, orderedItems: items,
  }), 'utf8'));
  tellingen.tracks = items.length;

  // Playlists: de volgorde IS de playlist, dus die moet expliciet mee.
  try {
    const pls = db.prepare('SELECT * FROM playlists WHERE site_id = ? ORDER BY created_at, id').all(site.id);
    if (pls.length) {
      const lijst = pls.map((p) => ({
        id: p.id, name: p.title || '', artist: p.artist || undefined, year: p.year || undefined,
        'shaer:kind': p.kind || undefined, 'shaer:coverUrl': p.cover_url || undefined,
        'shaer:coverFile': hoesToevoegen(p.cover_url, origin, bestanden, tellingen) || undefined,
        'shaer:tracks': db.prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
          .all(p.id).map((r) => ({ id: r.track_id, position: r.position })),
      }));
      bestanden.set('playlists.json', Buffer.from(stableJson({
        '@context': ['https://www.w3.org/ns/activitystreams', { shaer: 'https://klonkt.com/ns#' }],
        type: 'OrderedCollection', 'shaer:archive': true, totalItems: lijst.length, orderedItems: lijst,
      }), 'utf8'));
      tellingen.playlists = lijst.length;
    }
  } catch { /* geen playlist-tabellen */ }

  return kaart;
}

/** Eén post als AS2-object volgens het formaat. Bijlagen komen van de beller. */
function postObject(post, site, origin, attachments, audioKaart) {
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
    'shaer:audio': audioOf(post, audioKaart),
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

// ── Wie je volgt, als CSV ─────────────────────────────────────────
//
// Kolomvorm van Mastodon, zodat deze lijst ook DAAR te importeren is en die van
// daar hier. Dat is het hele punt van een verhuisformaat: het moet ook werken
// als je naar iets anders vertrekt dan waar je vandaan kwam.
//
//   Account address,Show boosts,Notify on new posts,Languages,Featured
//
// `Featured` is onze kolom en draagt `auto_boost`: het vinkje dat in de UI
// "Uitgelicht" heet (tl.autoboost) en hun posts in jouw Cirkel laat meelopen.
//
// `Show boosts` blijft LEEG. Dat is bij Mastodon "toon de reblogs van deze
// persoon in mijn tijdlijn", en dat kent Klonkt niet. De verleiding is groot om
// er auto_boost in te schrijven omdat in beide het woord boost zit, maar het is
// een ander ding: dat van ons gaat over hun eigen posts in JOUW Cirkel, niet
// over andermans posts die zij doorgeven. `Notify` en `Languages` kent Klonkt
// evenmin. Die drie staan er omdat Mastodon de POSITIES telt.
const CSV_KOP = 'Account address,Show boosts,Notify on new posts,Languages,Featured';

/** Een veld dat een komma, aanhalingsteken of nieuwe regel bevat moet geciteerd. */
function csvVeld(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * De volglijst van een site als CSV, of null als er niets te melden valt.
 *
 * Alleen `accepted`: een openstaand verzoek is geen relatie, en het opnieuw
 * versturen ervan op de nieuwe plek zou een tweede verzoek zijn bij iemand die
 * de eerste misschien bewust liet liggen.
 *
 * Het adres is de handle zonder de leidende @, want zo schrijft Mastodon hem.
 * Ontbreekt de handle, dan valt hij terug op de actor-URI: die is altijd te
 * herleiden, ook als de webfinger-naam ooit verloren ging.
 */
export function followingCsv(slug) {
  let rijen = [];
  try {
    rijen = db.prepare(`SELECT actor_uri, handle, auto_boost FROM ap_following
                         WHERE slug = ? AND status = 'accepted'
                         ORDER BY handle IS NULL, handle, actor_uri`).all(slug);
  } catch { return null; }        // oude database zonder de kolom
  if (!rijen.length) return null;
  const regels = rijen.map((r) => [
    csvVeld((r.handle || r.actor_uri || '').replace(/^@/, '')),
    '',                                    // Show boosts: niet van ons
    '',                                    // Notify on new posts: idem
    '',                                    // Languages: idem
    r.auto_boost ? 'true' : 'false',       // Featured: het vinkje "Uitgelicht"
  ].join(','));
  return `${CSV_KOP}\n${regels.join('\n')}\n`;
}

/**
 * Lees zo'n CSV terug. Puur, zodat de vorm te toetsen is zonder database.
 *
 * Vergeeflijk met opzet: een bestand uit Mastodon heeft vier kolommen en geen
 * `Featured`, een handgemaakt bestand heeft misschien alleen adressen. Beide
 * moeten werken, want anders is het geen uitwisselformaat maar een eigen
 * bestandje dat toevallig op een CSV lijkt.
 */
export function parseFollowingCsv(text) {
  const uit = [];
  const regels = String(text || '').split(/\r?\n/).filter((r) => r.trim());
  if (!regels.length) return uit;
  // Een kopregel herkennen we aan het eerste veld; anders is regel 1 al data.
  const start = /^\s*"?account address"?\s*(,|$)/i.test(regels[0]) ? 1 : 0;
  for (const regel of regels.slice(start)) {
    const velden = splitsCsvRegel(regel);
    const adres = (velden[0] || '').trim().replace(/^@/, '');
    if (!adres) continue;
    uit.push({
      address: adres,
      // Alleen kolom 5. Een bestand uit Mastodon heeft die niet en levert dus
      // `false`, en dat is juist: hun "Show boosts" in kolom 2 gaat over iets
      // anders en mag hier niet als uitgelicht binnenkomen.
      featured: /^(true|1|yes)$/i.test((velden[4] || '').trim()),
    });
  }
  return uit;
}

/** Eén CSV-regel, met respect voor geciteerde velden en verdubbelde aanhalingstekens. */
function splitsCsvRegel(regel) {
  const velden = [];
  let veld = '';
  let inCitaat = false;
  for (let i = 0; i < regel.length; i++) {
    const c = regel[i];
    if (inCitaat) {
      if (c === '"') {
        if (regel[i + 1] === '"') { veld += '"'; i++; } else inCitaat = false;
      } else veld += c;
    } else if (c === '"') inCitaat = true;
    else if (c === ',') { velden.push(veld); veld = ''; }
    else veld += c;
  }
  velden.push(veld);
  return velden;
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
  if (!site) {
    // De naam van de INSTANCE (de map, de unit) en de slug van de SITE in zijn
    // database zijn twee dingen. Ze vallen vaak samen en soms niet, en dan zat je
    // met een foutmelding die je liet raden. Zeg dus wat er wel in staat.
    let bestaand = [];
    try { bestaand = db.prepare('SELECT slug FROM sites ORDER BY rowid').all().map((r) => r.slug); } catch { /* geen sites-tabel */ }
    const wat = slug ? `onbekende site: ${slug}` : 'geen site opgegeven';
    throw new Error(bestaand.length
      ? `${wat}. In deze database staat: ${bestaand.join(', ')}`
      : `${wat}. In deze database staat geen enkele site -- wijst DATABASE_PATH naar de juiste?`);
  }

  const bestanden = new Map();       // pad -> Buffer
  const tellingen = { posts: 0, replies: 0, media: 0, mediaMissing: 0, audio: 0, audioMissing: 0, tracks: 0, playlists: 0 };
  const ontbrekend = [];             // voor de rapportage van de beller

  // De audiobibliotheek EERST. De posts verwijzen ernaar met [[track:]], dus de
  // kaart moet klaar zijn voor de eerste post gebouwd wordt.
  const audioKaart = audioBibliotheek(site, origin, bestanden, tellingen, ontbrekend);

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

    const obj = postObject(post, site, origin, attachments, audioKaart);
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

  // Wie je volgt. Dit ontbrak, en daarmee was een "verhuizing" halfslachtig: de
  // Move vertelt je VOLGERS waar je heen ging, maar niets vertelde JOU wie jij
  // volgde. Die lijst stond alleen in de oude database, en die laat je achter.
  const volgCsv = followingCsv(slug);
  if (volgCsv) { bestanden.set('following.csv', Buffer.from(volgCsv, 'utf8')); tellingen.following = volgCsv.trim().split('\n').length - 1; }

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
