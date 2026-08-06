/**
 * Herstel uit de tijdlijn-cache van een ANDERE Klonkt (shaer-l1v).
 *
 * De aanleiding: boiert.eu verloor zijn database. De posts staan nog in de
 * ap_timeline van instances die boiert volgen, en die tabel sleutelt op de
 * OORSPRONKELIJKE AP-object-URI. De identiteiten overleven dus, en dat is het
 * verschil tussen herstellen en opnieuw posten: boosts, likes en antwoorden
 * elders wijzen naar die ids.
 *
 * Dit maakt geen posts aan. Het maakt een ARCHIEF in het formaat uit
 * docs/EXPORT-FORMAT.md, zodat het door dezelfde importer gaat als een gewone
 * export -- inclusief droogloop, versiecontrole en de regel rond AP-ids. Een
 * apart herstelpad zou een tweede implementatie zijn van iets dat al bestaat.
 *
 * WAT ER PRINCIPIEEL NIET IN ZIT, en dat hoort in de verwachting te staan
 * voordat iemand eraan begint:
 *
 *   - ANTWOORDEN van de verloren site zelf. belongsInTimeline() weigert alles
 *     met een inReplyTo, dus die zijn nooit in een tijdlijn-cache beland.
 *   - alles van VOOR het moment dat de bron ging volgen.
 *   - CONCEPTEN. Nooit gefedereerd, dus nergens gecachet.
 *   - de content is de FEDERATIE-projectie: gesaneerd door de sanitizer van de
 *     bron, met de titel in de tekst gebakken en de afbeeldingen uit de body
 *     gehaald. Waar ze in de tekst stonden is niet te herstellen.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { stableJson, FORMAT_VERSION } from './ArchiveExportService.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
};
const extOf = (u) => ((String(u).split('?')[0].match(/\.(\w+)$/) || [])[1] || '').toLowerCase();
const mimeOf = (u, opgegeven) => opgegeven || MIME_BY_EXT[extOf(u)] || 'application/octet-stream';
const as2TypeOf = (m) => (m.startsWith('video/') ? 'Video' : m.startsWith('audio/') ? 'Audio' : 'Image');

/**
 * De titel terugvissen uit de tekst.
 *
 * buildNote() zet de titel als eerste alinea in de content -- `<p><strong>...`
 * -- omdat Mastodon `name` negeert. In de cache staat dus de gefedereerde vorm,
 * en zonder deze stap komt elke post titelloos terug met zijn titel als vetgedrukte
 * eerste regel in de body.
 *
 * Er is GEEN sluitend signaal. De slug is niet van de titel afgeleid (op echte
 * data: titel "Back to 1987!", slug "waiting-on-you"), dus we moeten op de vorm
 * afgaan: een openende alinea die niets anders bevat dan vetgedrukte platte
 * tekst. Een post die echt zo begint verliest die regel naar zijn titel. Vandaar
 * dat de beller een lijst terugkrijgt van alles wat is losgetrokken -- dat hoort
 * een mens na te lopen, niet een script.
 */
export function splitsTitel(html) {
  const m = String(html || '').match(/^\s*<p>\s*<strong>([^<>]+)<\/strong>\s*<\/p>/i);
  if (!m) return { titel: null, rest: html || '' };
  const titel = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  if (!titel) return { titel: null, rest: html || '' };
  return { titel, rest: String(html).slice(m[0].length) };
}

/**
 * Van een URL naar een bestand op de geredde schijf.
 *
 * Twee routes, en de tweede was bijna vergeten: gewone media gaan via /media/ op
 * MEDIA_ROOT, maar GEHOSTE AUDIO gaat via /audio/stream/<bestandsnaam> op
 * AUDIO_DIR -- een andere map. Op echte cachedata van een muzieksite is dat geen
 * randgeval maar de helft van de bijlagen.
 */
function schijfPad(url, origin, mediaRoot, audioRoot) {
  let p = String(url || '');
  if (/^https?:/i.test(p)) {
    try {
      const u = new URL(p);
      if (origin && `${u.protocol}//${u.host}` !== origin) return null;
      p = u.pathname;
    } catch { return null; }
  }
  const onder = (root, rest) => {
    if (!root) return null;
    const abs = path.resolve(root, decodeURIComponent(rest));
    const r = path.resolve(root);
    return (abs !== r && abs.startsWith(`${r}${path.sep}`)) ? abs : null;
  };
  if (p.startsWith('/media/')) return onder(mediaRoot, p.slice('/media/'.length));
  if (p.startsWith('/audio/stream/')) return onder(audioRoot, p.slice('/audio/stream/'.length));
  return null;
}

const parse = (s, val = null) => { try { return JSON.parse(s) || val; } catch { return val; } };

/**
 * Bouw een archief uit een of meer tijdlijn-caches.
 *
 * @param {object} opts
 *   sources   paden naar de database(s) van instances die de verloren site volgen
 *   actorUri  de actor van de verloren site, bv. https://boiert.eu/ap/users/boiert
 *   mediaRoot de geredde mediamap van de verloren site (optioneel)
 *   houdTitelInTekst  laat de titel staan waar hij staat
 */
export function recoverFromCache(opts = {}) {
  const { sources = [], actorUri, mediaRoot = null, houdTitelInTekst = false } = opts;
  // AUDIO_PATH staat naast MEDIA_PATH, niet erin. Zonder eigen opgave nemen we de
  // buurmap van de mediamap, want dat is de standaardindeling van storage/.
  const audioRoot = opts.audioRoot || (mediaRoot ? path.join(path.dirname(path.resolve(mediaRoot)), 'audio') : null);
  if (!actorUri) throw new Error('actorUri is verplicht: zonder actor weten we niet wiens posts we redden');
  const origin = (opts.origin || (() => { try { const u = new URL(actorUri); return `${u.protocol}//${u.host}`; } catch { return ''; } })()).replace(/\/+$/, '');
  if (!origin) throw new Error('kan de origin niet afleiden uit de actorUri');

  const rapport = {
    bronnen: [], posts: 0, titels: [], media: 0, mediaMissing: 0, gemist: [],
    overgeslagen: 0, oudste: null, nieuwste: null, waarschuwingen: [],
  };

  // Beste rij per AP-id. Meerdere bronnen dekken verschillende periodes, en
  // dezelfde post kan in meer dan een tijdlijn staan; de rijkste versie wint.
  const beste = new Map();
  for (const bron of sources) {
    let n = 0;
    let sdb;
    try { sdb = new Database(bron, { readonly: true, fileMustExist: true }); }
    catch (e) { rapport.waarschuwingen.push(`${bron}: niet te openen (${e.message})`); continue; }
    let rijen = [];
    try { rijen = sdb.prepare('SELECT * FROM ap_timeline WHERE author_uri = ?').all(actorUri); }
    catch (e) { rapport.waarschuwingen.push(`${bron}: geen bruikbare ap_timeline (${e.message})`); }
    for (const r of rijen) {
      // Een boost VAN een ander staat op naam van de oorspronkelijke auteur, dus
      // author_uri filtert die al weg. Een boost van ONZE post door een ander is
      // wel van ons -- die houden we, maar zonder de booster.
      const vorige = beste.get(r.id);
      if (!vorige || String(r.content || '').length > String(vorige.content || '').length) beste.set(r.id, r);
      n += 1;
    }
    sdb.close();
    rapport.bronnen.push({ pad: bron, rijen: n });
  }

  const files = new Map();
  const ids = [...beste.keys()].sort();

  for (const apId of ids) {
    const r = beste.get(apId);
    const postId = decodeURIComponent(String(apId).split('/ap/notes/')[1] || '');
    if (!postId) { rapport.overgeslagen += 1; continue; }
    let slug = postId;
    try { const u = new URL(r.url || ''); slug = decodeURIComponent(u.pathname.replace(/^\//, '')) || postId; } catch { /* val terug op het id */ }

    const gesplitst = houdTitelInTekst ? { titel: null, rest: r.content || '' } : splitsTitel(r.content);
    if (gesplitst.titel) rapport.titels.push({ slug, titel: gesplitst.titel });

    // Bijlagen. De cache bewaart alleen URL's; de VOLGORDE is die van buildNote,
    // waarin de cover voorop gaat. Meer signaal is er niet, dus de eerste krijgt
    // de rol cover en de rest wordt bijlage. Waar ze in de tekst stonden is bij
    // het federeren verloren gegaan en komt niet terug.
    const attachments = [];
    const lijst = parse(r.media_json, []) || [];
    lijst.forEach((m, i) => {
      const url = m && (m.url || m.href);
      if (!url) return;
      const mime = mimeOf(url, m.type && String(m.type).includes('/') ? m.type : null);
      const rol = i === 0 ? 'cover' : 'c2s';
      const bestand = schijfPad(url, origin, mediaRoot, audioRoot);
      let bytes = null;
      if (bestand) { try { bytes = fs.readFileSync(bestand); } catch { bytes = null; } }
      if (bytes) {
        const hash = sha256(bytes);
        const naam = `media/${hash}${extOf(url) ? `.${extOf(url)}` : ''}`;
        if (!files.has(naam)) { files.set(naam, bytes); rapport.media += 1; }
        attachments.push({
          type: as2TypeOf(mime), mediaType: mime, name: m.name || m.alt || undefined,
          url: naam, 'shaer:availability': 'included',
          'shaer:originalUrl': /^https?:/i.test(url) ? url : `${origin}${url}`,
          'shaer:sha256': hash, 'shaer:role': rol,
        });
      } else {
        rapport.mediaMissing += 1;
        rapport.gemist.push({ slug, url });
        attachments.push({
          type: as2TypeOf(mime), mediaType: mime, name: m.name || m.alt || undefined,
          url: /^https?:/i.test(url) ? url : `${origin}${url}`,
          'shaer:availability': 'missing',
          'shaer:originalUrl': /^https?:/i.test(url) ? url : `${origin}${url}`,
          'shaer:role': rol,
        });
      }
    });

    const poll = parse(r.poll_json);
    const quote = parse(r.quote_json);
    const opties = poll && Array.isArray(poll.options) && poll.options.length >= 2
      ? poll.options.map((o) => ({ type: 'Note', name: String(o && o.name != null ? o.name : o) })) : null;

    const obj = {
      '@context': ['https://www.w3.org/ns/activitystreams', { shaer: 'https://klonkt.com/ns#', toot: 'http://joinmastodon.org/ns#', Hashtag: 'as:Hashtag', sensitive: 'as:sensitive' }],
      id: apId,
      type: opties ? 'Question' : (gesplitst.titel ? 'Article' : 'Note'),
      attributedTo: actorUri,
      name: gesplitst.titel || undefined,
      content: gesplitst.rest,
      summary: r.cw || undefined,
      sensitive: r.nsfw ? true : undefined,
      published: r.published || undefined,
      url: r.url || `${origin}/${encodeURIComponent(slug)}`,
      attachment: attachments.length ? attachments : undefined,
      ...(opties ? (poll.multiple ? { anyOf: opties } : { oneOf: opties }) : {}),
      endTime: opties ? (poll.endTime || undefined) : undefined,
      closed: (opties && poll.closed) ? true : undefined,
      quoteUrl: (quote && (quote.url || quote.uri || quote.id)) || undefined,
      'shaer:slug': slug,
      'shaer:status': 'published',      // alles wat gefedereerd is, was gepubliceerd
      'shaer:recoveredFrom': 'timeline-cache',
    };
    files.set(`posts/${postId}.json`, Buffer.from(stableJson(obj), 'utf8'));
    files.set(`readable/${slug}.md`, Buffer.from(
      `---\ntitle: ${JSON.stringify(gesplitst.titel || slug)}\nslug: ${JSON.stringify(slug)}\ndate: ${r.published || ''}\nrecovered: timeline-cache\n---\n${gesplitst.rest}\n`, 'utf8'));
    rapport.posts += 1;
    if (r.published) {
      if (!rapport.oudste || r.published < rapport.oudste) rapport.oudste = r.published;
      if (!rapport.nieuwste || r.published > rapport.nieuwste) rapport.nieuwste = r.published;
    }
  }

  const bestandsHashes = {};
  for (const pad of [...files.keys()].sort()) bestandsHashes[pad] = sha256(files.get(pad));
  const manifest = {
    formatVersion: FORMAT_VERSION,
    generator: `klonkt-recovery/${opts.version || 'dev'}`,
    exportedAt: opts.exportedAt || new Date().toISOString(),
    origin,
    actor: actorUri,
    site: { slug: opts.slug || '', title: opts.title || '' },
    counts: { posts: rapport.posts, replies: 0, media: rapport.media, mediaMissing: rapport.mediaMissing },
    files: bestandsHashes,
    // Zodat niemand dit later voor een gewone export aanziet: dit archief is
    // gereconstrueerd uit andermans cache en is per definitie onvolledig.
    'shaer:recovered': {
      from: 'timeline-cache',
      sources: rapport.bronnen.map((b) => path.basename(b.pad)),
      window: { oldest: rapport.oudste, newest: rapport.nieuwste },
      missing: ['replies by this actor', 'posts from before the source followed', 'drafts'],
    },
  };
  files.set('manifest.json', Buffer.from(stableJson(manifest), 'utf8'));

  return { files, manifest, rapport };
}
