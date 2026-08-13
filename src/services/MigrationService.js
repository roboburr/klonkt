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

/** De laatste padcomponent van een URI, als beginpunt voor een slug. */
function slugUitUri(uri) {
  try { return decodeURIComponent(new URL(uri).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}

const AFBEELDING = /^image\//i;

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
async function haalBijlage(url, { safeFetch, mediaRoot, fs, path, maxBytes, submap = 'migrated', headers = null }) {
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
  // Zonder submap komt het bestand in de root zelf: dat is wat gehoste audio
  // nodig heeft, want de speler zoekt AUDIO_ROOT + bestandsnaam en kijkt niet
  // in mappen eronder.
  const rel = submap ? `${submap}/${naam}` : naam;
  const abs = submap ? path.join(mediaRoot, submap, naam) : path.join(mediaRoot, naam);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return { url: `/media/${rel}`, mediaType: type, size: buf.length, filename: naam, storage_path: abs };
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
    bron: bronActor.id, posts: 0, overgeslagen: 0, media: 0, mediaMislukt: 0,
    blocks: 0, tracksBinnen: 0, tracksMislukt: 0, overgeslagenTracks: 0, waarschuwingen: [],
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
    if (pagina && pagina.first && !(pagina.orderedItems || pagina.items)) {
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
        if (alGemigreerd(site.slug, o.id)) { rapport.overgeslagen++; continue; }

        // Media eerst, want een post die naar een plaatje wijst dat we niet
        // hebben opgehaald is een halve post. Mislukt een bijlage, dan gaat de
        // post wel door en staat het in het verslag.
        const bijlagen = Array.isArray(o.attachment) ? o.attachment : [];
        const binnen = [];
        if (safeFetch && fs && path && mediaRoot) {
          for (const a of bijlagen.slice(0, 20)) {
            const u = a && (typeof a === 'string' ? a : (a.url && (typeof a.url === 'string' ? a.url : a.url.href)));
            if (!u || !/^https?:\/\//i.test(String(u))) continue;
            const g = await haalBijlage(String(u), { safeFetch, mediaRoot, fs, path, maxBytes }).catch(() => null);
            if (!g) { rapport.mediaMislukt++; rapport.waarschuwingen.push(`bijlage niet opgehaald: ${u}`); continue; }
            binnen.push({ ...g, naam: (a && a.name) || null, type: (a && a.mediaType) || g.mediaType });
            rapport.media++;
            try {
              db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?)')
                .run(crypto.randomUUID(), site.id, g.filename, g.mediaType, g.size, g.storage_path);
            } catch { /* media-rij is administratie, het bestand staat er */ }
          }
        }

        const id = crypto.randomUUID();
        const cover = binnen.find((b) => AFBEELDING.test(b.type || ''));
        const rest = binnen.filter((b) => b !== cover);
        // De titel zit in de content, niet in een veld (zie titelUitContent).
        const { titel, rest: body } = o.name ? { titel: o.name, rest: o.content || '' } : titelUitContent(o.content || '');
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
    const streams = [].concat(bronActor.streams || []).filter((u) => typeof u === 'string');
    const tracksUrl = streams.find((u) => /\/tracks\/?$/.test(u));
    if (tracksUrl && safeFetch && fs && path && audioRoot) {
      const coll = await getJson(site.slug, tracksUrl);
      const lijst = (coll && (coll.orderedItems || coll.items)) || [];
      for (const it of (Array.isArray(lijst) ? lijst : []).slice(0, max)) {
        const a = (it && typeof it.object === 'object' && it.object) ? it.object : it;
        if (!a || !a.id) continue;
        if (a.type && a.type !== 'Audio') continue;
        if (alGemigreerd(site.slug, a.id)) { rapport.overgeslagenTracks++; continue; }
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
        const trackId = crypto.randomUUID();
        const mediaId = crypto.randomUUID();
        try {
          db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
            .run(mediaId, site.id, g.filename, g.mediaType, g.size, g.storage_path);
          db.prepare(`INSERT INTO audio_tracks (id, site_id, title, artist, album, duration, media_id, fedi_open)
                      VALUES (?,?,?,?,?,?,?,0)`)
            .run(trackId, site.id, a.name || 'zonder titel', a.artist || null, a.album || null,
              Number(a.duration) || null, mediaId);
          recordMigrated(site.slug, { origin: a.id, target: `${me}/ap/tracks/${trackId}`, sourceActor: bronActor.id, isPublic: false });
          rapport.tracksBinnen++;
        } catch (e) {
          rapport.tracksMislukt++;
          rapport.waarschuwingen.push(`nummer niet opgeslagen: ${a.name || a.id} (${e && e.message})`);
        }
      }
    } else if (tracksUrl) {
      rapport.waarschuwingen.push('muziekbibliotheek overgeslagen: geen audiomap meegegeven');
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
