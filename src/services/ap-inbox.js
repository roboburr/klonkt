/**
 * ap-inbox.js — de inbox (stap 9 van shaer-drc).
 *
 * Het hart van de federatie-ontvangst: handleInbox (de grote switch over
 * Follow, Accept, Undo, Create, Like, Announce, Delete, Update, Move, Flag en
 * Block), de her-verificatie van doorgestuurde activiteiten
 * (dereferenceForwarded, shaer-s8k) en de kleine kas eromheen (bekende notes,
 * geziene notes, recente ophaal-missers).
 *
 * De inbox is de SCHAKELKAST van de dienst: hij raakt vrijwel elk cluster.
 * Wat al een eigen module heeft komt statisch binnen (transport, tijdlijn,
 * peilingen, volgwinkel, guardianship, ap-core); de tweeendertig werktuigen
 * die nog in de dienstlaag wonen komen via wireInbox. Die lijst is bewust
 * lang en expliciet -- hij IS de kaart van wat de inbox aanraakt, en elke
 * naam die er ooit afgaat is een cluster dat zelf verhuisd is.
 * De §5.3-goedkeuring (handleFollowApprovalInbox) blijft bij zijn
 * guardian-broers in de dienst, zoals gateOutgoingFollow bij stap 7.
 */
import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';
import * as Guardianship from './guardianship/index.js';
import { t as i18nT } from './i18n.js';
import { safeUrl, actorId, AP_CONTEXT } from './ap-core.js';
import {
  verifyRequest, fetchActor, deliver, deliverWithRetry, signedGetJson,
  apGetJson, anySigningSlug, getOrCreateKeys,
} from './ap-transport.js';
import { tlStmts, extractEmojiTags, extractLinkJson, quoteHrefOf } from './ap-timeline.js';
import { parsePoll, recordPollBallot } from './ap-polls.js';
import { fwStmts } from './ap-following.js';

/**
 * Welke objectsoorten deze inbox in de tijdlijn opneemt.
 *
 * `Audio` staat erbij sinds de kanaalbeslissing (shaer-0nh): een Funkwhale-
 * kanaal stuurt Create(Audio), geen Note. Uitbreiden gebeurt HIER en in
 * timelineFields -- en uitdrukkelijk NIET door vreemde soorten tot Note om te
 * vormen. Een Audio is geen Note, en die soort willen we kunnen blijven zien.
 */
const TIJDLIJN_SOORTEN = new Set(['Note', 'Article', 'Question', 'Audio']);

// De werktuigen uit de dienstlaag; ActivityPubService vult ze onderaan.
let actorInfo, actorUriOf, backfillFromOutbox, backfillNewFollower,
  belongsInTimeline, contentWarning, emojiJsonOf, fetchNoteAP,
  findThreadTarget, fStmts, handleFollowApprovalInbox, handleMoveInbox,
  isBlockedAny, isRejectedObject, iStmts, libraryOwnerSlug, localMentionSlugs,
  localPostExists, localSlugOf, mediaFromNote, noteVisibility,
  postIdFromNoteUrl, pushEvent, pushLang, pushPostCtx, pushPrefix,
  resolveCard, resolveExternalEmbed, resolveQuote, rid, slugFromActorUrl,
  storeAuthorEmoji, timelineFields, wakeGuardian;
export function wireInbox(deps) {
  ({ actorInfo, actorUriOf, backfillFromOutbox, backfillNewFollower,
    belongsInTimeline, contentWarning, emojiJsonOf, fetchNoteAP,
    findThreadTarget, fStmts, handleFollowApprovalInbox, handleMoveInbox,
    isBlockedAny, isRejectedObject, iStmts, libraryOwnerSlug,
    localMentionSlugs, localPostExists, localSlugOf, mediaFromNote,
    noteVisibility, postIdFromNoteUrl, pushEvent, pushLang, pushPostCtx,
    pushPrefix, resolveCard, resolveExternalEmbed, resolveQuote, rid,
    slugFromActorUrl, storeAuthorEmoji, timelineFields, wakeGuardian } = deps);
}

/**
 * Een DOORGESTUURDE activiteit alsnog verifiëren (shaer-s8k).
 *
 * Reageert iemand in een thread, dan stuurt de server van de oorspronkelijke
 * poster die reactie door naar de deelnemers -- en ondertekent met zijn EIGEN
 * sleutel. De handtekening klopt dan, maar de ondertekenaar is niet de auteur,
 * dus de gate hieronder wees hem af. Gevolg: reacties van derden kwamen niet
 * binnen, zonder dat iemand een fout zag.
 *
 * Mastodon lost dit op met een LD-Signature over de payload. Dat vraagt
 * JSON-LD-canonicalisatie; wij doen het lichter en strenger: we geloven de
 * bezorgde inhoud NIET en halen het object op bij de bron.
 *
 * Vier voorwaarden, en geen ervan is optioneel:
 *
 *  1. Alleen Create en Update. Een doorgestuurde Delete is per definitie niet te
 *     dereferencen -- het object is weg -- dus die blijft geweigerd.
 *  2. De host van de object-id MOET die van de geclaimde actor zijn. Zonder dit
 *     anker wijst een doorsturer je naar een host die hij zelf beheert, waar
 *     attributedTo alles kan beweren.
 *  3. Het OPGEHAALDE object wordt gebruikt, niet de bezorgde payload. Anders
 *     levert een doorsturer een echt id met verdraaide inhoud.
 *  4. Mislukt het ophalen, of wijst het object zichzelf niet toe aan de
 *     geclaimde actor, dan blijft het een weigering. Geen twijfelgeval opslaan.
 */
/** Kennen we deze note? Een eigen post, een eigen outbox-antwoord, een
 *  gecachete post in de tijdlijn, of een reactie die al in een thread van ons
 *  staat. Alle vier zijn een geldige reden dat iemand ons een antwoord daarop
 *  doorstuurt; iets anders is dat niet. */
function knownNoteUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  try {
    if (base && uri.startsWith(`${base}/ap/notes/`)) {
      const seg = decodeURIComponent(uri.slice(`${base}/ap/notes/`.length).split(/[?#]/)[0]);
      if (db.prepare('SELECT 1 FROM ap_outbox WHERE id = ?').get(seg)) return true;
      if (db.prepare('SELECT 1 FROM posts WHERE id = ?').get(seg)) return true;
    }
    if (db.prepare('SELECT 1 FROM ap_timeline WHERE id = ? LIMIT 1').get(uri)) return true;
    if (db.prepare('SELECT 1 FROM ap_interactions WHERE object_uri = ? LIMIT 1').get(uri)) return true;
    // Een antwoord dat we al bezorgd kregen van iemand die we volgen (shaer-e9g).
    if (db.prepare('SELECT 1 FROM ap_seen_notes WHERE uri = ? LIMIT 1').get(uri)) return true;
  } catch { /* bij twijfel niet ophalen */ }
  return false;
}

/**
 * Onthoud dat we dit bericht al eens bezorgd kregen.
 *
 * Alleen de URI. Geen inhoud, niets op het scherm, geen tweede weergave -- dit
 * beantwoordt uitsluitend de vraag "kennen wij dit bericht?" die knownNoteUri
 * stelt voordat er iets bij de bron wordt opgehaald.
 *
 * De beller bepaalt WIE er onthouden wordt, en dat is de hele veiligheidsvraag:
 * onthouden we zomaar alles wat iemand aflevert, dan kan een vreemde eerst een
 * bericht neerleggen en daarna met een doorgestuurd antwoord dáárop ons naar een
 * adres van zijn keuze sturen. Vandaar dat handleInbox dit alleen doet voor
 * schrijvers die je zelf volgt.
 */
const SEEN_NOTES_DAYS = 30;
let _seenSinceSnoei = 0;
function rememberNoteUri(uri) {
  if (!uri || typeof uri !== 'string') return;
  try {
    db.prepare('INSERT OR IGNORE INTO ap_seen_notes (uri) VALUES (?)').run(uri);
    // Af en toe opruimen, niet bij het opstarten: een server die weken doorloopt
    // zou anders nooit snoeien. Doorsturen gebeurt kort na het antwoord, dus wat
    // ouder is dan een maand beantwoordt geen enkele vraag meer.
    if (++_seenSinceSnoei >= 500) {
      _seenSinceSnoei = 0;
      const r = db.prepare(`DELETE FROM ap_seen_notes WHERE created_at < datetime('now', '-${SEEN_NOTES_DAYS} days')`).run();
      if (r.changes) console.log(`[AP] seen notes: ${r.changes} pruned`);
    }
  } catch { /* niet fataal */ }
}
const isFollowedActor = (uri) => {
  try { return !!db.prepare('SELECT 1 FROM ap_following WHERE actor_uri = ? LIMIT 1').get(uri); } catch { return false; }
};

// Mislukte dereferences kort onthouden. Mastodon herhaalt een bezorging
// dagenlang; zonder dit doet elke herhaling de fetch opnieuw, ook als die de
// vorige twintig keer niets opleverde. Dempt meteen de scherpte van misbruik.
const _derefMiss = new Map();
const DEREF_MISS_MS = 30 * 60 * 1000;
function derefRecentlyFailed(uri) {
  const t = _derefMiss.get(uri);
  if (t === undefined) return false;
  if (Date.now() - t > DEREF_MISS_MS) { _derefMiss.delete(uri); return false; }
  return true;
}
function noteDerefFailure(uri) {
  if (_derefMiss.size > 500) {   // simpele begrenzing: oudste helft eruit
    const oud = [..._derefMiss.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
    for (const [k] of oud) _derefMiss.delete(k);
  }
  _derefMiss.set(uri, Date.now());
}

async function dereferenceForwarded(act, claimedActor, type, slugParam) {
  // Every exit states its reason. Five of the six used to return silently, so a
  // rejection count could not be told apart from a narrowing that closed too far
  // — and that is exactly the measurement shaer-drf is waiting for. Bounded by
  // the signer-mismatch rate (tens per hour), so this is not a noisy log.
  const skipped = (reason, detail) => {
    console.log(`[AP] inbox forwarded, skipped (${reason}):`, claimedActor, detail || '');
    return null;
  };
  if (type !== 'Create' && type !== 'Update') return skipped('not Create/Update', type);
  const o = act && act.object;
  const objId = typeof o === 'string' ? o : (o && o.id);
  if (!objId || typeof objId !== 'string' || !/^https:\/\//i.test(objId)) return skipped('no https object id', objId || '(none)');
  try {
    if (new URL(objId).host !== new URL(claimedActor).host) return skipped('host anchor', objId);   // ankereis
  } catch { return skipped('unparsable id', objId); }
  // Alleen dereferencen als het object beweert een antwoord te zijn op iets van
  // ONS (shaer-drf). Zonder die eis zijn claimedActor en object.id allebei door
  // de aanvaller gekozen en eist het host-anker alleen dat ze aan elkaar gelijk
  // zijn -- dan kan iedereen met een werkende actor ons naar elke URL sturen.
  // Doorsturen bestaat juist omdát wij in de thread zitten, dus deze eis kost
  // niets aan legitiem verkeer waarvan we de ouder kennen.
  const parent = typeof o === 'object' && o
    ? (typeof o.inReplyTo === 'string' ? o.inReplyTo : (o.inReplyTo && o.inReplyTo.id))
    : null;
  if (!knownNoteUri(parent)) return skipped('unknown inReplyTo', parent || '(none)');
  if (derefRecentlyFailed(objId)) return skipped('recent failure', objId);
  // Onbetekend eerst; tekenen alleen als terugval. Anders kan een ander ons een
  // ONDERTEKEND verzoek naar een adres van zijn keuze laten sturen -- dezelfde
  // reden als bij fetchActor sinds efe5633.
  let fetched = await apGetJson(objId).catch(() => null);
  if (!fetched || fetched.id !== objId) {
    // The signer used to be slugParam, which is null on the shared inbox — and
    // that is where forwarded traffic lands, because we advertise a sharedInbox.
    // signedGetJson falls back to an unsigned GET for a null slug, so a source in
    // secure mode could never be dereferenced at all. Same fix verifyRequest got
    // in shaer-afq: any local actor is a valid signer.
    const asSlug = slugParam || anySigningSlug();
    if (asSlug) fetched = await signedGetJson(asSlug, objId).catch(() => null);
  }
  const attributed = fetched && (typeof fetched.attributedTo === 'string'
    ? fetched.attributedTo
    : (fetched.attributedTo && fetched.attributedTo.id));
  if (!fetched || fetched.id !== objId) {
    noteDerefFailure(objId);
    return skipped('fetch failed', objId);
  }
  if (attributed !== claimedActor) {
    // Not a transport hiccup: the source itself says someone else wrote this.
    noteDerefFailure(objId);
    return skipped('attributedTo mismatch', `${objId} claims ${attributed || '(none)'}`);
  }
  return fetched;
}

// Handle an incoming inbox POST. slugParam = null for the shared /ap/inbox.
export async function handleInbox(req, slugParam, preVerified = null) {
  const act = req.body || {};
  const type = act.type;
  // Real client IP (behind the proxy via `trust proxy`) — logged on dropped/rejected/
  // ignored inbox hits so an operator can see who is probing their fediverse inbox.
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '?';
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  // preVerified is the loopback (see deliverToActor): a delivery between two
  // actors on THIS instance never crosses a socket, so there is no signature to
  // check — but we do know who signed, because we signed it. Handing that in
  // keeps everything below identical, including the actor-versus-signer check,
  // which is exactly the check that must not be skipped for being local.
  const verified = preVerified || await verifyRequest(req, slugParam).catch(() => null);

  // ENFORCE HTTP signatures: a data-affecting activity must be signed by the very
  // actor it claims to be. No valid signature, or signer ≠ actor → reject (no
  // forged replies/likes/follows/timeline posts). GET/discovery stays open.
  const claimedActor = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  // Blocked actor/domain → silently drop (202, don't reveal the block).
  if (claimedActor && isBlockedAny(claimedActor)) { console.log('[AP] inbox dropped (blocked)', claimedActor, 'from', ip); return 202; }
  const GATED = ['Create', 'Like', 'Announce', 'Follow', 'Delete', 'Undo', 'Accept', 'Reject', 'Add', 'Remove', 'Update', 'Flag', 'Offer', 'Move'];
  if (GATED.includes(type)) {
    // Een geldige handtekening van iemand anders dan de auteur is doorsturen,
    // geen vervalsing. Haal het object dan bij de bron op in plaats van het af
    // te wijzen; lukt dat niet, dan valt het door naar de weigering hieronder.
    let forwarded = null;
    if (verified && claimedActor && verified.id !== claimedActor) {
      forwarded = await dereferenceForwarded(act, claimedActor, type, slugParam).catch(() => null);
      if (forwarded) {
        act.object = forwarded;   // de OPGEHAALDE inhoud, niet de bezorgde
        console.log('[AP] inbox forwarded, verified at the source:', type, claimedActor, 'via', verified.id);
      }
    }
    if (!forwarded && (!verified || !claimedActor || verified.id !== claimedActor)) {
      // Drie verschillende oorzaken, die eerder allemaal "unsigned/invalid"
      // heetten: geen handtekening meegestuurd, wel een handtekening maar niet
      // te verifiëren (meestal een opgeheven account waarvan de sleutel weg is),
      // of geldig ondertekend door iemand anders.
      const reden = verified ? '(signer mismatch)'
        : (req.headers && req.headers.signature) ? '(signature present, unverifiable)'
        : '(no signature)';
      console.warn('[AP] inbox REJECTED (signature)', type, claimedActor || '?', 'from', ip, reden);
      return 401;
    }
    // One answer restores everything (FEP-633c 3.6): any VERIFIED activity
    // from an actor that guards someone here restores it to active for those
    // wards and cancels any lapse running against it, before the activity is
    // even looked at. Signature-gated on purpose: an unverified claim of
    // being gran must not wake gran up.
    try {
      const ev = Guardianship.availability.oneAnswer(claimedActor, Date.now());
      if (ev.restored.length) console.log('[AP] guardian restored (one answer, 3.6):', claimedActor, '→', ev.restored.join(', '));
      for (const c of ev.cancelledLapses) console.log('[AP] lapse cancelled by an answer from its target:', c.id);
    } catch { /* availability is never load-bearing for delivery */ }
  }

  // FEP-633c §5.3 (modelled on the adoption offer): a gated follow forwarded to
  // the guardians as an Offer(Follow), their Accept/Reject back to the ward.
  if ((type === 'Offer' || type === 'Accept' || type === 'Reject') && act['shaer:followApproval'] === true) {
    if (await handleFollowApprovalInbox(act, slugParam)) { console.log('[AP] follow-approval', type, 'from', claimedActor); return 202; }
  }

  // FEP-633c: the adoption handshake. An Offer lands at the local ward; an
  // Accept/Reject answers an offer a local guardian sent. Anything the
  // guardianship module does not recognize falls through to the old paths.
  // An Undo of the guardianship Relationship (§3.2) is handled here too, and it
  // must be seen BEFORE the generic Undo branch below, which only knows about
  // Follow/Like/Announce and would swallow it with a 202.
  if (type === 'Offer' || type === 'Accept' || type === 'Reject' || (type === 'Undo' && Guardianship.parseUndoRelationship(act))) {
    // Every LOCAL party this activity is addressed to gets its own copy of the
    // handshake (a ward and a co-guardian may both live here). Gather candidate
    // local slugs from the inbox owner, the `to` list, and the ward.
    // MET localSlugOf en niet met slugFromActorUrl. Dat laatste knipt alleen de
    // staart van een pad af, zonder naar de HOST te kijken -- en deze uri's
    // komen uit `to` en uit de relatie, dus van de afzender. Een Offer gericht
    // aan https://elders.example/ap/users/dev leverde zo de slug "dev" op, en
    // die bestaat hier. Dan draait onze dev de afhandeling van een activiteit
    // die nooit aan hem geadresseerd was. localSlugOf eist dat de uri met onze
    // eigen basis begint en dat de site echt bestaat.
    const cand = new Set();
    if (slugParam) cand.add(slugParam);
    for (const t of (Array.isArray(act.to) ? act.to : (act.to ? [act.to] : []))) {
      if (typeof t === 'string') { const s = localSlugOf(t); if (s) cand.add(s); }
    }
    if (type === 'Offer' || type === 'Undo') {
      const rel = type === 'Undo' ? Guardianship.parseUndoRelationship(act) : Guardianship.parseRelationship(act.object);
      if (rel) { const s = localSlugOf(rel.ward); if (s) cand.add(s); }
    }
    let consumed = false;
    for (const slug of cand) {
      const gsite = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
      if (gsite && await Guardianship.handleGuardianshipInbox(gsite, act).catch(() => false)) consumed = true;
    }
    if (consumed) { console.log('[AP] guardianship', type, 'from', claimedActor); return 202; }
  }

  // A moderation report (Flag) about our content — store it for the targeted site's owner
  // (each Klonkt site is moderated by its own owner). Signature is enforced (GATED).
  if (type === 'Flag') {
    const objs = Array.isArray(act.object) ? act.object : (act.object ? [act.object] : []);
    const objectUris = objs.map((o) => (typeof o === 'string' ? o : (o && o.id))).filter(Boolean);
    let targetSlug = null;
    const noteIds = [];
    for (const u of objectUris) {
      const s = localSlugOf(u);             // one of OURS -- host meegewogen
      if (s) { targetSlug = targetSlug || s; continue; }
      const pid = postIdFromNoteUrl(u, base); // one of our notes?
      if (pid) noteIds.push(pid);
    }
    if (!targetSlug && noteIds.length) {
      try { const r = db.prepare('SELECT s.slug FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ? LIMIT 1').get(noteIds[0]); if (r) targetSlug = r.slug; } catch { /* ignore */ }
    }
    if (!targetSlug) return 202; // not about us / can't tell → drop
    // Flag is GATED, so `verified` is the signer's (reporter's) actor doc already.
    const ai = actorInfo(verified || null, claimedActor);
    try {
      db.prepare('INSERT INTO ap_reports (slug, actor_uri, actor_name, actor_handle, actor_icon, content, objects, created_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .run(targetSlug, claimedActor || null, ai.name, ai.handle, ai.icon, HtmlSanitizerService.toPlainText(act.content || '').slice(0, 3000), JSON.stringify(objectUris.slice(0, 20)));
      console.log('[AP] report received for', targetSlug, 'from', claimedActor);
    } catch { /* ignore */ }
    return 202;
  }

  // FEP-7628 (DRAFT): an account moved house. Handled before Follow on purpose:
  // a Move often arrives seconds before the new actor's re-Follow wave, and the
  // swap below must not race our own outgoing Follow of the target.
  if (type === 'Move') {
    return handleMoveInbox(act, { verifiedActor: claimedActor });
  }

  if (type === 'Follow') {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    // EERST: volgt iemand onze BIBLIOTHEEK in plaats van onze actor? (shaer-0nh)
    //
    // Een luisteraar krijgt de muziek en NIET de gewone posts -- wie zich
    // abonneert op een platenkast heeft niet om de Krant gevraagd. Vandaar een
    // eigen tabel: zolang ze daar staan kan een postbezorging ze niet per
    // ongeluk meenemen.
    //
    // De bibliotheek is openbaar (alles erin is fedi_open), dus dit accepteert
    // meteen. Er valt niets goed te keuren, en dan is wachten oneerlijk.
    const libSlug = libraryOwnerSlug(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (who && libSlug) {
      const remote = await fetchActor(who);
      if (!remote || !remote.inbox) return 202;
      const fi = actorInfo(remote, who);
      luisteraars.voegToe(libSlug, {
        actorUri: who, inbox: remote.inbox,
        sharedInbox: (remote.endpoints && remote.endpoints.sharedInbox) || null,
        name: fi.name, handle: fi.handle, icon: fi.icon,
      });
      const keys = getOrCreateKeys(libSlug);
      const accept = {
        '@context': AP_CONTEXT,
        id: `${actorId(base, libSlug)}#accept-library-${Date.now()}-${rid()}`,
        type: 'Accept', actor: actorId(base, libSlug), object: act,
      };
      deliver(remote.inbox, accept, `${actorId(base, libSlug)}#main-key`, keys.privatePem)
        .catch(() => { /* de volger staat er; een mislukte Accept mag dat niet omgooien */ });
      console.log('[AP] library follow from', who, '->', libSlug);
      return 202;
    }
    // slugParam is de eigenaar van een per-actor inbox; op de GEDEELDE inbox is
    // die er niet en werd de slug uit act.object geraden. Zonder hostcontrole
    // kon een Follow op andermans actor met dezelfde padstaart hier een volger
    // opleveren.
    const slug = slugParam || localSlugOf(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (!who || !slug) return 400;
    const remote = await fetchActor(who);
    if (!remote || !remote.inbox) return 202; // can't reach them → drop quietly
    const sharedInbox = (remote.endpoints && remote.endpoints.sharedInbox) || null;
    const fi = actorInfo(remote, who);   // cache display for the friends list (shaer-aa3)
    // FEP-633c §5.3: if the followed actor is a WARD (has guardians), the
    // follow is gated. A committed guardian's own Follow is auto-accepted
    // (it needs no gate); anyone else is held pending for guardian approval.
    // Free actors / normal sites have no guardians → fall through, unchanged.
    const wardGuardians = Guardianship.listGuardians(slug).map((g) => g.other_uri);
    if (wardGuardians.length && !wardGuardians.includes(who)) {
      const followId = (typeof act.id === 'string' && act.id) || `${who}#follow-${Date.now()}-${rid()}`;
      Guardianship.follows.recordPending(slug, {
        id: followId, follower: who, inbox: remote.inbox, sharedInbox,
        name: fi.name, handle: fi.handle, icon: fi.icon, activity: act,
      });
      // FEP-633c §5.3, modelled on the guardian offer: the ward forwards the
      // gated follow to its guardians for approval. A LOCAL guardian gets a
      // push and reads /guardian directly; a REMOTE guardian gets an
      // Offer(Follow) delivered so its instance stores a copy (same distributed
      // pattern as the adoption offer). On quorum the ward returns Accept(Follow).
      const wardActor = actorId(base, slug);
      const wardKeys = getOrCreateKeys(slug);
      const followObj = { id: followId, type: 'Follow', actor: who, object: wardActor };
      // Dormancy evidence (FEP-633c 3.6.2): this decision directly addresses
      // every guardian. The ONLY admissible evidence is a request like this
      // one going unanswered; recordRequest itself skips a declared absence.
      for (const g of wardGuardians) {
        try { Guardianship.availability.recordRequest(slug, g, followId, Date.now()); } catch { /* never load-bearing */ }
      }
      for (const g of wardGuardians) {
        // Local ONLY when the guardian lives on THIS instance: slugFromActorUrl
        // ignores the host (an /ap/users/x path on a remote host is someone
        // else's actor), so also require our base + an existing local site.
        const gslug = g.startsWith(`${base}/`) ? slugFromActorUrl(g) : null;
        const isLocal = gslug && db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(gslug);
        if (isLocal) {
          const L = pushLang(gslug);
          // Een volgverzoek is geen mede-voogdij. Deze push leende de tekst van
          // offer_for_ward en meldde dus een adoptie die niet gebeurde -- met de
          // volger als onderwerp. Eigen woorden, en allebei de namen erin: wie
          // er vraagt, en om wie het gaat (shaer-p729).
          pushEvent(gslug, { type: 'guardian', title: i18nT(L, 'push.n_guard_folin_t'), body: i18nT(L, 'push.n_guard_folin_b', { who: fi.name || fi.handle || i18nT(L, 'notif.someone'), ward: slug }), url: `${pushPrefix(gslug)}/guardian` });
        } else {
          fetchActor(g).then((ga) => {
            const inbox = ga && ((ga.endpoints && ga.endpoints.sharedInbox) || ga.inbox);
            if (!inbox) return;
            const beslissend2 = Guardianship.gated.isDecisive(0, Guardianship.follows.followThreshold(guardians.length));
            const offer = { '@context': AP_CONTEXT, id: `${wardActor}#followoffer-${Date.now()}-${rid()}`, type: 'Offer', actor: wardActor, to: [g], object: followObj, 'shaer:followApproval': true, 'shaer:decisive': beslissend2 };
            deliverWithRetry(slug, inbox, offer, `${wardActor}#main-key`, wardKeys.private_pem).catch(() => {});
          }).catch(() => {});
        }
      }
      console.log('[AP] Follow', who, '→ ward', slug, '(gated, awaiting guardians)');
      return 202;
    }
    // De eigenaarspoort (Robins wens, 18-8): met approve_followers aan wordt
    // een Follow niet automatisch geaccepteerd — hij wacht in dezelfde
    // wachtrij als een ward-follow, maar hier beslist de EIGENAAR, op
    // /connect. Zo kan niemand een klonkt zomaar aan een hub of ander
    // verzamelplatform hangen zonder dat de eigenaar ja heeft gezegd.
    // Wards vallen hier nooit: de guardianpoort hierboven gaat vóór.
    const ownerGate = db.prepare('SELECT approve_followers FROM sites WHERE slug = ?').get(slug);
    if (ownerGate && ownerGate.approve_followers) {
      const followId = (typeof act.id === 'string' && act.id) || `${who}#follow-${Date.now()}-${rid()}`;
      Guardianship.follows.recordPending(slug, {
        id: followId, follower: who, inbox: remote.inbox, sharedInbox,
        name: fi.name, handle: fi.handle, icon: fi.icon, activity: act, quorum: 'owner',
      });
      const L = pushLang(slug);
      pushEvent(slug, {
        type: 'follow',
        title: i18nT(L, 'push.n_folreq_t'),
        body: i18nT(L, 'push.n_folreq_b', { who: fi.name || fi.handle || i18nT(L, 'notif.someone') }),
        url: `${pushPrefix(slug)}/connect`,
      });
      console.log('[AP] Follow', who, '→', slug, '(awaiting owner approval)');
      return 202;
    }
    fStmts().ins.run(slug, who, remote.inbox, sharedInbox, fi.name, fi.handle, fi.icon);
    try { _updFDisp.run(fi.name, fi.handle, fi.icon, slug, who); } catch { /* best effort */ }
    { const L = pushLang(slug); pushEvent(slug, { type: 'follow', title: i18nT(L, 'push.n_follow_t'), body: i18nT(L, 'push.n_follow_b', { who: fi.name || fi.handle || i18nT(L, 'notif.someone') }), url: `${pushPrefix(slug)}/connect` }); }
    const me = actorId(base, slug);
    const keys = getOrCreateKeys(slug);
    const accept = { '@context': AP_CONTEXT, id: `${me}#accept-${Date.now()}-${rid()}`, type: 'Accept', actor: me, object: act };
    deliver(remote.inbox, accept, `${me}#main-key`, keys.private_pem).catch((e) => console.warn('[AP] Accept delivery failed:', e.message));
    // Auto-backfill: send our recent posts as Create so the instance has our history
    // (Mastodon doesn't fetch history on follow). ONCE PER REMOTE INSTANCE only —
    // Mastodon dedupes notes per-instance, so re-filling an instance that already has
    // a follower of ours is wasted work (and won't re-populate the new follower's
    // timeline anyway). Deliver to the shared inbox (instance-level) when present.
    // Sync insert+check (no await between) → no interleave race with concurrent Follows.
    const instanceFilled = sharedInbox &&
      db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND shared_inbox = ? AND actor_uri != ? LIMIT 1')
        .get(slug, sharedInbox, who);
    if (!instanceFilled) {
      backfillNewFollower(base, slug, sharedInbox || remote.inbox).catch(() => { /* best-effort */ });
    }
    console.log('[AP] Follow', who, '→', slug, verified ? '(sig ok)' : '(sig unverified)');
    return 202;
  }
  // Een luisteraar die weggaat, hoort meteen weg te zijn.
  if (type === 'Undo' && act.object && act.object.type === 'Follow') {
    const doel = typeof act.object.object === 'string' ? act.object.object : (act.object.object && act.object.object.id);
    const libSlug = libraryOwnerSlug(doel);
    const wie = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    if (libSlug && wie && luisteraars.verwijder(libSlug, wie)) {
      console.log('[AP] library unfollow from', wie, '->', libSlug);
      return 202;
    }
  }

  if (type === 'Undo' && act.object) {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    const ot = act.object.type;
    if (ot === 'Follow') {
      const obj = act.object.object;
      const slug = slugParam || slugFromActorUrl(typeof obj === 'string' ? obj : (obj && obj.id));
      if (who && slug) { fStmts().del.run(slug, who); console.log('[AP] Unfollow', who, '→', slug); }
      return 202;
    }
    if (ot === 'Like' || ot === 'Announce') {
      const tgt = act.object.object;
      const pid = postIdFromNoteUrl(typeof tgt === 'string' ? tgt : (tgt && tgt.id), base);
      if (who && pid) { iStmts().delLA.run(ot.toLowerCase(), pid, who); console.log('[AP] Undo', ot, who, '→', pid); }
      return 202;
    }
    return 202;
  }

  const actorUri = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  const resolveActor = async (uri) => ((verified && verified.id === uri) ? verified : await fetchActor(uri).catch(() => null));
  // Our OWN activity is already stored via ap_outbox: don't store it twice.
  // "Our own" means THIS inbox's owner, not "anyone who happens to live on this
  // machine". The old reading dropped every activity between two sites on one
  // instance, so a note from a co-located guardian to its ward was accepted
  // with a 202 and then quietly thrown away: no mention, no away, no help
  // request. Neighbours are not us (Robins regel, 29-7: on this machine
  // everything behaves as if every Klonkt were somewhere else).
  const isLocalActor = !!(actorUri && slugParam && actorUri === actorId(base, slugParam));

  // Inbound reply: a Create whose object replies to one of our notes (post OR comment).
  if (type === 'Create' && act.object && TIJDLIJN_SOORTEN.has(act.object.type)) {
    const o = act.object;
    // A poll ballot: a Note carrying a `name` (the chosen option) inReplyTo one of OUR poll
    // posts. Record it (deduped per actor) BEFORE the reply logic so a vote is never stored
    // as a comment. recordPollBallot returns handled=false only if the target isn't a poll.
    if (o.name && o.inReplyTo && actorUri && !isLocalActor) {
      const seg = postIdFromNoteUrl(o.inReplyTo, base);
      if (seg && localPostExists(seg)) {
        const rec = recordPollBallot(seg, actorUri, o.name);
        if (rec.handled) { console.log('[AP] poll vote', actorUri, '→', seg); return 202; }
      }
    }
    const tgt = findThreadTarget(o.inReplyTo, base);
    if (tgt && actorUri && !isLocalActor) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      const html = HtmlSanitizerService.sanitize(o.content || '');
      if (isRejectedObject(o.id)) { console.log('[AP] reply skipped (tombstoned)', o.id); return 202; }
      iStmts().ins.run('reply', tgt.post_id, o.id || '', actorUri, ai.name, ai.handle, ai.url, ai.icon, html, o.published || null, tgt.parent_uri, noteVisibility(o), extractEmojiTags(o.tag), emojiJsonOf(ai.emojis));
      console.log('[AP] reply', actorUri, '→', tgt.post_id);
      // A reply is a post too: Berichten renders it the way de Krant renders a
      // timeline row, so it needs the same media and the same quote/preview card.
      {
        const where = 'kind = ? AND post_id = ? AND actor_uri = ? AND object_uri = ?';
        const key = ['reply', tgt.post_id, actorUri, o.id || ''];
        const mj = mediaFromNote(o);
        if (mj && mj !== '[]') { try { db.prepare(`UPDATE ap_interactions SET media_json = ? WHERE ${where}`).run(mj, ...key); } catch { /* ignore */ } }
        resolveCard(o).then((c) => {
          if (!c) return;
          const col = c.column === 'quote_json' ? 'quote_json' : 'embed_json';   // never a value from the wire
          try { db.prepare(`UPDATE ap_interactions SET ${col} = ? WHERE ${where}`).run(c.json, ...key); } catch { /* ignore */ }
        }).catch(() => { /* best-effort */ });
      }
      {
        // Private (followers/direct) replies push as a DM ping WITHOUT content
        // (the push service should never carry private text, design decision);
        // public replies carry a short snippet.
        const ctx = pushPostCtx(tgt.post_id);
        const vis = noteVisibility(o);
        const priv = vis === 'direct' || vis === 'followers';
        if (ctx) {
          const L = pushLang(ctx.site);
          const who = ai.name || ai.handle || i18nT(L, 'notif.someone');
          if (priv) pushEvent(ctx.site, { type: 'dm', title: i18nT(L, 'push.n_dm_t'), body: i18nT(L, 'push.n_dm_b', { who }), url: `${pushPrefix(ctx.site)}/messages` });
          else pushEvent(ctx.site, { type: 'reply', title: i18nT(L, 'push.n_reply_t', { title: ctx.title }), body: `${who}: ${HtmlSanitizerService.toPlainText(html).slice(0, 90)}`, url: ctx.url });
        }
      }
      return 202;
    }
    // Home timeline (client): a top-level post from an account we follow.
    if (actorUri && !isLocalActor && belongsInTimeline(o)) {
      let subs = []; try { subs = db.prepare('SELECT slug, auto_boost FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist yet */ }
      if (subs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const { html, atts: _atts, url: _url } = timelineFields(o);
        const media = JSON.stringify(_atts);
        const poll = parsePoll(o); // a Question (fediverse poll) → cache its options/counts
        // "Feature" = show in the Cirkel (local only). We do NOT auto-Announce
        // incoming posts to the fediverse — that flooded followers. Boosting to the
        // fediverse is only ever a deliberate, manual per-post action (the 🔁 on
        // the timeline).
        for (const s of subs) {
          tlStmts().ins.run(o.id, s.slug, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, _url, o.published || null, media, o.sensitive ? 1 : 0, contentWarning(o));
          // FEP-633c §2.2: register the ward hint on the stored object (no action yet).
          if (Guardianship.objectHasGuardians(o)) { try { db.prepare('UPDATE ap_timeline SET has_guardians = 1 WHERE id = ? AND slug = ?').run(o.id, s.slug); } catch { /* ignore */ } }
          // FEP-9098: keep the note's custom-emoji tags so the C2S inbox read can serve them.
          { const ej = extractEmojiTags(o.tag); if (ej) { try { db.prepare('UPDATE ap_timeline SET emoji_json = ? WHERE id = ? AND slug = ?').run(ej, o.id, s.slug); } catch { /* ignore */ } } }
          storeAuthorEmoji(o.id, s.slug, ai);   // custom-emoji display name for the byline

          // FEP-e232 + FEP-044f: keep the note's object-link/quote tags for the same read.
          { const lj = extractLinkJson(o); if (lj) { try { db.prepare('UPDATE ap_timeline SET link_json = ? WHERE id = ? AND slug = ?').run(lj, o.id, s.slug); } catch { /* ignore */ } } }
          if (poll) { try { db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(poll), o.id, s.slug); } catch { /* ignore */ } }
        }
        // FEP-044f embedded quote card: resolve the quoted post out of band so
        // the inbox response is not blocked on a remote fetch. Best-effort.
        if (quoteHrefOf(o)) {
          const slugs = subs.map((s) => s.slug);
          resolveQuote(o).then((qj) => {
            if (!qj) return;
            for (const sl of slugs) { try { db.prepare('UPDATE ap_timeline SET quote_json = ? WHERE id = ? AND slug = ?').run(qj, o.id, sl); } catch { /* ignore */ } }
          }).catch(() => { /* best-effort */ });
        } else {
          // No fediverse quote: try an EXTERNAL embed (oEmbed / known provider),
          // thumbnail-only. Also out of band, and stored for everyone; the gate
          // that decides who may SEE it is applied at serve time (§5.3-style
          // gated feature, see the inbox read).
          const slugs = subs.map((s) => s.slug);
          resolveExternalEmbed(o.content).then((ej) => {
            if (!ej) return;
            for (const sl of slugs) { try { db.prepare('UPDATE ap_timeline SET embed_json = ? WHERE id = ? AND slug = ?').run(ej, o.id, sl); } catch { /* ignore */ } }
          }).catch(() => { /* best-effort */ });
        }
        console.log('[AP] timeline +', actorUri, 'x' + subs.length);
      }
    }
    // Een ANTWOORD van iemand die we volgen: bewaar de URI (shaer-e9g). Zo'n
    // bericht komt hier gewoon binnen, ondertekend door de schrijver zelf, maar
    // belongsInTimeline houdt het uit de Krant en daarna raakten we het kwijt.
    // Kwam er later een doorgestuurd antwoord OP dat bericht, dan kenden we de
    // ouder niet en wezen we het af -- terwijl we hem wel degelijk hadden gehad.
    // Er verandert niets aan wat we tonen of van vreemden aannemen: de schrijver
    // moet iemand zijn die je zelf bent gaan volgen.
    if (actorUri && !isLocalActor && o.id && o.inReplyTo && noteVisibility(o) !== 'direct' && isFollowedActor(actorUri)) {
      rememberNoteUri(o.id);
    }
    // Mentioned in a post that is NOT a reply to our content (a reply to us already returned
    // above): store a mention notification for each of our actors named in the Mention tags.
    // Requires our own base prefix on the tag href — /ap/users/<slug> on a REMOTE host is
    // someone else's actor, not ours.
    // Een markering op een hulpvraag (shaer-lgo): een mede-guardian laat weten
    // dat hij ernaar kijkt, of dat het is afgehandeld. Gewone directe note met
    // een shaer:-markering, net als de zwaai -- dus die komt hier langs. VOOR de
    // mention-opslag, want dit is staat en geen bericht om te bewaren; de ward
    // krijgt hem wel als bericht te lezen, en dat gebeurt hieronder.
    if (actorUri && !isLocalActor) {
      const mark = Guardianship.help.parseMarker(o);
      if (mark) {
        const ai = actorInfo(await resolveActor(actorUri).catch(() => null), actorUri);
        Guardianship.help.record(mark.noteUri, actorUri, mark.kind, ai && ai.handle);
        wakeGuardian(slug);   // een mede-guardian pakte iets op: het paneel hoort het meteen
        console.log('[AP] help', mark.kind, actorUri, '→', mark.noteUri);
      }
    }
    if (actorUri && !isLocalActor && o.id) {
      const slugs = localMentionSlugs(o.tag, base);
      if (slugs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const html = HtmlSanitizerService.sanitize(o.content || '');
        // FEP-633c 5.2.1: a ward's call for help rides a direct mention; the
        // flag is stored so the Guardian PWA's message centre can list it.
        const help = Guardianship.isHelpRequest(o);
        const wave = Guardianship.isWave(o);
        const hasG = Guardianship.objectHasGuardians(o);   // §2.2 hint, register-only
        // FEP-633c 3.6.1: a guardian declares itself away to its ward, on the
        // same direct note the mention below stores (so the kid also reads it
        // as an ordinary message). Recorded only from an actual guardian of
        // the addressed ward, and only with an end: an absence without an end
        // is logged and dropped, never guessed.
        if (Guardianship.availability.isAway(o)) {
          const until = Guardianship.availability.parseEndTime(o.endTime);
          for (const slug of slugs) {
            const isG = (() => { try { return Guardianship.listGuardians(slug).some((g) => g.other_uri === actorUri); } catch { return false; } })();
            if (!isG) continue;
            if (!until || until <= Date.now()) { console.warn('[AP] away without a (future) end ignored (3.6.1):', actorUri, '→', slug); continue; }
            Guardianship.availability.declareAway(slug, actorUri, until);
            console.log('[AP] guardian declared away (3.6.1):', actorUri, '→', slug, 'until', new Date(until).toISOString());
          }
        }
        // Een kind dat zelf om een poort vraagt (shaer-8ru). Zelfde weg als de
        // afwezigheidsmelding: een gewone directe note met een shaer:-markering,
        // per genoemde ontvanger afgehandeld.
        //
        // ALLEEN VAN EEN EIGEN WARD. Een verzoek van een vreemde is geen vraag
        // maar een onbekende die iets over jouw instellingen wil zeggen -- dat
        // hoort in geen enkele lijst te belanden waar een guardian op afgaat.
        {
          const req = Guardianship.gatereq.parseRequest(o);
          if (req) {
            for (const slug of slugs) {
              const mijn = (() => { try { return Guardianship.listWards(slug).some((w) => w.other_uri === actorUri); } catch { return false; } })();
              if (!mijn) { console.warn('[AP] gate request from someone who is not our ward, ignored:', actorUri, '→', slug); continue; }
              Guardianship.gatereq.record(slug, actorUri, req.feature, o.id);
              wakeGuardian(slug);   // het kind vroeg om een poort
              console.log('[AP] gate request', req.feature, actorUri, '→', slug);
            }
          }
        }
        for (const slug of slugs) {
          try {
            const r = db.prepare(`INSERT OR IGNORE INTO ap_mentions (slug, object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, actor_url, content, published, help_request, wave, has_guardians, emoji_json, actor_emoji_json, media_json, created_at)
                                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
              .run(slug, o.id, safeUrl(o.url) || null, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.published || null, help ? 1 : 0, wave ? 1 : 0, hasG ? 1 : 0,
                extractEmojiTags(o.tag), emojiJsonOf(ai.emojis), mediaFromNote(o));
            if (r.changes) {
              // The quote / link-preview card resolves out of band (a remote
              // fetch), exactly as it does for a timeline post, so the inbox
              // answer is never blocked on it.
              resolveCard(o).then((c) => {
                if (!c) return;
                const col = c.column === 'quote_json' ? 'quote_json' : 'embed_json';   // never a value from the wire
                try { db.prepare(`UPDATE ap_mentions SET ${col} = ? WHERE slug = ? AND object_uri = ?`).run(c.json, slug, o.id); } catch { /* ignore */ }
              }).catch(() => { /* best-effort */ });
              console.log('[AP] mention', actorUri, '→', slug, help ? '(help request)' : '');
              const vis = noteVisibility(o);
              const priv = vis === 'direct' || vis === 'followers';
              const L = pushLang(slug);
              const who = ai.name || ai.handle || i18nT(L, 'notif.someone');
              // Same privacy rule as replies: private mentions push without content.
              // A help request pushes as its own alert type, aimed at the
              // Guardian PWA's message centre.
              if (help) pushEvent(slug, { type: 'help', title: i18nT(L, 'push.n_help_t'), body: i18nT(L, 'push.n_help_b', { who }), url: '/guardian' });
              else if (priv) pushEvent(slug, { type: 'dm', title: i18nT(L, 'push.n_dm_t'), body: i18nT(L, 'push.n_dm_b', { who }), url: `${pushPrefix(slug)}/messages` });
              else pushEvent(slug, { type: 'reply', title: i18nT(L, 'push.n_mention_t'), body: `${who}: ${HtmlSanitizerService.toPlainText(html).slice(0, 90)}`, url: `${pushPrefix(slug)}/messages` });
            }
          } catch { /* ignore */ }
        }
      }
    }
    return 202;
  }
  // A remote post we cached was edited upstream → refresh our cached copy. This is the
  // push-based edit-sync that keeps the Cirkel/timeline fresh without polling (selfHeal
  // does it on a version bump; this does it live). Scope to the SIGNING actor so B can't
  // edit A's note (the signature gate guarantees claimedActor == the verified signer).
  if (type === 'Update' && act.object && (act.object.type === 'Note' || act.object.type === 'Article' || act.object.type === 'Question')) {
    const o = act.object;
    if (o.id && claimedActor) {
      const html = HtmlSanitizerService.sanitize(o.content || '');
      const media = mediaFromNote(o);
      try {
        // Refresh url too (COALESCE keeps the old one if the Update omits it): a remote slug
        // rename keeps the same AP id but changes the human url, so without this the cached
        // post would keep linking to the old, now-dead URL.
        const r = db.prepare('UPDATE ap_timeline SET content = ?, media_json = ?, nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE id = ? AND author_uri = ?')
          .run(html, media, o.sensitive ? 1 : 0, contentWarning(o), o.url || null, o.id, claimedActor);
        if (r.changes) console.log('[AP] timeline update', claimedActor, '→', o.id);
        // A poll's Update carries the fresh vote counts / closed state. Refresh per-row so each
        // site keeps its own `voted` state while the counts/closed update to the new totals.
        const poll = parsePoll(o);
        if (poll) {
          const rows = db.prepare('SELECT rowid AS rid, poll_json FROM ap_timeline WHERE id = ? AND author_uri = ?').all(o.id, claimedActor);
          const upd = db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE rowid = ?');
          for (const rw of rows) {
            let voted = null; try { voted = rw.poll_json ? (JSON.parse(rw.poll_json).voted || null) : null; } catch { /* ignore */ }
            upd.run(JSON.stringify({ ...poll, voted }), rw.rid);
          }
        }
      } catch { /* ignore */ }
      // If this note is a cached fediverse reply on one of our posts, refresh its text too.
      try { db.prepare('UPDATE ap_interactions SET content = ? WHERE object_uri = ? AND actor_uri = ?').run(html, o.id, claimedActor); } catch { /* ignore */ }
    }
    return 202;
  }
  if (type === 'Like' || type === 'Announce') {
    const tgt = act.object;
    const objUrl = typeof tgt === 'string' ? tgt : (tgt && tgt.id);
    const pid = postIdFromNoteUrl(objUrl, base);
    if (pid && actorUri && !isLocalActor && localPostExists(pid)) {
      // A boost/like of a non-public post is dropped, not stored: nobody
      // outside the audience should even hold it (shaer-tqc hardening).
      const vp = db.prepare('SELECT fan_only, ap_visibility FROM posts WHERE id = ?').get(pid);
      if (vp && (vp.fan_only || vp.ap_visibility === 'direct' || vp.ap_visibility === 'friends')) {
        console.log('[AP] dropped', type, 'on non-public post', pid);
        return;
      }
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      iStmts().ins.run(type.toLowerCase(), pid, '', actorUri, ai.name, ai.handle, ai.url, ai.icon, null, null, null, noteVisibility(act), null, emojiJsonOf(ai.emojis));
      console.log('[AP]', type === 'Like' ? 'like' : 'boost', actorUri, '→', pid);
      {
        const ctx = pushPostCtx(pid);
        if (ctx) {
          const L = pushLang(ctx.site);
          const who = ai.name || ai.handle || i18nT(L, 'notif.someone');
          if (type === 'Like') pushEvent(ctx.site, { type: 'like', title: i18nT(L, 'push.n_like_t'), body: i18nT(L, 'push.n_like_b', { who, title: ctx.title }), url: ctx.url });
          else pushEvent(ctx.site, { type: 'boost', title: i18nT(L, 'push.n_boost_t'), body: i18nT(L, 'push.n_boost_b', { who, title: ctx.title }), url: ctx.url });
        }
      }
    } else if (type === 'Announce' && objUrl && actorUri && !isLocalActor) {
      // A boost FROM an account we follow, of a REMOTE post → show it in the News feed.
      // We only STORE it for display; we NEVER auto-Announce it onward (anti-feedback-loop:
      // re-announcing an incoming Announce would cascade boosts across the network).
      let subs = []; try { subs = db.prepare('SELECT slug FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist */ }
      if (subs.length) {
        const bn = await fetchNoteAP(objUrl);
        if (bn && bn !== 404 && (bn.type === 'Note' || bn.type === 'Article') && bn.id) {
          const origUri = actorUriOf(bn.attributedTo);
          // Block completeness: even if you follow the booster, drop a boost whose ORIGINAL
          // author is blocked — otherwise a block is bypassed via someone else's boost.
          if (origUri && isBlockedAny(origUri)) { console.log('[AP] timeline boost dropped (blocked origin)', origUri, 'via', actorUri); return 202; }
          const oai = actorInfo(await resolveActor(origUri), origUri);
          const html = HtmlSanitizerService.sanitize(bn.content || '');
          const media = mediaFromNote(bn);
          const booster = actorInfo(await resolveActor(actorUri), actorUri);
          for (const s of subs) {
            // published = now → the boost shows as fresh activity at the top (Mastodon shows
            // reblogs at reblog-time, not the original's date). INSERT OR IGNORE: if we already
            // have the note (e.g. we also follow the author), keep it and DON'T relabel it.
            let inserted = false;
            try { const r = tlStmts().ins.run(bn.id, s.slug, origUri || '', oai.name, oai.handle, oai.icon, oai.url, html, bn.url || null, new Date().toISOString(), media, bn.sensitive ? 1 : 0, contentWarning(bn)); inserted = r.changes > 0; } catch { /* ignore */ }
            if (inserted) { try { db.prepare('UPDATE ap_timeline SET reblog_name = ?, reblog_handle = ?, reblog_icon = ?, reblog_emoji_json = ? WHERE slug = ? AND id = ?').run(booster.name, booster.handle, booster.icon, (booster.emojis && Object.keys(booster.emojis).length) ? JSON.stringify(booster.emojis) : null, s.slug, bn.id); } catch { /* ignore */ } }
            storeAuthorEmoji(bn.id, s.slug, oai);   // custom-emoji display name for the byline
            // A boost carries the same renderable tags as a Create: capture the
            // note's content emojis (FEP-9098) and object links / quote (FEP-e232/
            // 044f) so boosted posts render like any other, not as raw shortcodes.
            { const ej = extractEmojiTags(bn.tag); if (ej) { try { db.prepare('UPDATE ap_timeline SET emoji_json = ? WHERE id = ? AND slug = ?').run(ej, bn.id, s.slug); } catch { /* ignore */ } } }
            { const lj = extractLinkJson(bn); if (lj) { try { db.prepare('UPDATE ap_timeline SET link_json = ? WHERE id = ? AND slug = ?').run(lj, bn.id, s.slug); } catch { /* ignore */ } } }
          }
          // FEP-044f: resolve the embedded quote card for a boosted post too
          // (out of band, best-effort, so it does not block the inbox response).
          if (quoteHrefOf(bn)) {
            const slugs = subs.map((s) => s.slug);
            resolveQuote(bn).then((qj) => {
              if (!qj) return;
              for (const sl of slugs) { try { db.prepare('UPDATE ap_timeline SET quote_json = ? WHERE id = ? AND slug = ?').run(qj, bn.id, sl); } catch { /* ignore */ } }
            }).catch(() => { /* best-effort */ });
          }
          console.log('[AP] timeline boost +', actorUri, 'x' + subs.length);
        }
      }
    }
    return 202;
  }
  if (type === 'Delete') {
    // A remote note was deleted upstream → drop it from replies AND the timeline.
    // Scope to the SIGNING actor so actor B can't delete actor A's content (the
    // signature gate guarantees claimedActor == the verified signer here).
    const oid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    if (oid && claimedActor) {
      try { db.prepare('DELETE FROM ap_interactions WHERE object_uri = ? AND actor_uri = ?').run(oid, claimedActor); } catch { /* ignore */ }
      try { db.prepare('DELETE FROM ap_timeline WHERE id = ? AND author_uri = ?').run(oid, claimedActor); } catch { /* ignore */ }
      // Also clear a boost/like YOU made of this now-deleted remote post (the interact-page
      // ap_my_reactions state), so it can't stay stuck as "boosted" on a post that's gone.
      // Guard: only when the deleter owns the note's domain (B mustn't clear your reactions
      // to A's posts).
      try {
        let sameHost = false;
        try { sameHost = new URL(oid).host === new URL(claimedActor).host; } catch { sameHost = false; }
        if (sameHost) db.prepare('DELETE FROM ap_my_reactions WHERE target_uri = ?').run(oid);
      } catch { /* ignore */ }
    }
    return 202;
  }
  // Accept/Reject of a Follow WE sent (client side).
  if (type === 'Accept' && act.object) {
    const fid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    let raak = 0;
    if (fid) { try { raak = fwStmts().acc.run(fid).changes; } catch { /* ignore */ } }
    // TERUGVAL, en die is nodig gebleken tegen Funkwhale. Een Accept hoort de
    // Follow terug te geven die hij beantwoordt, maar Funkwhale verzint er een
    // EIGEN id voor, in ONZE namespace:
    //
    //   wij stuurden   .../ap/users/dev#follow-1786161977286-bb2de32f
    //   Funkwhale zegt .../ap/users/dev#follows/19fd8b00-8f66-...
    //
    // Matchen op follow_id raakt dan niets, en de volgrelatie bleef eeuwig op
    // 'pending' staan terwijl de logregel 'accepted' riep -- een stille no-op
    // die pas opviel toen er nooit iets binnenkwam.
    //
    // Het paar dat we WEL zeker weten is (deze site, deze actor): de Accept is
    // handtekening-geverifieerd, en actorUri is de ondertekenaar. Alleen een
    // rij die nog op pending staat wordt geraakt, dus dit kan niets anders
    // openzetten dan een follow die wij zelf hebben verstuurd.
    //
    // En de slug mag NIET van slugParam afhangen: Funkwhale bezorgt op de
    // GEDEELDE inbox, en dan is die leeg. Wie wij zijn staat in de ingesloten
    // Follow -- die hebben wij immers zelf verstuurd, dus `object.actor` is
    // onze eigen actor-URI.
    let mij = slugParam;
    if (!mij && act.object && typeof act.object === 'object') mij = slugFromActorUrl(act.object.actor);
    if (!raak && mij && actorUri) {
      try { raak = fwStmts().accByActor.run(mij, actorUri).changes; } catch { /* ignore */ }
    }
    // Eerlijk loggen: zonder treffer is er niets geaccepteerd, en dat hoort te
    // zien te zijn in plaats van als succes voorbij te komen.
    console.log('[AP] follow', raak ? 'accepted' : 'accept UNMATCHED', actorUri, fid ? '(' + fid + ')' : '');
    // The moment a friendship exists is the moment the history comes along
    // (Robins besluit, 30-7): delivery cannot reach into the past, so the
    // fresh follower pulls the outbox, signed, and the other side now serves
    // the friends-only posts too.
    if (slugParam && actorUri) backfillFromOutbox(slugParam, actorUri).catch(() => { /* best-effort */ });
    return 202;
  }
  if (type === 'Reject' && act.object) {
    const who = actorUri;
    if (who && slugParam) { try { fwStmts().del.run(slugParam, who); } catch { /* ignore */ } }
    return 202;
  }

  // Zeg ook WAT er viel. Een kale "Create (ignored)" verbergt het verschil
  // tussen een soort die we bewust overslaan en een die we niet kennen -- en
  // dat verschil was precies de vraag bij Funkwhale, dat Create(Audio) stuurt
  // waar deze inbox alleen Note, Article en Question aanneemt.
  const objType = act.object && typeof act.object === 'object' ? act.object.type : (typeof act.object === 'string' ? '<uri>' : null);
  console.log('[AP] inbox', type || 'unknown', objType ? '(' + objType + ')' : '', '→', slugParam || 'shared',
    'from', ip, 'by', claimedActor || '?', '(ignored)');
  return 202;
}

