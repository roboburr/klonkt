/**
 * Import van een draagbaar inhoudsarchief (shaer-pmr).
 *
 * Leest wat docs/EXPORT-FORMAT.md beschrijft. Vier regels uit dat document zijn
 * geen implementatiekeuze maar eis, en ze staan hier alle vier expliciet:
 *
 *   VERSIE EERST   Een hogere onbekende formatVersion wordt in zijn GEHEEL
 *                  geweigerd. Een half begrepen herstel is erger dan geen
 *                  herstel, want het ziet eruit alsof het gelukt is.
 *   IDENTITEIT     De origin uit het manifest bepaalt of de AP-ids behouden
 *                  blijven. Dat is geen vraag aan de gebruiker: een verkeerd
 *                  antwoord publiceert objecten onder een id dat je niet beheert.
 *   NIETS STILS    Ontbrekende media worden geteld en gemeld.
 *   GEEN UITZENDING Geen Update de fediverse in. Verouderde kopieen elders
 *                  rechttrekken is een aparte, bewuste actie.
 *
 * `readable/` wordt nooit gelezen. Dat is de hele reden dat het afgeleid is.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import db from '../config/database.js';
import { MEDIA_ROOT } from '../config/paths.js';
import { FORMAT_VERSION, parseFollowingCsv } from './ArchiveExportService.js';
import * as Migration from './MigrationService.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// De tijdstempel gaat er ONGEWIJZIGD in. Omzetten naar SQL-notatie kostte de
// sub-seconde, en twee posts in dezelfde seconde staan dan in willekeurige
// volgorde. Klonkt schrijft zelf ook ISO in deze kolommen.
const tijd = (iso) => (iso && !isNaN(Date.parse(iso)) ? String(iso) : null);

// ── Inlezen ───────────────────────────────────────────────────────

/** Lees een archiefmap in als pad -> Buffer. */
export function readArchiveDir(dir) {
  const files = new Map();
  const loop = (sub) => {
    for (const naam of fs.readdirSync(path.join(dir, sub), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = sub ? `${sub}/${naam.name}` : naam.name;
      if (naam.isDirectory()) loop(rel);
      else files.set(rel, fs.readFileSync(path.join(dir, rel)));
    }
  };
  loop('');
  return files;
}

/**
 * Lees een zip in. Onze eigen export is store-only, maar een archief dat elders
 * gemaakt is mag deflate gebruiken -- anders is het geen uitwisselformaat.
 */
export function readArchiveZip(buf) {
  const files = new Map();
  const eocd = (() => {
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
    return -1;
  })();
  if (eocd < 0) throw new Error('geen zip: het eind-record ontbreekt');
  const aantal = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < aantal; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('beschadigde zip: centrale ingang klopt niet');
    const methode = buf.readUInt16LE(p + 10);
    const gecomp = buf.readUInt32LE(p + 20);
    const naamLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lokaalOffset = buf.readUInt32LE(p + 42);
    const naam = buf.toString('utf8', p + 46, p + 46 + naamLen);
    const lNaam = buf.readUInt16LE(lokaalOffset + 26);
    const lExtra = buf.readUInt16LE(lokaalOffset + 28);
    const start = lokaalOffset + 30 + lNaam + lExtra;
    const rauw = buf.subarray(start, start + gecomp);
    if (!naam.endsWith('/')) {
      files.set(naam, methode === 8 ? zlib.inflateRawSync(rauw) : Buffer.from(rauw));
    }
    p += 46 + naamLen + extraLen + commentLen;
  }
  return files;
}

export function readArchive(bron) {
  const st = fs.statSync(bron);
  return st.isDirectory() ? readArchiveDir(bron) : readArchiveZip(fs.readFileSync(bron));
}

// ── Importeren ────────────────────────────────────────────────────

/** Een pad onder MEDIA_ROOT houden. Een archief van elders is invoer, geen vriend. */
function veiligMediaPad(urlPad) {
  if (!urlPad || !urlPad.startsWith('/media/')) return null;
  const abs = path.resolve(MEDIA_ROOT, decodeURIComponent(urlPad.slice('/media/'.length)));
  const root = path.resolve(MEDIA_ROOT);
  return (abs !== root && abs.startsWith(`${root}${path.sep}`)) ? abs : null;
}

/** Het pad-deel van een originele media-URL, of null als het er niet een van ons is. */
function padVanOrigineel(u) {
  const s = String(u || '');
  if (s.startsWith('/media/')) return s;
  try { const x = new URL(s); return x.pathname.startsWith('/media/') ? x.pathname : null; } catch { return null; }
}

/**
 * Waar deze bijlage komt te staan, als site-relatief pad.
 *
 * Meestal zijn oorspronkelijke plek en bestemming gelijk. Maar een bestand dat
 * ELDERS werd geserveerd -- gehoste audio ging via /audio/stream/ -- heeft geen
 * plek onder /media. Zonder een bestemming zou het bestand wel worden
 * weggeschreven en toch uit de kolommen verdwijnen. Nu krijgt het een eigen hoek,
 * en verwijzen de kolommen daarheen.
 */
function bestemming(a) {
  return padVanOrigineel(a && a['shaer:originalUrl']) || `/media/archief/${path.basename(String((a && a.url) || ''))}`;
}

/**
 * Volg opnieuw wie je volgde, uit de `following.csv` van een archief.
 *
 * BEWUST BUITEN importArchive. Die draait in één transactie en raakt alleen de
 * database; opnieuw volgen stuurt Follow-activiteiten de deur uit en wacht op
 * het netwerk. Dat hoort niet in een transactie: een trage peer houdt hem open,
 * en een rollback neemt verzonden activiteiten niet terug.
 *
 * Ook een aparte, expliciete stap omdat een archief inlezen stil is maar negen
 * mensen aanschrijven niet. Dat mag geen bijwerking zijn van een import.
 *
 * `followFn` is injecteerbaar, zodat de test geen netwerk raakt en dit bestand
 * ActivityPubService niet hoeft te importeren.
 */
export async function importFollowing(site, csvText, { followFn = null } = {}) {
  const rijen = parseFollowingCsv(csvText);
  const rapport = { totaal: rijen.length, gevolgd: 0, overgeslagen: 0, mislukt: [] };
  if (!followFn) return { ...rapport, error: 'no_follow_fn' };
  for (const r of rijen) {
    // Jezelf volgen is geen relatie maar een lus. Kan echt gebeuren bij een
    // archief van een instance die je onder een nieuwe naam opnieuw opzet.
    if (site && site.slug && r.address.startsWith(`${site.slug}@`)) { rapport.overgeslagen += 1; continue; }
    try {
      // De uitgelicht-stand gaat MEE in de Follow zelf: followActor neemt hem
      // als derde argument en zet auto_boost bij het aanmaken van de rij. Een
      // aparte UPDATE erna zou een tweede pad zijn naar dezelfde vlag, en dan
      // kan er precies een halve toestand ontstaan als die faalt.
      const ok = await followFn(site, r.address, r.featured);
      if (ok === false) { rapport.mislukt.push({ adres: r.address, reden: 'geweigerd' }); continue; }
      rapport.gevolgd += 1;
    } catch (e) {
      rapport.mislukt.push({ adres: r.address, reden: (e && e.message) || 'onbekend' });
    }
  }
  return rapport;
}

/**
 * Zet een archief terug in een site.
 *
 * @param {Map<string,Buffer>} files  het ingelezen archief
 * @param {object} opts  { slug, dryRun, overwrite, origin }
 */
export function importArchive(files, opts = {}) {
  const rapport = {
    formatVersion: null, origin: null, idsBehouden: null,
    posts: 0, overgeslagen: 0, overschreven: 0,
    replies: 0, media: 0, mediaMissing: 0, gemist: [], waarschuwingen: [],
  };

  const manifestBuf = files.get('manifest.json');
  if (!manifestBuf) throw new Error('geen manifest.json: dit is geen inhoudsarchief');
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  rapport.formatVersion = manifest.formatVersion;

  // VERSIE EERST, voordat er ook maar iets gelezen wordt.
  if (!Number.isInteger(manifest.formatVersion)) throw new Error('manifest zonder bruikbare formatVersion');
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new Error(`archiefversie ${manifest.formatVersion} is nieuwer dan deze Klonkt kent (${FORMAT_VERSION}); geweigerd`);
  }

  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(opts.slug);
  if (!site) {
    // De naam van de INSTANCE (de map, de unit) en de slug van de SITE in zijn
    // database zijn twee dingen. Ze vallen vaak samen en soms niet, en dan zat je
    // met een foutmelding die je liet raden. Zeg dus wat er wel in staat.
    let bestaand = [];
    try { bestaand = db.prepare('SELECT slug FROM sites ORDER BY rowid').all().map((r) => r.slug); } catch { /* geen sites-tabel */ }
    const wat = opts.slug ? `onbekende site: ${opts.slug}` : 'geen site opgegeven';
    throw new Error(bestaand.length
      ? `${wat}. In deze database staat: ${bestaand.join(', ')}`
      : `${wat}. In deze database staat geen enkele site -- wijst DATABASE_PATH naar de juiste?`);
  }
  const eigenOrigin = (opts.origin || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  rapport.origin = manifest.origin || null;

  // IDENTITEIT. Gelijke origin -> de AP-ids blijven, en daarmee vinden de boosts
  // en antwoorden die er al naar wijzen hun post terug. Anders nieuwe ids, want
  // een id op andermans domein publiceren is een vervalsingsoppervlak en andere
  // servers halen het daar toch op.
  const idsBehouden = !!(manifest.origin && eigenOrigin && manifest.origin === eigenOrigin);
  rapport.idsBehouden = idsBehouden;
  if (!idsBehouden) {
    rapport.waarschuwingen.push(
      `origin verschilt (archief ${manifest.origin || '?'} vs deze site ${eigenOrigin || '?'}): nieuwe AP-ids, de oude blijven als verwijzing staan`,
    );
  }

  const postPaden = [...files.keys()].filter((p) => p.startsWith('posts/') && p.endsWith('.json')).sort();
  const bestaatId = db.prepare('SELECT 1 FROM posts WHERE id = ?');
  const bestaatSlug = db.prepare('SELECT id FROM posts WHERE site_id = ? AND slug = ?');
  const idKaart = new Map();     // oud post-id -> nieuw post-id

  const schrijf = [];            // alles eerst uitrekenen, dan in EEN transactie

  for (const pad of postPaden) {
    const o = JSON.parse(files.get(pad).toString('utf8'));
    const oudId = decodeURIComponent(String(o.id || '').split('/ap/notes/')[1] || path.basename(pad, '.json'));
    const nieuwId = idsBehouden ? oudId : randomUUID();
    idKaart.set(oudId, nieuwId);

    const botsing = !!bestaatId.get(nieuwId) || !!bestaatSlug.get(site.id, o['shaer:slug']);
    if (botsing && !opts.overwrite) {
      // EEN gedocumenteerde regel, geen gok per post: bestaande inhoud wordt niet
      // overschreven tenzij dat expliciet gevraagd is. Dit is ook wat de import
      // idempotent maakt.
      rapport.overgeslagen += 1;
      continue;
    }
    if (botsing) rapport.overschreven += 1;

    // Media: terug naar hun oorspronkelijke plek onder /media, want de content
    // van de post verwijst daarnaar. Dat pad is site-relatief, dus het werkt ook
    // op een ander domein.
    for (const a of (Array.isArray(o.attachment) ? o.attachment : [])) {
      if (a['shaer:availability'] === 'missing') {
        rapport.mediaMissing += 1;
        rapport.gemist.push({ post: o['shaer:slug'], url: a['shaer:originalUrl'] || a.url });
        continue;
      }
      const bytes = files.get(a.url);
      if (!bytes) {
        // Het archief zegt 'included' maar het bestand ontbreekt. Dat is een kapot
        // archief, geen ontbrekende media -- apart melden, niet stil optellen.
        rapport.waarschuwingen.push(`archief verwijst naar ${a.url}, dat er niet in zit`);
        continue;
      }
      if (a['shaer:sha256'] && sha256(bytes) !== a['shaer:sha256']) {
        rapport.waarschuwingen.push(`${a.url}: checksum klopt niet, overgeslagen`);
        continue;
      }
      const doel = veiligMediaPad(bestemming(a));
      if (!doel) { rapport.waarschuwingen.push(`${a.url}: onbruikbaar doelpad, overgeslagen`); continue; }
      schrijf.push({ soort: 'media', doel, bytes });
      rapport.media += 1;
    }

    schrijf.push({ soort: 'post', id: nieuwId, oudId, obj: o, oudeUri: o.id || null });
    rapport.posts += 1;
  }

  // Antwoorden: alleen-lezen archief. Nooit opnieuw bezorgd, geen meldingen.
  for (const pad of [...files.keys()].filter((p) => p.startsWith('replies/')).sort()) {
    const coll = JSON.parse(files.get(pad).toString('utf8'));
    if (coll['shaer:archive'] !== true) {
      rapport.waarschuwingen.push(`${pad}: niet gemarkeerd als archief, overgeslagen`);
      continue;
    }
    const oudId = path.basename(pad, '.json');
    const postId = idKaart.get(oudId);
    if (!postId) continue;                       // post overgeslagen -> antwoorden ook
    for (const it of (coll.orderedItems || [])) {
      schrijf.push({ soort: 'reply', postId, it });
      rapport.replies += 1;
    }
  }

  if (opts.dryRun) return rapport;

  // Schrijven pas nu, in EEN transactie: een half ingelezen archief is de ergste
  // uitkomst, want dan lijkt het gelukt.
  const insPost = db.prepare(`INSERT OR REPLACE INTO posts
    (id, site_id, slug, author_id, title, content, excerpt, status, cover_image_url, cover_alt, cover_video_url,
     pinned, type, tags, published_at, created_at, updated_at, noindex, publish_at, fan_only, nsfw, language,
     content_warning, poll_json, quote_uri, quote_actor, ap_visibility, paid, paid_min_cents, view_count, c2s_attachments, origin_server)
    VALUES (@id, @site_id, @slug, @author_id, @title, @content, @excerpt, @status, @cover_image_url, @cover_alt, @cover_video_url,
     @pinned, @type, @tags, @published_at, @created_at, @updated_at, @noindex, @publish_at, @fan_only, @nsfw, @language,
     @content_warning, @poll_json, @quote_uri, @quote_actor, @ap_visibility, @paid, @paid_min_cents, @view_count, @c2s_attachments, 'import')`);
  const insReply = db.prepare(`INSERT OR IGNORE INTO ap_interactions
    (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, content, published, parent_uri, created_at)
    VALUES ('reply', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);

  db.transaction(() => {
    for (const s of schrijf) {
      if (s.soort === 'media') {
        fs.mkdirSync(path.dirname(s.doel), { recursive: true });
        fs.writeFileSync(s.doel, s.bytes);
        continue;
      }
      if (s.soort === 'reply') {
        insReply.run(s.postId, s.it.id || '', s.it.attributedTo || '', s.it['shaer:actorName'] || null,
          s.it['shaer:actorHandle'] || null, s.it.content || '', s.it.published || null, s.it.inReplyTo || null);
        continue;
      }
      const o = s.obj;
      const opties = (Array.isArray(o.oneOf) ? o.oneOf : (Array.isArray(o.anyOf) ? o.anyOf : null));
      // De rollen uit het archief terug naar de kolommen. Zonder dit staat het
      // bestand er wel, maar komt de post zonder cover en zonder speler terug --
      // en dat zie je pas als je alle kolommen vergelijkt.
      const bijlagen = Array.isArray(o.attachment) ? o.attachment : [];
      const padVan = (a) => (a && a['shaer:availability'] !== 'missing' ? bestemming(a) : (a ? padVanOrigineel(a['shaer:originalUrl']) : null));
      const metRol = (r) => bijlagen.find((a) => a['shaer:role'] === r);
      const c2s = bijlagen.filter((a) => a['shaer:role'] === 'c2s').map((a) => {
        const poster = bijlagen.find((x) => x['shaer:role'] === 'poster' && x['shaer:posterFor'] === padVan(a));
        return {
          url: padVan(a), mediaType: a.mediaType, name: a.name || undefined,
          poster: poster ? padVan(poster) : undefined,
        };
      }).filter((a) => a.url);
      insPost.run({
        id: s.id, site_id: site.id, slug: o['shaer:slug'] || s.id, author_id: site.owner_id,
        title: o.name || null, content: o.content || '', excerpt: o['shaer:excerpt'] || null,
        status: o['shaer:status'] || 'draft',
        cover_image_url: padVan(metRol('cover')), cover_alt: o['shaer:coverAlt'] || null,
        cover_video_url: padVan(metRol('coverVideo')),
        c2s_attachments: c2s.length ? JSON.stringify(c2s) : null,
        pinned: o['shaer:pinned'] ? 1 : 0, type: o['shaer:type'] || 'post',
        tags: Array.isArray(o.tag) ? o.tag.filter((t) => t && t.type === 'Hashtag').map((t) => String(t.name).replace(/^#/, '')).join(', ') : null,
        published_at: tijd(o.published), created_at: tijd(o.published), updated_at: tijd(o.updated || o.published),
        noindex: o['shaer:noindex'] ? 1 : 0, publish_at: tijd(o['shaer:publishAt']),
        fan_only: o['shaer:fanOnly'] ? 1 : 0, nsfw: o.sensitive ? 1 : 0,
        language: (o.contentMap && Object.keys(o.contentMap)[0]) || null,
        content_warning: o.summary || null,
        poll_json: opties ? JSON.stringify({ multiple: Array.isArray(o.anyOf), options: opties.map((x) => ({ name: x.name })), endTime: o.endTime || null, closed: !!o.closed }) : null,
        quote_uri: o.quoteUrl || null, quote_actor: o['shaer:quoteActor'] || null,
        ap_visibility: o['shaer:apVisibility'] || null,
        paid: o['shaer:paid'] ? 1 : 0, paid_min_cents: o['shaer:paidMinCents'] || null,
        view_count: o['shaer:viewCount'] || 0,
      });
      // Gehoste audio terug: [[track:]] in de content valt anders op niets terug.
      for (const t of (o['shaer:audio'] || [])) {
        const trackId = String(t['shaer:ref'] || '').replace(/^\[\[track:|\]\]$/g, '');
        if (!trackId) continue;
        let mediaId = null;
        const bij = (o.attachment || []).find((a) => a.url === t['shaer:media']);
        const doel = bij && veiligMediaPad(bestemming(bij));
        if (doel) {
          mediaId = randomUUID();
          try {
            db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
              .run(mediaId, site.id, path.basename(doel), bij.mediaType || 'audio/mpeg', (files.get(bij.url) || []).length || 0, doel);
          } catch { mediaId = null; }
        }
        try {
          db.prepare(`INSERT OR REPLACE INTO audio_tracks (id, site_id, title, artist, album, duration, media_id, credit, license, link_spotify, link_youtube, link_soundcloud)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(trackId, site.id, t.name || 'zonder titel', t.artist || null, t.album || null, t.duration || null,
              mediaId, t.credit || null, t.license || null,
              ...['spotify', 'youtube', 'soundcloud'].map((k) => (t.url || []).find((u) => String(u).includes(k)) || null));
        } catch { /* geen audio-tabellen op deze installatie */ }
      }
    }

    // FEP-1580: een import uit een export is GEEN apart geval. De spec zegt
    // met zoveel woorden dat objecten uit een geëxporteerde collectie net zo
    // behandeld moeten worden als objecten die van de bron zijn opgehaald.
    // Dus vult ook deze weg de vertaaltabel, en werkt de reactie van een derde
    // op een verhuisd bericht straks net zo goed bij als bij een live ingest.
    //
    // Alleen zinnig als de ids VERANDERD zijn: bleven ze gelijk, dan wijst de
    // oude URI al naar het goede object en valt er niets te vertalen.
    if (!idsBehouden && eigenOrigin) {
      for (const s of schrijf) {
        if (s.soort !== 'post' || !s.oudeUri) continue;
        Migration.recordMigrated(site.slug, {
          origin: s.oudeUri,
          target: `${eigenOrigin}/ap/notes/${encodeURIComponent(s.id)}`,
          sourceActor: manifest.actor || '',
          isPublic: !(s.obj && (s.obj['shaer:fanOnly'] || s.obj['shaer:apVisibility'] === 'direct')),
        });
      }
    }
  })();

  return rapport;
}
