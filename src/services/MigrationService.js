/**
 * MigrationService.js — FEP-1580: je OBJECTEN verhuizen bij een Move.
 *
 * FEP-7628 verhuist je volgers en zegt zelf dat de rest een ander probleem is.
 * Dit is dat andere probleem: na een Move stonden je berichten nog op de oude
 * instantie, en elke reactie van een derde wees naar een URI die verdwijnt zodra
 * dat domein opgezegd wordt.
 *
 * DRIE DINGEN OM TE WETEN VOOR JE HIERIN LEEST:
 *
 * 1. DE AUTORISATIE IS DE MOVE, NIET EEN CODE. De bronkant staat in
 *    ActivityPubService.isMoveTarget: een ondertekend verzoek namens de actor
 *    waar de bron naartoe verhuisde telt als de bron zelf. Dat mag omdat
 *    moveAccount() `no_backreference` weigert, dus `moved_to` staat er alleen
 *    als iemand met beheer op BEIDE kanten dat wilde. Hier in dit bestand zit
 *    de DOELkant, die van die toestemming gebruikmaakt.
 *
 * 2. NIEUWE IDS ZIJN GEEN BUG, DE VERTAALTABEL IS HET ANTWOORD. Een gemigreerd
 *    bericht krijgt hier een eigen URI, want het staat nu op een ander domein.
 *    De `migration`-collectie mapt oud naar nieuw en derden lezen die om hun
 *    eigen verwijzingen bij te werken. Zonder die collectie is de draad kapot,
 *    met die collectie is het een verhuisbericht.
 *
 * 3. ER GAAT GEEN Create DE DEUR UIT. De spec is daar expliciet over, en het is
 *    ook gewoon logisch: je volgers hebben deze berichten jaren geleden al
 *    gezien. Een ingest van driehonderd posts die als driehonderd nieuwe posts
 *    de tijdlijn in klettert is geen verhuizing maar spam.
 *
 * WAT HIER ONTBREEKT: FEP-8b32 integrity proofs (shaer-j1v0). De `moves`-
 * collectie hoort ondertekend te zijn en de Moves erin horen een proof van de
 * bron-actor te dragen. Klonkt kent 8b32 nog niet. We bewaren wel alle
 * grondstof (de rauwe activity en het actordocument), zodat het later alleen
 * ondertekenen is. Bewust geen leeg proof-veld: een derde die het controleert
 * wordt dan misleid, en dat is erger dan een veld dat ontbreekt.
 */
import crypto from 'crypto';
import db from '../config/database.js';
import { AP_CONTEXT, actorId, pagedCollection } from './ap-core.js';

// ── Vertaaltabel ──────────────────────────────────────────────────

const stmts = {};
function q(naam, sql) { return (stmts[naam] ||= db.prepare(sql)); }

/** Leg vast dat `origin` hier `target` werd. Idempotent: opnieuw draaien mag. */
export function recordMigrated(slug, { origin, target, sourceActor = '', isPublic = true } = {}) {
  if (!slug || !origin || !target) return false;
  try {
    q('ins', `INSERT INTO ap_migration (slug, origin, target, source_actor, is_public)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(slug, origin) DO UPDATE SET target = excluded.target`)
      .run(slug, String(origin), String(target), String(sourceActor || ''), isPublic ? 1 : 0);
    return true;
  } catch (e) {
    console.warn('[FEP-1580] mapping niet opgeslagen:', origin, e && e.message);
    return false;
  }
}

/**
 * De items, nieuwste kopie eerst.
 *
 * `alles` is alleen waar voor een geverifieerde lezer uit het publiek van de
 * niet-publieke objecten. De spec: Moves voor objecten die niet aan as:Public
 * gericht zijn MOGEN NIET publiek getoond worden. Een migration-collectie die
 * de URIs van je fan-only posts opsomt is een lek, ook zonder de inhoud.
 */
export function migrationItems(slug, { alles = false } = {}) {
  try {
    const sql = `SELECT origin, target, source_actor FROM ap_migration
                 WHERE slug = ?${alles ? '' : ' AND is_public = 1'} ORDER BY id DESC`;
    return db.prepare(sql).all(slug);
  } catch { return []; }
}

export function migrationCount(slug, { alles = false } = {}) {
  try {
    const sql = `SELECT COUNT(*) n FROM ap_migration WHERE slug = ?${alles ? '' : ' AND is_public = 1'}`;
    return db.prepare(sql).get(slug).n;
  } catch { return 0; }
}

/** Is deze URI hier al binnen? Houdt een tweede ingest-ronde goedkoop. */
export function alGemigreerd(slug, origin) {
  try { return !!db.prepare('SELECT 1 FROM ap_migration WHERE slug = ? AND origin = ?').get(slug, String(origin)); } catch { return false; }
}

/**
 * Waar kwam deze bron-URI hier terecht? Null als hij nog niet gemigreerd is.
 *
 * Bestaat omdat "al gehad" en "overslaan" niet hetzelfde horen te zijn. Een
 * tweede ronde na een uitgebreide ingest (hoezen, duur, playlists erbij) moet
 * de bestaande nummers KUNNEN AANVULLEN in plaats van ze te passeren. Deed hij
 * dat niet, dan zat je vast: opnieuw ophalen sloeg alles over, en opruimen hielp
 * niet omdat deze tabel de blokkade in stand hield.
 */
export function migrationTarget(slug, origin) {
  try {
    const r = db.prepare('SELECT target FROM ap_migration WHERE slug = ? AND origin = ?').get(slug, String(origin));
    return r ? r.target : null;
  } catch { return null; }
}

// ── De Move-activities ────────────────────────────────────────────

export function recordMove(slug, { moveId, sourceActor, targetActor, activity, actorDoc = null } = {}) {
  if (!slug || !moveId || !sourceActor || !targetActor) return false;
  try {
    q('insMove', `INSERT INTO ap_moves (slug, move_id, source_actor, target_actor, activity_json, actor_json)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(slug, move_id) DO NOTHING`)
      .run(slug, String(moveId), String(sourceActor), String(targetActor),
        JSON.stringify(activity || {}), actorDoc ? JSON.stringify(actorDoc) : null);
    return true;
  } catch (e) {
    console.warn('[FEP-1580] Move niet opgeslagen:', moveId, e && e.message);
    return false;
  }
}

export function moveRows(slug) {
  try { return db.prepare('SELECT * FROM ap_moves WHERE slug = ? ORDER BY id').all(slug); } catch { return []; }
}

// ── Stand van zaken ───────────────────────────────────────────────

export function migrationComplete(slug) {
  try {
    const r = db.prepare('SELECT migration_complete FROM sites WHERE slug = ?').get(slug);
    // Geen kolom of geen rij telt als "klaar": een site die nooit verhuisde
    // heeft niets openstaan, en derden moeten niet eeuwig blijven pollen.
    return !r || r.migration_complete === null || r.migration_complete === undefined ? true : !!r.migration_complete;
  } catch { return true; }
}

export function setMigrationComplete(slug, klaar) {
  try { db.prepare('UPDATE sites SET migration_complete = ? WHERE slug = ?').run(klaar ? 1 : 0, slug); } catch { /* kolom ontbreekt op een oude db */ }
}

// ── De collecties ─────────────────────────────────────────────────

/**
 * De `migration`-collectie. Items zijn Move-activities per OBJECT (niet per
 * actor): origin is de oude URI, target de nieuwe.
 *
 * De spec wil URI-verwijzingen in origin/target in plaats van ingesloten
 * objecten, en paginering. `pagedCollection` doet dat al voor de rest van
 * Klonkt, dus die gebruiken we ook hier.
 */
export function buildMigration(base, site, { page = false, alles = false } = {}) {
  const me = actorId(base, site.slug);
  const id = `${me}/migration`;
  const rows = migrationItems(site.slug, { alles });
  const items = rows.map((r) => ({
    type: 'Move',
    actor: r.source_actor || undefined,
    origin: r.origin,
    target: r.target,
  }));
  return pagedCollection(id, items, {
    page,
    extra: {
      attributedTo: me,
      moves: `${me}/moves`,
      migrationComplete: migrationComplete(site.slug),
    },
  });
}

/**
 * De `moves`-collectie: de Move-activities zelf, met het bron-actordocument
 * ingesloten zoals de spec aanraadt ("Source instances SHOULD inline the source
 * Actor object"), zodat een lezer de proof kan nakijken zonder de bron nog te
 * kunnen bereiken. Dat laatste is precies het geval waarvoor dit bestaat.
 *
 * Zonder FEP-8b32 (shaer-j1v0) ontbreekt de handtekening. Zie de kop.
 */
export function buildMoves(base, site) {
  const me = actorId(base, site.slug);
  const rows = moveRows(site.slug);
  const orderedItems = rows.map((r) => {
    let act = {};
    try { act = JSON.parse(r.activity_json) || {}; } catch { /* onleesbaar, dan de kale vorm hieronder */ }
    let actorDoc = null;
    try { actorDoc = r.actor_json ? JSON.parse(r.actor_json) : null; } catch { /* idem */ }
    return {
      id: r.move_id,
      type: 'Move',
      origin: r.source_actor,
      target: r.target_actor,
      actor: actorDoc || r.source_actor,
      ...(act.published ? { published: act.published } : {}),
    };
  });
  return {
    '@context': AP_CONTEXT,
    id: `${me}/moves`,
    type: 'OrderedCollection',
    attributedTo: me,
    totalItems: orderedItems.length,
    orderedItems,
  };
}

// ── Wat de UI wil weten ───────────────────────────────────────────

export function migrationStatus(slug) {
  return {
    total: migrationCount(slug, { alles: true }),
    publiek: migrationCount(slug),
    moves: moveRows(slug).length,
    complete: migrationComplete(slug),
  };
}

/** Een id dat nergens mee botst, in de vorm die de rest van Klonkt gebruikt. */
export function nieuwId() { return crypto.randomUUID(); }

// ── De ingest: van de bron hierheen ───────────────────────────────

/** Vrije slug binnen deze site. Botst hij, dan -2, -3, enzovoort. */
function vrijeSlug(siteId, basis) {
  const schoon = String(basis || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bericht';
  const bestaat = db.prepare('SELECT 1 FROM posts WHERE site_id = ? AND slug = ?');
  if (!bestaat.get(siteId, schoon)) return schoon;
  for (let n = 2; n < 500; n++) if (!bestaat.get(siteId, `${schoon}-${n}`)) return `${schoon}-${n}`;
  return `${schoon}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Het kale id uit een track-URI: .../tracks/t-een -> t-een. */
function ruwId(uri) {
  try { return decodeURIComponent(String(uri).split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}

/** De laatste padcomponent van een URI, als beginpunt voor een slug. */
function slugUitUri(uri) {
  try { return decodeURIComponent(new URL(uri).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}

const AFBEELDING = /^image\//i;

/**
 * Hoort deze URL bij de bron, en wijst hij onder /media/?
 *
 * Dan behouden we het PAD. Drie redenen tegelijk:
 *   - de gebakken content verwijst relatief of absoluut naar dat pad, en met
 *     hetzelfde pad hier klopt elke verwijzing zonder herschrijf-acrobatiek;
 *   - de media-bibliotheek (Beheer, Media) scant de MAP post-images, niet de
 *     databasetabel. Een bestand onder migrated/<uuid> bestaat wel en is
 *     onzichtbaar: Robins lege images-tab;
 *   - de zip-import bewaart originele paden al, dus zo convergeren beide
 *     routes op dezelfde bestanden.
 *
 * De ../-bewaking is geen formaliteit: het pad komt van een andere server.
 */
function bronMediaPad(url, bronOrigin, { mediaRoot, path }) {
  try {
    const u = new URL(String(url));
    if (`${u.protocol}//${u.host}` !== bronOrigin) return null;
    if (!u.pathname.startsWith('/media/')) return null;
    const rel = decodeURIComponent(u.pathname.slice('/media/'.length));
    const abs = path.resolve(mediaRoot, rel);
    const root = path.resolve(mediaRoot);
    if (abs === root || !abs.startsWith(`${root}${path.sep}`)) return null;
    return { rel: `/media/${rel}`, abs };
  } catch { return null; }
}

/** AS2 geeft de duur als ISO-8601 ("PT212S"), de database wil seconden. */
function duurSeconden(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.round(v) || null;
  const m = /^P(?:.*?T)?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(v));
  if (!m) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
  const sec = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return sec > 0 ? Math.round(sec) : null;
}

/**
 * De titel terugwinnen uit de content.
 *
 * Een AS2 Note heeft geen titel: Mastodon negeert `name`, dus Klonkt bakt de
 * titel als vetgedrukte eerste alinea IN de content (zie buildNote). Over de
 * lijn is een titel dus geen veld maar een vorm. Doen we hier niets, dan komt
 * elk bericht titelloos aan en heet het naar zijn id.
 *
 * Daarom draaien we precies onze eigen bak terug: alleen als de content BEGINT
 * met een alinea die niets anders bevat dan vetgedrukte tekst. Dat is de exacte
 * vorm die buildNote maakt. Een bericht van elders dat toevallig zo begint
 * verliest die regel niet, hij verhuist naar het titelveld en staat straks
 * gewoon weer bovenaan.
 */
function titelUitContent(html) {
  const m = /^\s*<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/i.exec(String(html || ''));
  if (!m) return { titel: null, rest: html };
  const titel = m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  if (!titel || titel.length > 300) return { titel: null, rest: html };
  return { titel, rest: String(html).slice(m[0].length) };
}

/**
 * Haal een bijlage op en zet hem lokaal neer.
 *
 * safeFetch is de SSRF-veilige kant van Klonkt; hier is dat geen formaliteit,
 * want de URL komt van een andere server. Een bron die ons naar 127.0.0.1 wijst
 * moet stranden, ook als die bron "van onszelf" is.
 */
async function haalBijlage(url, { safeFetch, mediaRoot, fs, path, maxBytes, submap = 'migrated', headers = null, doel = null }) {
  // Ondertekend als het moet. Gehoste audio zit achter dezelfde poort als de
  // rest van de bron, en een kale fetch krijgt daar een 403: de bron kan dan
  // niet zien dat wij de doel-actor van zijn Move zijn.
  const r = await safeFetch(url, { headers: headers || { accept: '*/*' } }).catch(() => null);
  if (!r || !r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) return null;
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';
  const ext = (() => {
    const uit = slugUitUri(url);
    const m = /\.([a-z0-9]{1,5})$/i.exec(uit);
    if (m) return m[1].toLowerCase();
    return (type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
  })();
  const naam = `${crypto.randomUUID()}.${ext}`;
  // `doel` wint: dan behouden we het pad van de bron (zie bronMediaPad).
  // Zonder submap komt het bestand in de root zelf: dat is wat gehoste audio
  // nodig heeft, want de speler zoekt AUDIO_ROOT + bestandsnaam en kijkt niet
  // in mappen eronder.
  const rel = doel ? doel.rel : (submap ? `${submap}/${naam}` : naam);
  const abs = doel ? doel.abs : (submap ? path.join(mediaRoot, submap, naam) : path.join(mediaRoot, naam));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  // doel.rel is al een volledig /media/-pad; de submap-variant is dat nog niet.
  return { url: doel ? doel.rel : `/media/${rel}`, mediaType: type, size: buf.length, filename: naam, storage_path: abs };
}

/**
 * Alle bron-media in een lap HTML binnenhalen en de verwijzingen relatief maken.
 *
 * Werkt op ALLE https://bron/media/...-voorkomens, niet alleen op <img src>:
 * de gebakken content zet dezelfde URL ook in een href om het plaatje groot te
 * openen, en een half herschreven paar (lokaal plaatje, hotlink eromheen) is
 * verwarrender dan geen herschrijving.
 *
 * Idempotent: wat al gedownload is wordt niet opnieuw gehaald, en een tweede
 * ronde over dezelfde tekst vindt gewoon niets meer te doen.
 */
async function inhoudMediaBinnen(html, bronOrigin, site, rapport, { safeFetch, mediaRoot, fs, path, maxBytes }) {
  let inhoud = String(html || '');
  if (!inhoud || !bronOrigin) return { inhoud, n: 0 };
  // LET OP de dubbele backslash: dit is een STRING die een RegExp wordt. Met een
  // enkele \s eet de template literal de backslash op en sluit de klasse de
  // LETTER s uit; "post-images" knapte dan af op de s en elke URL met een s
  // erin werd half herschreven. Gevonden doordat de waarschuwing ".../media/po"
  // meldde, afgekapt precies voor de s.
  const patroon = new RegExp(`${bronOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/media/[^"'\\s)<>]+)`, 'g');
  const gezien = new Set();
  let n = 0;
  for (const m of [...inhoud.matchAll(patroon)]) {
    const vol = m[0];
    if (gezien.has(vol)) continue;
    gezien.add(vol);
    const doel = bronMediaPad(vol, bronOrigin, { mediaRoot, path });
    if (!doel) { rapport.waarschuwingen.push(`onbruikbaar mediapad in tekst: ${vol}`); continue; }
    let ok = false;
    try { fs.statSync(doel.abs); ok = true; } catch { /* nog niet binnen */ }
    if (!ok) {
      const g = await haalBijlage(vol, { safeFetch, mediaRoot, fs, path, maxBytes, doel }).catch(() => null);
      if (!g) { rapport.mediaMislukt++; rapport.waarschuwingen.push(`plaatje in tekst niet opgehaald: ${vol}`); continue; }
      rapport.media++;
      try {
        db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), site.id, path.basename(doel.abs), g.mediaType, g.size, doel.abs);
      } catch { /* administratie */ }
    }
    inhoud = inhoud.split(vol).join(doel.rel);
    n++;
  }
  return { inhoud, n };
}

/**
 * FEP-1580 ingest-routine, de doelkant.
 *
 * De autorisatie wordt hier niet verzonnen maar NAGEKEKEN, en in beide
 * richtingen, precies zoals de spec het voor derden voorschrijft: `movedTo` op
 * de bron moet naar ons wijzen EN wij moeten de bron in `alsoKnownAs` hebben.
 * Eén kant is een bewering, twee kanten is een afspraak. Zou ik alleen op onze
 * eigen alsoKnownAs afgaan, dan kon iedereen die zichzelf een alias geeft de
 * geschiedenis van een vreemde opeisen.
 *
 * `deps` is er voor de test: die moet dit kunnen draaien zonder netwerk.
 */
export async function ingestFromSource(site, {
  sourceUri = null, max = 1000, maxBytes = 25 * 1024 * 1024, deps = {},
} = {}) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  const me = actorId(base, site.slug);

  const {
    getJson = null, safeFetch = null, mediaRoot = null, fs = null, path = null, noteId = null,
    sanitize = (h) => h,
    // Standaard 'followers': kan iets niet als publiek bewezen worden, dan
    // hoort het niet in de publieke vertaaltabel. Fail-closed, want dit is een
    // privacygrens en niet een weergavedetail.
    noteVisibility = () => 'followers',
    audioRoot = null, signHeaders = null,
  } = deps;
  const zichtbaarheid = noteVisibility;
  if (!getJson || !noteId) return { error: 'config' };

  // 1. Welke bron? Zonder opgave: de alias die we zelf claimen.
  let bron = sourceUri && /^https?:\/\//i.test(sourceUri) ? sourceUri : null;
  if (!bron) {
    try {
      const aka = JSON.parse(site.ap_aliases || '[]');
      bron = Array.isArray(aka) ? aka.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || null : null;
    } catch { /* stukke ap_aliases telt als geen alias */ }
  }
  if (!bron) return { error: 'no_source' };

  // 2 + 3. Het bron-actordocument, en de wegwijzer die naar ONS moet wijzen.
  const bronActor = await getJson(site.slug, bron);
  if (!bronActor || !bronActor.id) return { error: 'unreachable' };
  // De origin van de bron: alles op deze host onder /media/ is van hem en mag
  // naar hetzelfde pad hier. Uit de actor-id, niet uit de invoer.
  const bronOrigin = (() => { try { const u = new URL(bronActor.id); return `${u.protocol}//${u.host}`; } catch { return null; } })();
  if (bronActor.movedTo !== me) return { error: 'not_moved_here', movedTo: bronActor.movedTo || null };

  // 4. En de terugverwijzing van onze kant, zodat het een afspraak is.
  const eigenAka = (() => {
    try { const a = JSON.parse(site.ap_aliases || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  })();
  if (!eigenAka.includes(bronActor.id)) return { error: 'no_backreference' };

  // 5 + 6. Vastleggen dat dit een migratie is, en de deur openzetten voor derden.
  recordMove(site.slug, {
    moveId: `${bronActor.id}#move`, sourceActor: bronActor.id, targetActor: me,
    activity: { type: 'Move', actor: bronActor.id, object: bronActor.id, target: me },
    actorDoc: bronActor,
  });
  setMigrationComplete(site.slug, false);

  const rapport = {
    bron: bronActor.id, posts: 0, overgeslagen: 0, opnieuw: 0, postsBijgewerkt: 0, media: 0, mediaMislukt: 0,
    blocks: 0, tracksBinnen: 0, tracksMislukt: 0, tracksBijgewerkt: 0, overgeslagenTracks: 0,
    playlistsBinnen: 0, playlistsMislukt: 0, waarschuwingen: [],
  };

  try {
    // 7. BLOKKADES EERST. De spec is daar streng over, en terecht: ze bepalen
    //    wie de rest te zien krijgt. Andersom importeer je even je hele
    //    geschiedenis zichtbaar voor iemand die je nou juist buiten wilde.
    if (bronActor.blocked) {
      const coll = await getJson(site.slug, typeof bronActor.blocked === 'string' ? bronActor.blocked : bronActor.blocked.id);
      const lijst = (coll && (coll.orderedItems || coll.items)) || [];
      for (const b of Array.isArray(lijst) ? lijst : []) {
        const uri = typeof b === 'string' ? b : (b && (b.object || b.id));
        if (!uri || !/^https?:\/\//i.test(String(uri))) continue;
        try {
          db.prepare("INSERT OR IGNORE INTO ap_blocks (slug, target, kind, label) VALUES (?, ?, 'actor', NULL)").run(site.slug, String(uri));
          rapport.blocks++;
        } catch { /* tabel ontbreekt op een verse db */ }
      }
    } else {
      rapport.waarschuwingen.push('de bron gaf geen blokkadelijst, zichtbaarheidsvoorkeuren komen niet mee');
    }

    // 8. De outbox aflopen. Pagineren zoals de rest van Klonkt dat doet.
    if (!bronActor.outbox) return { ...rapport, error: 'no_outbox' };
    let pagina = await getJson(site.slug, typeof bronActor.outbox === 'string' ? bronActor.outbox : bronActor.outbox.id);
    const verwacht = pagina && Number(pagina.totalItems) || null;
    // Is er een `first`, dan ALTIJD de paginaketen volgen, ook als de kale
    // collectie zelf items draagt. Klonkt zet daar een kopie van pagina 1 in
    // (Pleroma eiste een first, en sindsdien staan ze er allebei), maar alleen
    // echte pagina's dragen een `next`. Wie op de kale collectie blijft hangen
    // verwerkt pagina 1 en denkt dan klaar te zijn: precies 18 van Robins 35
    // berichten, zonder één waarschuwing.
    if (pagina && pagina.first) {
      pagina = await getJson(site.slug, typeof pagina.first === 'string' ? pagina.first : pagina.first.id);
    }

    const insPost = db.prepare(`INSERT INTO posts
      (id, site_id, slug, author_id, title, content, excerpt, status, cover_image_url,
       pinned, type, tags, published_at, created_at, updated_at, fan_only, nsfw, language,
       content_warning, ap_visibility, c2s_attachments, origin_server)
      VALUES (@id, @site_id, @slug, @author_id, @title, @content, NULL, 'published', @cover_image_url,
       0, 'post', @tags, @published_at, @published_at, @updated_at, @fan_only, @nsfw, @language,
       @content_warning, @ap_visibility, @c2s_attachments, 'migrated')`);

    let gezien = 0;
    while (pagina && gezien < max) {
      const items = (pagina.orderedItems || pagina.items) || [];
      for (const it of Array.isArray(items) ? items : []) {
        if (gezien >= max) break;
        const o = (it && typeof it.object === 'object' && it.object) ? it.object : it;
        if (!o || !o.id) continue;
        if (o.type && !['Note', 'Article', 'Question'].includes(o.type)) continue;
        if (o.inReplyTo) continue;                                    // toplevel; antwoorden hangen aan hun ouder
        const auteur = typeof o.attributedTo === 'string' ? o.attributedTo : (o.attributedTo && o.attributedTo.id);
        if (auteur && auteur !== bronActor.id) continue;              // alleen wat van HEM was
        gezien++;
        // Het interne id BLIJFT (Robins besluit, 14-8). Daarmee is "staat hij
        // hier al" gewoon een blik in de tabel, en niet iets dat je uit een
        // aparte mapping moet afleiden. Verwijder je een bericht en haal je
        // opnieuw op, dan komt het gewoon terug: er staat immers niets meer.
        const id = ruwId(o.id) || crypto.randomUUID();
        const bestaand = db.prepare('SELECT id, content, cover_image_url FROM posts WHERE id = ? AND site_id = ?').get(id, site.id);
        if (bestaand) {
          // Niet alleen overslaan: REPAREREN wat een eerdere ronde liet liggen.
          // Robins 18 posts stonden er al, met hotlinks naar de bron in de
          // tekst en zonder cover. Een tweede ronde die dat ziet en passeert
          // laat je met een site vol verwijzingen naar een domein dat
          // opgezegd wordt.
          if (safeFetch && fs && path && mediaRoot && bronOrigin && String(bestaand.content || '').includes(bronOrigin)) {
            const r2 = await inhoudMediaBinnen(bestaand.content, bronOrigin, site, rapport, { safeFetch, mediaRoot, fs, path, maxBytes });
            if (r2.n) {
              db.prepare('UPDATE posts SET content = ? WHERE id = ?').run(r2.inhoud, bestaand.id);
              rapport.postsBijgewerkt++;
            }
          }
          if (!bestaand.cover_image_url && safeFetch && fs && path && mediaRoot) {
            // De cover alsnog: hij zit als bijlage op de Note.
            for (const a of (Array.isArray(o.attachment) ? o.attachment : []).slice(0, 20)) {
              const u = a && (typeof a === 'string' ? a : (a.url && (typeof a.url === 'string' ? a.url : a.url.href)));
              if (!u || !AFBEELDING.test(String((a && a.mediaType) || ''))) continue;
              const doel = bronMediaPad(u, bronOrigin, { mediaRoot, path });
              const g = await haalBijlage(String(u), { safeFetch, mediaRoot, fs, path, maxBytes, doel }).catch(() => null);
              if (g) {
                db.prepare('UPDATE posts SET cover_image_url = ? WHERE id = ?').run(g.url, bestaand.id);
                rapport.media++;
                rapport.postsBijgewerkt++;
              }
              break;
            }
          }
          rapport.overgeslagen++;
          continue;
        }
        if (migrationTarget(site.slug, o.id)) rapport.opnieuw++;   // was er, is weg, komt terug

        // Media eerst, want een post die naar een plaatje wijst dat we niet
        // hebben opgehaald is een halve post. Mislukt een bijlage, dan gaat de
        // post wel door en staat het in het verslag.
        const bijlagen = Array.isArray(o.attachment) ? o.attachment : [];
        const binnen = [];
        let inhoud = o.content || '';
        if (safeFetch && fs && path && mediaRoot) {
          for (const a of bijlagen.slice(0, 20)) {
            const u = a && (typeof a === 'string' ? a : (a.url && (typeof a.url === 'string' ? a.url : a.url.href)));
            if (!u || !/^https?:\/\//i.test(String(u))) continue;
            const doel = bronMediaPad(u, bronOrigin, { mediaRoot, path });
            const g = await haalBijlage(String(u), { safeFetch, mediaRoot, fs, path, maxBytes, doel }).catch(() => null);
            if (!g) { rapport.mediaMislukt++; rapport.waarschuwingen.push(`bijlage niet opgehaald: ${u}`); continue; }
            binnen.push({ ...g, naam: (a && a.name) || null, type: (a && a.mediaType) || g.mediaType });
            rapport.media++;
            try {
              db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?)')
                .run(crypto.randomUUID(), site.id, g.filename, g.mediaType, g.size, g.storage_path);
            } catch { /* media-rij is administratie, het bestand staat er */ }
          }
          // De PLAATJES IN DE TEKST. De gebakken content draagt absolute
          // verwijzingen naar de bron (https://oud/media/...), en die bleven
          // gewoon staan: elke afbeelding hotlinkte naar een domein dat je gaat
          // opzeggen, en je eigen mediamap bleef leeg. Downloaden naar
          // HETZELFDE pad en de verwijzing relatief maken; wat niet lukt blijft
          // absoluut staan en wordt gemeld, want een lokale 404 is erger dan
          // een hotlink.
          const r2 = await inhoudMediaBinnen(inhoud, bronOrigin, site, rapport, { safeFetch, mediaRoot, fs, path, maxBytes });
          inhoud = r2.inhoud;
        }

        const cover = binnen.find((b) => AFBEELDING.test(b.type || ''));
        const rest = binnen.filter((b) => b !== cover);
        // De titel zit in de content, niet in een veld (zie titelUitContent).
        const { titel, rest: body } = o.name ? { titel: o.name, rest: inhoud } : titelUitContent(inhoud);
        // De slug uit de MENSELIJKE url, niet uit de AP-id. Zo houdt het bericht
        // hetzelfde webadres als op de oude instantie, en blijft een link die
        // iemand ergens plakte kloppen op het nieuwe domein.
        const basisSlug = slugUitUri(o.url || '') || o.name || slugUitUri(o.id) || id;
        // De publicatiedatum blijft die van het origineel. De spec eist dat, en
        // het is ook het enige eerlijke: het bericht is niet vandaag geschreven.
        insPost.run({
          id, site_id: site.id, slug: vrijeSlug(site.id, basisSlug),
          author_id: site.owner_id, title: titel || null, content: sanitize(body || ''),
          cover_image_url: cover ? cover.url : null,
          tags: Array.isArray(o.tag) ? o.tag.filter((t) => t && t.type === 'Hashtag').map((t) => String(t.name || '').replace(/^#/, '')).filter(Boolean).join(', ') || null : null,
          published_at: o.published || null, updated_at: o.updated || o.published || null,
          fan_only: 0, nsfw: o.sensitive ? 1 : 0,
          language: (o.contentMap && Object.keys(o.contentMap)[0]) || null,
          content_warning: o.summary || null,
          ap_visibility: null,
          c2s_attachments: rest.length ? JSON.stringify(rest.map((b) => ({ url: b.url, mediaType: b.type, name: b.naam || undefined }))) : null,
        });
        recordMigrated(site.slug, {
          origin: o.id, target: noteId(base, id), sourceActor: bronActor.id,
          // Publiek in de zin van de spec: gericht aan as:Public. Zo niet, dan
          // hoort deze regel niet in een publiek leesbare migration-pagina.
          //
          // Via noteVisibility en niet met een eigen test op '#Public': die kent
          // ook de schrijfwijzen 'as:Public' en 'Public', en de rest van Klonkt
          // beslist er al mee. Een tweede, dunnere versie van dezelfde vraag is
          // precies hoe twee antwoorden uit elkaar gaan lopen.
          isPublic: zichtbaarheid(o) === 'public',
        });
        rapport.posts++;
      }
      const volgende = pagina.next;
      if (!volgende || gezien >= max) break;
      pagina = await getJson(site.slug, typeof volgende === 'string' ? volgende : volgende.id);
    }
    if (gezien >= max) rapport.waarschuwingen.push(`gestopt bij ${max} berichten, draai het nog eens voor de rest`);
    // Silently minder ophalen dan de bron zegt te hebben is precies hoe 18 van
    // de 35 wekenlang op "klaar" had kunnen staan. Tel na en zeg het.
    if (verwacht && gezien < verwacht && gezien < max) {
      rapport.waarschuwingen.push(`de bron meldt ${verwacht} items en er zijn er ${gezien} verwerkt; een pagina is mogelijk niet opgehaald, probeer het nog eens`);
    }

    // ── De muziekbibliotheek ──────────────────────────────────────
    //
    // Losse nummers staan niet in de outbox: die hangen aan de tracks-collectie
    // waar de actor via AS2 `streams` naar wijst. Zonder deze lus verhuist een
    // muzieksite zijn berichten en laat hij zijn bibliotheek achter.
    //
    // De bron geeft ons hier alles, niet alleen de fedi_open-nummers, omdat we
    // de doel-actor van zijn Move zijn (siteOpenTracks({alles})). Hetzelfde
    // geldt voor de bestanden zelf, die anders achter de gated audio-route
    // blijven.
    const trackKaart = new Map();   // bron-URI van een nummer -> ons nieuwe id
    // En het RUWE id zoals het in de posttekst staat. Klonkt schrijft
    // [[track:<id>]] in de content, en die tekst reist letterlijk mee over AP.
    // Krijgt het nummer hier een ander id, dan wijst die shorthand nergens meer
    // heen en zie je de code zelf in je bericht staan.
    const ruwKaart = new Map();     // ruw bron-id -> ons id
    const streams = [].concat(bronActor.streams || []).filter((u) => typeof u === 'string');
    const tracksUrl = streams.find((u) => /\/tracks\/?$/.test(u));
    if (tracksUrl && safeFetch && fs && path && audioRoot) {
      const coll = await getJson(site.slug, tracksUrl);
      const lijst = (coll && (coll.orderedItems || coll.items)) || [];
      for (const it of (Array.isArray(lijst) ? lijst : []).slice(0, max)) {
        const a = (it && typeof it.object === 'object' && it.object) ? it.object : it;
        if (!a || !a.id) continue;
        if (a.type && a.type !== 'Audio') continue;
        // AL BINNEN? Dan AANVULLEN, niet overslaan. Een tweede ronde bestaat
        // juist omdat er iets bij is gekomen (hoezen, duur, playlists), en een
        // pull die dan alles passeert laat je met een half resultaat zitten
        // zonder uitweg: opruimen hielp niet, want deze tabel hield de blokkade
        // in stand.
        //
        // Alleen LEGE velden worden gevuld. Wat jij zelf hebt aangepast blijft
        // staan; een migratie hoort je correcties niet terug te draaien.
        const trackId = ruwId(a.id) || crypto.randomUUID();
        {
          const rij = db.prepare('SELECT id, cover_url, duration, artist FROM audio_tracks WHERE id = ? AND site_id = ?')
            .get(trackId, site.id);
          if (rij) {
            trackKaart.set(String(a.id), rij.id);   // MOET, anders vinden de playlists hem niet
            ruwKaart.set(ruwId(a.id), rij.id);
            const duur = rij.duration ? null : duurSeconden(a.duration);
            const artiest = rij.artist ? null : (a.summary || a.artist || null);
            let hoes = null;
            const hUrl = (a.icon && (a.icon.url || a.icon)) || (a.image && (a.image.url || a.image)) || null;
            if (!rij.cover_url && hUrl && /^https?:\/\//i.test(String(hUrl)) && safeFetch && fs && path && mediaRoot) {
              const h = await haalBijlage(String(hUrl), {
                safeFetch, mediaRoot, fs, path, maxBytes,
                headers: signHeaders ? signHeaders(site.slug, String(hUrl), '*/*') : null,
              }).catch(() => null);
              if (h) { hoes = h.url; rapport.media++; }
            }
            if (duur || artiest || hoes) {
              db.prepare(`UPDATE audio_tracks SET
                            duration = COALESCE(?, duration),
                            artist = COALESCE(?, artist),
                            cover_url = COALESCE(?, cover_url)
                          WHERE id = ?`).run(duur, artiest, hoes, rij.id);
              rapport.tracksBijgewerkt++;
            } else {
              rapport.overgeslagenTracks++;
            }
            continue;
          }
        }
        const bron = a.url && (typeof a.url === 'string' ? a.url : (Array.isArray(a.url) ? (a.url[0] && (a.url[0].href || a.url[0])) : a.url.href));
        if (!bron || !/^https?:\/\//i.test(String(bron))) { rapport.tracksMislukt++; continue; }
        const g = await haalBijlage(String(bron), {
          safeFetch, mediaRoot: audioRoot, fs, path, maxBytes, submap: '',
          headers: signHeaders ? signHeaders(site.slug, String(bron), '*/*') : null,
        }).catch(() => null);
        if (!g) {
          rapport.tracksMislukt++;
          rapport.waarschuwingen.push(`nummer niet opgehaald: ${a.name || bron}`);
          continue;                       // dezelfde regel als bij de zip: geen bestand, geen track
        }
        // De hoes. Die reisde als URL wel mee en als bestand niet, dus kwam een
        // nummer aan met een verwijzing naar een plaatje dat er niet is.
        let hoes = null;
        const hoesUrl = (a.icon && (a.icon.url || a.icon)) || (a.image && (a.image.url || a.image)) || null;
        if (hoesUrl && /^https?:\/\//i.test(String(hoesUrl))) {
          const h = await haalBijlage(String(hoesUrl), {
            safeFetch, mediaRoot, fs, path, maxBytes,
            headers: signHeaders ? signHeaders(site.slug, String(hoesUrl), '*/*') : null,
          }).catch(() => null);
          if (h) { hoes = h.url; rapport.media++; }
          else rapport.waarschuwingen.push(`hoes niet opgehaald: ${a.name || hoesUrl}`);
        }
        const mediaId = crypto.randomUUID();
        try {
          db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
            .run(mediaId, site.id, g.filename, g.mediaType, g.size, g.storage_path);
          db.prepare(`INSERT INTO audio_tracks (id, site_id, title, artist, album, duration, media_id, cover_url, fedi_open)
                      VALUES (?,?,?,?,?,?,?,?,0)`)
            .run(trackId, site.id, a.name || 'zonder titel', a.summary || a.artist || null, a.album || null,
              duurSeconden(a.duration), mediaId, hoes);
          recordMigrated(site.slug, { origin: a.id, target: `${me}/ap/tracks/${trackId}`, sourceActor: bronActor.id, isPublic: false });
          trackKaart.set(String(a.id), trackId);
          ruwKaart.set(ruwId(a.id), trackId);
          rapport.tracksBinnen++;
        } catch (e) {
          rapport.tracksMislukt++;
          rapport.waarschuwingen.push(`nummer niet opgeslagen: ${a.name || a.id} (${e && e.message})`);
        }
      }
    } else if (tracksUrl) {
      rapport.waarschuwingen.push('muziekbibliotheek overgeslagen: geen audiomap meegegeven');
    }

    // ── De verwijzingen in de tekst bijtrekken ────────────────────
    //
    // Klonkt schrijft [[track:<id>]] in posts.content, en die tekst reist
    // letterlijk mee. Krijgt het nummer hier een ander id, dan wijst de
    // shorthand nergens heen en zie je de code zelf in je bericht staan in
    // plaats van een speler. Precies wat Robin op TikTik zag.
    //
    // Pas NA de tracks, want daarvoor is de kaart nog leeg. En alleen waar het
    // id echt veranderde: een gelijk id hoeft niet aangeraakt.
    {
      const paren = [...ruwKaart.entries()].filter(([oud, nieuwId]) => oud && oud !== nieuwId);
      if (paren.length) {
        const upd = db.prepare('UPDATE posts SET content = REPLACE(content, ?, ?) WHERE site_id = ? AND content LIKE ?');
        let n = 0;
        for (const [oud, nieuwId] of paren) {
          const r = upd.run(`[[track:${oud}]]`, `[[track:${nieuwId}]]`, site.id, `%[[track:${oud}]]%`);
          if (r && r.changes) n += r.changes;
        }
        if (n) { rapport.tekstBijgewerkt = n; console.log('[FEP-1580] track-verwijzingen bijgetrokken in', n, 'bericht(en)'); }
      }
    }

    // ── De playlists ──────────────────────────────────────────────
    //
    // Los van de nummers, want de VOLGORDE is de playlist. Die staat nergens
    // anders: haal je alleen de tracks op, dan heb je wel alle muziek en geen
    // enkele plaat. De bron geeft ons de volledige lijst omdat we de doel-actor
    // zijn; anders zaten er alleen de opengezette nummers in en kreeg je een
    // plaat met gaten.
    const plUrl = streams.find((u) => /\/playlists\/?$/.test(u));
    if (plUrl && trackKaart.size) {
      const coll = await getJson(site.slug, plUrl);
      const lijst = (coll && (coll.orderedItems || coll.items)) || [];
      for (const p of (Array.isArray(lijst) ? lijst : []).slice(0, 200)) {
        const uri = typeof p === 'string' ? p : (p && p.id);
        if (!uri) continue;
        const plc = typeof p === 'object' && (p.orderedItems || p.items) ? p : await getJson(site.slug, uri);
        if (!plc) { rapport.playlistsMislukt++; continue; }
        const nummers = (plc.orderedItems || plc.items || [])
          .map((x) => (x && typeof x === 'object' ? x.id : x))
          .map((id) => trackKaart.get(String(id)))
          .filter(Boolean);
        if (!nummers.length) {
          rapport.waarschuwingen.push(`playlist ${plc.name || uri}: geen van de nummers is aangekomen, overgeslagen`);
          continue;
        }
        // De hoes van de plaat, net als bij een nummer.
        let plHoes = null;
        const plHoesUrl = (plc.icon && (plc.icon.url || plc.icon)) || (plc.image && (plc.image.url || plc.image)) || null;
        if (plHoesUrl && /^https?:\/\//i.test(String(plHoesUrl)) && safeFetch && fs && path && mediaRoot) {
          const h = await haalBijlage(String(plHoesUrl), {
            safeFetch, mediaRoot, fs, path, maxBytes,
            headers: signHeaders ? signHeaders(site.slug, String(plHoesUrl), '*/*') : null,
          }).catch(() => null);
          if (h) { plHoes = h.url; rapport.media++; }
          else rapport.waarschuwingen.push(`hoes van playlist niet opgehaald: ${plc.name || uri}`);
        }
        // Ook hier het id van de bron. Dan blijft [[playlist:<id>]] in een
        // bericht wijzen, en is een tweede ronde vanzelf dezelfde rij.
        const plId = ruwId(uri) || crypto.randomUUID();
        try {
          db.prepare(`INSERT INTO playlists (id, site_id, title, artist, year, kind, cover_url) VALUES (?,?,?,?,?,?,?)
                      ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        artist = COALESCE(playlists.artist, excluded.artist),
                        cover_url = COALESCE(playlists.cover_url, excluded.cover_url)`)
            .run(plId, site.id, plc.name || 'zonder titel', plc.artist || null,
              plc.year || null, plc['shaer:kind'] || null, plHoes);
          // De volgorde opnieuw zetten: die IS de plaat, en een halve
          // bijgewerkte volgorde is erger dan een verse.
          db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(plId);
          const ins = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)');
          nummers.forEach((tid, i) => ins.run(plId, tid, i));
          recordMigrated(site.slug, { origin: uri, target: `${me}/ap/playlists/${plId}`, sourceActor: bronActor.id, isPublic: false });
          rapport.playlistsBinnen++;
          const kwijt = (plc.orderedItems || plc.items || []).length - nummers.length;
          if (kwijt > 0) rapport.waarschuwingen.push(`playlist ${plc.name || uri}: ${kwijt} nummer(s) ontbraken en zijn eruit gelaten`);
        } catch (e) {
          rapport.playlistsMislukt++;
          rapport.waarschuwingen.push(`playlist niet opgeslagen: ${plc.name || uri} (${e && e.message})`);
        }
      }
    }
  } catch (e) {
    // 9-bij-mislukking: de vlag blijft OPEN staan. Derden blijven dan kijken,
    // en dat is precies goed, want er is nog werk.
    console.warn('[FEP-1580] ingest afgebroken:', e && e.message);
    return { ...rapport, error: 'partial', melding: e && e.message };
  }

  // 9. Klaar. Nu pas mag een derde stoppen met kijken.
  setMigrationComplete(site.slug, true);
  console.log('[FEP-1580] ingest klaar:', site.slug, '<-', bronActor.id, rapport.posts, 'berichten,', rapport.media, 'bestanden');
  return rapport;
}
