/**
 * ap-reactions.js — het reactiecluster (stap 6 van shaer-drc).
 *
 * De waarheid over "heb ik hierop gereageerd" (ap_my_reactions), de afgeleide
 * vlaggen op ap_timeline die setReaction daaruit bijhoudt, de eenmalige
 * migratie, en de boost-upsert die een vreemde post de tijdlijn in trekt.
 *
 * Twee koppelingen, allebei bewust zo:
 *   - tlStmts komt STATISCH uit ap-timeline: reacties schrijven de
 *     tijdlijnvlaggen, dus die pijl wijst een kant op en mag gewoon een import
 *     zijn.
 *   - de omgekeerde pijl (de tijdlijn-leeskant heeft getReactionsFor nodig)
 *     blijft de injectie via wireTimeline in ActivityPubService -- twee
 *     zustermodules die elkaar importeren zou precies de kring zijn die
 *     shaer-drc vermijdt.
 * movedLock komt uit de dienstlaag (FEP-7628) en dus via wireReactions binnen.
 */
import db from '../config/database.js';
import { tlStmts } from './ap-timeline.js';

// Het ene werktuig uit de dienstlaag; ActivityPubService vult het onderaan.
let movedLock;
export function wireReactions(deps) {
  ({ movedLock } = deps);
}

// Your like/boost state on a REMOTE post (interact page toggles).
export function setMyReaction(slug, uri, kind, on) {
  if (on) db.prepare('INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind) VALUES (?,?,?)').run(slug, uri, kind);
  else db.prepare('DELETE FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ? AND kind = ?').run(slug, uri, kind);
}
export function getMyReactions(slug, uri) {
  const rows = (slug && uri) ? db.prepare('SELECT kind FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ?').all(slug, uri) : [];
  return { liked: rows.some((r) => r.kind === 'like'), boosted: rows.some((r) => r.kind === 'boost') };
}

// AFGELEIDE, GEEN BRON (shaer-9e9). De waarheid over "heb ik hierop gereageerd"
// staat in ap_my_reactions; deze vlaggen worden daaruit bijgehouden door
// setReaction en door niets anders. Roep ze niet los aan -- dan schrijf je de
// helft, en dat is precies hoe shaer:liked maandenlang false bleef (04aca12).
//
// ap_timeline.boosted verdient zijn bestaan wel: hij staat in de WHERE van de
// Cirkel-feed (getCirkelPosts) en in boostedCount, dus hij is een index en geen
// kopie. ap_timeline.liked wordt nergens als verzameling bevraagd en kan weg
// zodra fase 2 lang genoeg goed staat; hij is nu nog het vangnet waarmee
// terugdraaien een code-revert blijft in plaats van dataherstel.
let _markBoost, _unmarkBoost, _boostedCount;
export function markBoosted(slug, noteId) {
  try { if (!_markBoost) _markBoost = db.prepare('UPDATE ap_timeline SET boosted = 1 WHERE slug = ? AND id = ?'); _markBoost.run(slug, noteId); } catch { /* ignore */ }
}
export function unmarkBoosted(slug, noteId) {
  try { if (!_unmarkBoost) _unmarkBoost = db.prepare('UPDATE ap_timeline SET boosted = 0 WHERE slug = ? AND id = ?'); _unmarkBoost.run(slug, noteId); } catch { /* ignore */ }
}
let _markLike, _unmarkLike;
export function markLiked(slug, noteId) {
  try { if (!_markLike) _markLike = db.prepare('UPDATE ap_timeline SET liked = 1 WHERE slug = ? AND id = ?'); _markLike.run(slug, noteId); } catch { /* ignore */ }
}
export function unmarkLiked(slug, noteId) {
  try { if (!_unmarkLike) _unmarkLike = db.prepare('UPDATE ap_timeline SET liked = 0 WHERE slug = ? AND id = ?'); _unmarkLike.run(slug, noteId); } catch { /* ignore */ }
}
/**
 * Zet een reactie van JOU op een object. Dit hoort het enige schrijfpad te zijn
 * (shaer-9e9): de tussentabel ap_my_reactions is de waarheid, de vlaggen op
 * ap_timeline zijn de afgeleide. Zolang markLiked en broers los aanroepbaar
 * blijven kan een aanroeper ze vergeten, en dat is niet hypothetisch -- precies
 * dat leverde de shaer:liked-bug op (04aca12).
 *
 * `opts.note` is de opgeloste remote note bij een boost. Die is niet optioneel
 * uit netheid: een boost moet de post je tijdlijn IN trekken als je de auteur
 * niet volgt, anders heeft de vlag geen rij om op te landen en verschijnt de
 * boost nergens -- ook niet in de Cirkel.
 *
 * `opts.flagUri` bestaat omdat de twee bronnen vandaag verschillend gesleuteld
 * worden: de tussentabel op de URI die de client stuurde, de vlag op de
 * opgeloste object-URI. Meestal zijn die gelijk, maar niet gegarandeerd. Deze
 * naad houdt fase 1 gedragsbehoudend; het samentrekken van die twee sleutels is
 * werk voor fase 2, mét datamigratie.
 */
// Reactie-migratie (shaer-9e9). Draait bij boot, EEN keer per bump, net als
// selfHealTimeline. Bewust automatisch: klonkt-update tilt een hele vloot in een
// stap naar nieuwe code, en een handmatig script per instance wordt vergeten --
// terwijl het falen stil is (een reactie die niemand meer ziet geeft geen fout).
// v2 haalt de derde bron erbij: ap_interactions.acted_* (shaer-ipb). Een bump
// laat alle stappen opnieuw lopen, en dat mag -- ze zijn alle drie idempotent.
const REACTIONS_MIGRATION_VERSION = 2;

/**
 * Brengt alle reacties naar de tussentabel, onder de canonieke object-URI.
 *
 * Twee stappen, en ze zijn allebei nodig:
 *
 *  1. HERSLEUTELEN. De oude interact-route bewaarde de URI waarmee je binnenkwam
 *     en de bookmarklet geeft window.location.href door, dus de permalink. Sinds
 *     canonicalReactionUri wordt er op de object-URI gezocht, waardoor die rijen
 *     wees zouden zijn. De created_at reist mee: bij hersleutelen weten we
 *     wanneer je reageerde, bij aanvullen niet.
 *  2. AANVULLEN vanuit de afgeleide kolommen. Alles wat op oude code via de
 *     Krant is gegeven staat alleen daar; zonder deze stap toont het als
 *     niet-gereageerd en klikt een gebruiker opnieuw -- met een tweede Like de
 *     fediverse in als gevolg.
 *
 * Idempotent. Geeft terug wat er gebeurd is, zodat het script het kan tonen.
 */
export function migrateReactions(opts = {}) {
  const uit = { hersleuteld: 0, aangevuld: 0, reacties: 0, overgeslagen: false };
  try {
    if (!opts.force) {
      const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('reactions_migration_version');
      const cur = r ? (parseInt(r.value, 10) || 0) : 0;
      if (cur >= REACTIONS_MIGRATION_VERSION) { uit.overgeslagen = true; return uit; }
    }
  } catch { return uit; }   // geen app_settings → deze database is te oud om aan te raken

  // Een rij die NIET op een tijdlijn-id staat maar wel op een tijdlijn-url.
  const wees = `
    FROM ap_my_reactions r JOIN ap_timeline t ON t.slug = r.site_slug AND t.url = r.target_uri
     WHERE NOT EXISTS (SELECT 1 FROM ap_timeline t2 WHERE t2.slug = r.site_slug AND t2.id = r.target_uri)`;
  const scheef = (kind, kolom) => `
    FROM ap_timeline t
     WHERE t.${kolom} = 1
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = t.slug AND r.target_uri = t.id AND r.kind = '${kind}')`;
  // 3. De derde bron: wat JIJ deed met een reactie onder je eigen post. De slug
  //    hangt hier niet aan de rij maar aan de post; vandaar de twee joins. Een
  //    rij zonder object_uri kan nooit een reactie dragen (fedi-react eist hem),
  //    dus die uitsluiting verliest per constructie niets.
  const acted = (kind, kolom) => `
    FROM ap_interactions i
     JOIN posts p ON p.id = i.post_id
     JOIN sites s ON s.id = p.site_id
     WHERE i.${kolom} = 1 AND IFNULL(i.object_uri, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = s.slug AND r.target_uri = i.object_uri AND r.kind = '${kind}')`;

  if (opts.dryRun) {
    const tel = (sql) => { try { return db.prepare(`SELECT COUNT(*) AS n ${sql}`).get().n; } catch { return 0; } };
    uit.hersleuteld = tel(wees);
    uit.aangevuld = tel(scheef('like', 'liked')) + tel(scheef('boost', 'boosted'));
    uit.reacties = tel(acted('like', 'acted_like')) + tel(acted('boost', 'acted_boost'));
    return uit;
  }

  try {
    db.transaction(() => {
      // 1. Hersleutelen: eerst de canonieke variant erbij, dan de permalink weg.
      //    In die volgorde, zodat een onderbreking hooguit een dubbele rij
      //    oplevert en nooit een verdwenen reactie.
      uit.hersleuteld = db.prepare(`
        INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind, created_at)
        SELECT r.site_slug, t.id, r.kind, r.created_at ${wees}`).run().changes;
      db.prepare(`DELETE FROM ap_my_reactions WHERE rowid IN (SELECT r.rowid ${wees})`).run();

      // 2. Aanvullen vanuit de kolommen.
      for (const [kind, kolom] of [['like', 'liked'], ['boost', 'boosted']]) {
        uit.aangevuld += db.prepare(`
          INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind)
          SELECT t.slug, t.id, '${kind}' ${scheef(kind, kolom)}`).run().changes;
      }

      // 3. En vanuit acted_* op de reacties onder je eigen posts.
      for (const [kind, kolom] of [['like', 'acted_like'], ['boost', 'acted_boost']]) {
        uit.reacties += db.prepare(`
          INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind)
          SELECT s.slug, i.object_uri, '${kind}' ${acted(kind, kolom)}`).run().changes;
      }
    })();
    if (uit.hersleuteld || uit.aangevuld || uit.reacties) {
      console.log(`[AP] reaction migration v${REACTIONS_MIGRATION_VERSION}: ${uit.hersleuteld} re-keyed, ${uit.aangevuld} backfilled, ${uit.reacties} from comments`);
    }
    if (!opts.force) {
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
        .run('reactions_migration_version', String(REACTIONS_MIGRATION_VERSION));
    }
  } catch (e) {
    // Niet fataal: de kolommen staan er nog, dus de oude waarheid is niet weg.
    // Een volgende boot probeert het opnieuw, want de versie is niet gezet.
    console.warn('[AP] reaction migration failed:', e.message);
  }
  return uit;
}

/**
 * Van wat de client stuurde naar de canonieke sleutel voor een reactie.
 *
 * Een post heeft twee URI's: zijn AP-object-id (.../ap/notes/<uuid>) en zijn
 * leesbare permalink (.../effortlesseffect). De Krant en het C2S-pad spreken de
 * eerste, de interact-pagina de tweede. Werden reacties onder allebei opgeslagen,
 * dan bestond dezelfde like twee keer -- en erger: een like uit de Krant was op
 * de interact-pagina onzichtbaar, want daar werd op de permalink gezocht.
 *
 * Dit was de naad die fase 1 bewust open liet ("samentrekken is werk voor fase
 * 2"). Robin liep er meteen tegenaan: een geboost en geliket bericht toonde geen
 * highlight. Vandaar hier, en niet later.
 *
 * De object-URI wint, want dat is waar ap_timeline op sleutelt en waar de
 * backfill op is gebaseerd. Kennen we de post niet, dan blijft de invoer staan:
 * een reactie op iets buiten je tijdlijn moet gewoon werken.
 */
export function canonicalReactionUri(slug, uri) {
  if (!slug || !uri) return uri;
  try {
    if (db.prepare('SELECT 1 FROM ap_timeline WHERE slug = ? AND id = ?').get(slug, uri)) return uri;
    const row = db.prepare('SELECT id FROM ap_timeline WHERE slug = ? AND url = ? LIMIT 1').get(slug, uri);
    return (row && row.id) || uri;
  } catch { return uri; }
}

/**
 * Wat heb IK met dit object gedaan? Leest de tussentabel, de bron van waarheid
 * sinds shaer-9e9 fase 2. Vervangt getMyReactions en getTimelineReaction, die
 * dezelfde vraag beantwoordden uit twee verschillende bronnen.
 */
export function getReaction(slug, uri) {
  try {
    const key = canonicalReactionUri(slug, uri);
    const rows = (slug && key)
      ? db.prepare('SELECT kind FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ?').all(slug, key)
      : [];
    return { liked: rows.some((r) => r.kind === 'like'), boosted: rows.some((r) => r.kind === 'boost') };
  } catch { return { liked: false, boosted: false }; }
}

/**
 * Dezelfde vraag voor een hele pagina in EEN query. De C2S-tijdlijn zet
 * shaer:liked op elke post; per rij vragen zou dat een N+1 maken, en dan had je
 * een consistentiebug geruild voor een traagheidsbug.
 */
export function getReactionsFor(slug, uris) {
  const out = new Map();
  const list = [...new Set((uris || []).filter(Boolean))].slice(0, 500);
  if (!slug || !list.length) return out;
  try {
    const rows = db.prepare(
      `SELECT target_uri, kind FROM ap_my_reactions
        WHERE site_slug = ? AND target_uri IN (${list.map(() => '?').join(',')})`,
    ).all(slug, ...list);
    for (const r of rows) {
      const cur = out.get(r.target_uri) || { liked: false, boosted: false };
      if (r.kind === 'like') cur.liked = true;
      if (r.kind === 'boost') cur.boosted = true;
      out.set(r.target_uri, cur);
    }
  } catch { /* leeg = niets gereageerd, en dat is een veilige uitkomst */ }
  return out;
}

export function setReaction(slug, uri, kind, on, opts = {}) {
  if (!slug || !uri || (kind !== 'like' && kind !== 'boost')) return;
  // Ook hier, en niet alleen bij sendInteraction. Deze functie schrijft ALLEEN de
  // lokale vlag; het versturen gebeurt elders. Zonder deze poort zou je op een
  // verhuisd account een like zien staan die nooit de deur uit is gegaan, en dat
  // is de halve toestand die erger is dan een duidelijke weigering.
  try {
    const s = db.prepare('SELECT moved_to FROM sites WHERE slug = ?').get(slug);
    if (movedLock(s).locked) { console.warn('[AP] reactie geweigerd, account verhuisd:', slug, kind); return; }
  } catch { /* geen sites-tabel = geen verhuizing */ }
  // EEN sleutel voor beide bronnen. opts.flagUri is de opgeloste object-URI van
  // de aanroeper (het C2S-pad kent die uit resolveRemoteNote en dat is
  // betrouwbaarder dan onze cache); anders leiden we hem af. Vroeger kreeg de
  // tussentabel de URI die de client stuurde en de vlag de opgeloste -- dat
  // maakte dezelfde like onvindbaar vanaf de andere pagina.
  const flagUri = opts.flagUri || canonicalReactionUri(slug, uri);
  setMyReaction(slug, flagUri, kind, !!on);
  if (kind === 'boost') {
    if (!on) unmarkBoosted(slug, flagUri);
    else if (opts.note) upsertBoostedNote(slug, opts.note);
    else markBoosted(slug, flagUri);
  } else if (on) markLiked(slug, flagUri);
  else unmarkLiked(slug, flagUri);
}

export function getTimelineReaction(slug, noteId) {
  try { const r = db.prepare('SELECT liked, boosted FROM ap_timeline WHERE slug = ? AND id = ?').get(slug, noteId); return { liked: !!(r && r.liked), boosted: !!(r && r.boosted) }; } catch { return { liked: false, boosted: false }; }
}
// Boost a REMOTE post that may not be in your timeline (you don't follow the author):
// store it in ap_timeline (INSERT OR IGNORE → no dup for followed posts) so it shows in
// the Cirkel with a Boost badge, then flag it boosted.
export function upsertBoostedNote(slug, note) {
  if (!slug || !note || !note.object_uri) return;
  const id = note.object_uri;
  // Prefer the full typed media (incl. video/mp4 — a Loops boost is video-only and
  // rendered a bare text tile); fall back to the image-only list for older callers.
  const media = (note.media && note.media !== '[]')
    ? note.media
    : JSON.stringify((note.images || []).map((u) => ({ url: u, type: 'image/jpeg' })));
  try {
    const r = tlStmts().ins.run(id, slug, note.actor_uri || '', note.actor_name || '', note.actor_handle || '',
      note.actor_icon || '', note.actor_url || '', note.content || '', note.url || null,
      new Date().toISOString(), media, note.sensitive ? 1 : 0, note.cw || null);
    if (!r.changes) {
      // Row already cached (INSERT OR IGNORE) → refresh it with the freshly
      // resolved note. Without this a row cached without its cover (or with
      // stale content) stayed stale forever — even boosting again didn't heal it.
      // Keep the CACHED media when the resolve yielded none: an empty re-resolve
      // used to clobber a good media_json (the followed copy had the video, the
      // boost wiped it to []).
      db.prepare(`UPDATE ap_timeline SET content = ?, media_json = CASE WHEN ? = '[]' THEN media_json ELSE ? END,
                  nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE slug = ? AND id = ?`)
        .run(note.content || '', media, media, note.sensitive ? 1 : 0, note.cw || null, note.url || null, slug, id);
    }
  } catch { /* ignore */ }
  markBoosted(slug, id);
}
export function boostedCount(slug) {
  // Geboost EN in je tijdlijn, zoals voorheen: de tussentabel kan ook een boost
  // bevatten van iets dat er (nog) niet in staat.
  try {
    if (!_boostedCount) _boostedCount = db.prepare(`SELECT COUNT(*) AS n FROM ap_my_reactions r
      JOIN ap_timeline t ON t.slug = r.site_slug AND t.id = r.target_uri
      WHERE r.site_slug = ? AND r.kind = 'boost'`);
    return _boostedCount.get(slug).n;
  } catch { return 0; }
}
