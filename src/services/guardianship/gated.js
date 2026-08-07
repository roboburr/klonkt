/**
 * Guardianship (FEP-633c §5.6): gated settings the guardians decide together.
 *
 * The point of this file is that it works when the guardians are NOT on the
 * ward's server, which is the ordinary case: a child on the family instance, a
 * grandparent on theirs. A guardian proposes with an `Offer` of a
 * `shaer:GatedSetting` addressed to the ward's server; the other guardians
 * answer; the ward's server tallies and enforces, because it is the one that
 * serves the feed.
 *
 * The tally is a §3.5 decision: a snapshotted set, a threshold (strict
 * majority), a window. A setting is reversible (a permission granted can be
 * withdrawn), so it settles as a race to the threshold and fails closed.
 */
import db from '../../config/database.js';
import { listGuardians } from './relations.js';
import * as availability from './availability.js';

/** The window a gated-setting decision stays open. Reversible, so a day. */
export const GATED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Strict majority of the set: 1 of 1, 2 of 2, 2 of 3, 3 of 4. */
export function thresholdFor(setSize) {
  return Math.floor(setSize / 2) + 1;
}

/**
 * Tally one decision. Pure, so the rule can be tested without a database.
 *
 * @param {Array<{guardian_uri: string, value: number|boolean}>} votes
 * @param {string[]} guardianSet  the guardians at the moment the decision opened
 * @param {number} ageMs          how long the decision has been open
 * @returns {{state: 'settled'|'open'|'expired', value?: boolean}}
 */
export function tallyGatedSetting(votes, guardianSet, ageMs, windowMs = GATED_WINDOW_MS) {
  const set = new Set((guardianSet || []).filter(Boolean));
  if (!set.size) return { state: 'expired' };            // nobody may decide
  const need = thresholdFor(set.size);
  // Only answers from the snapshotted set count, one per guardian.
  const seen = new Map();
  for (const v of (votes || [])) {
    if (!set.has(v.guardian_uri)) continue;
    seen.set(v.guardian_uri, v.value === true || v.value === 1);
  }
  const yes = [...seen.values()].filter(Boolean).length;
  const no = seen.size - yes;
  // Race to the threshold, in both directions: settle the moment it is reached,
  // and give up the moment it can no longer be reached.
  if (yes >= need) return { state: 'settled', value: true };
  if (no >= need) return { state: 'settled', value: false };
  const undecided = set.size - seen.size;
  if (yes + undecided < need && no + undecided < need) return { state: 'expired' };
  if (ageMs >= windowMs) return { state: 'expired' };    // fails closed
  return { state: 'open' };
}

/** The column a feature maps onto. Unknown features are refused, not guessed. */
const FEATURES = {
  'shaer:externalEmbeds': 'external_embeds',
  'shaer:externalPlayback': 'external_playback',
};
/**
 * De gates die deze Klonkt kent, met hun SOORT.
 *
 * Wat gated wordt is een ontwerpkeuze van de implementatie: de FEP levert het
 * mechanisme (voorstel, tally, settle) en een paar voorbeelden, niet de lijst.
 * Deze catalogus is die lijst, op een plek. Een gate erbij hoort een regel data
 * te zijn en geen nieuw stuk scherm.
 *
 * `kind` is niet decoratief. De gates verschillen in hoe ze werken en dat mag
 * een guardian niet hoeven raden:
 *
 *   setting     een stand, aan of uit, terug te draaien
 *   perRequest  geen stand maar een stroom beslissingen (5.3 volgverzoeken)
 *   handover    draagt gezag OVER; onomkeerbaar zodra de ward hem gebruikt
 *
 * `needs` is de trap uit shaer-ahy: zien < afspelen. Je kunt niet afspelen wat
 * je niet mag zien, dus dat tweede is pas te bewegen als het eerste openstaat.
 */
export const GATE_CATALOGUE = [
  // Werkend: er is een kolom, de tally kan erover beslissen en de server dwingt
  // hem af bij het serveren.
  { feature: 'shaer:externalEmbeds', kind: 'setting', reversible: true },
  { feature: 'shaer:externalPlayback', kind: 'setting', reversible: true, needs: 'shaer:externalEmbeds' },
  // Altijd aan voor een ward (5.3): niet te verzetten, wel te tonen. Een paneel
  // dat alleen verstelbare dingen laat zien verzwijgt de helft van wat er geldt.
  { feature: 'shaer:follows', kind: 'perRequest', reversible: true, fixed: true },

  // GEPLAND, nog niet afgedwongen. Deze staan in het paneel omdat een guardian
  // hoort te zien wat er straks te beslissen valt -- en omdat de SOM van de
  // gates iets anders is dan elke gate apart: elf poorten die elk dicht falen
  // leveren samen een kind op dat vrijwel niets kan.
  //
  // available: false is geen detail. featureColumn() kent deze namen niet, dus
  // een voorstel zou stranden op unknown_feature. En ze als "uit" tonen zou
  // ronduit onwaar zijn: plaatjes werken vandaag gewoon. Ze horen te lezen als
  // "hier is nog niets van", niet als een gesloten poort.
  //
  // `kind` is hier voorlopig. Of accountmigratie een stand is of een besluit per
  // keer hoort bij het bouwen van shaer-tge beslist te worden, niet hier.
  { feature: 'shaer:images', kind: 'setting', reversible: true, available: false, bead: 'shaer-6p5' },
  { feature: 'shaer:messages', kind: 'setting', reversible: true, available: false, bead: 'shaer-3ow' },
  { feature: 'shaer:compose', kind: 'setting', reversible: true, available: false, bead: 'shaer-qgev' },
  { feature: 'shaer:music', kind: 'setting', reversible: true, available: false, bead: 'shaer-rmz' },
  { feature: 'shaer:quoteCards', kind: 'setting', reversible: true, available: false, bead: 'shaer-mls' },
  { feature: 'shaer:customEmoji', kind: 'setting', reversible: true, available: false, bead: 'shaer-ytw' },
  { feature: 'shaer:publicProfile', kind: 'setting', reversible: true, available: false, bead: 'shaer-hj0' },
  { feature: 'shaer:accountMove', kind: 'setting', reversible: true, available: false, bead: 'shaer-tge' },
  // De enige die gezag OVERDRAAGT, en daarmee de enige die niet terug te draaien
  // is zodra het kind hem gebruikt (shaer-90v). Telt met de lapse-vorm: volle
  // set, volle venster.
  { feature: 'shaer:independence', kind: 'handover', reversible: false, available: false, bead: 'shaer-90v' },
];

/**
 * De gates van een ward als rijen voor het paneel. Puur, zodat de regels
 * getoetst kunnen worden zonder database of scherm.
 *
 * @param settings       {feature: true|false|null} -- null is ONBEKEND, niet uit
 * @param guardianCount  aantal guardians, of null als we het niet weten
 * @param proposals      [{feature, value, status}] lopende voorstellen
 * @param waiting        {feature: aantal} wat er per gate op een besluit wacht
 */
export function gateRows({ settings = {}, guardianCount = null, proposals = [], waiting = {} } = {}) {
  return GATE_CATALOGUE.map((g) => {
    // Een stand kan drie dingen zijn: beslist-aan, beslist-uit, of de standaard
    // omdat er nooit iets besloten is. Dat derde als "uit" tonen zou een besluit
    // suggereren dat niemand nam.
    const raw = Object.prototype.hasOwnProperty.call(settings, g.feature) ? settings[g.feature] : null;
    const beslist = raw && typeof raw === 'object' ? !!raw.decided : (raw === true || raw === false);
    const value = raw && typeof raw === 'object' ? raw.value : raw;
    // De trap: het bovenliggende moet OPEN staan. Onbekend telt niet als dicht --
    // bij een ward elders kennen we de stand niet, en verbergen betekende daar
    // ooit dat een voorstel nooit geopend kon worden.
    const bovenliggend = settings[g.needs];
    const bovenWaarde = bovenliggend && typeof bovenliggend === 'object' ? bovenliggend.value : bovenliggend;
    const bovenBeslist = bovenliggend && typeof bovenliggend === 'object' ? bovenliggend.decided : (bovenWaarde === true || bovenWaarde === false);
    // Alleen dichthouden als we ZEKER weten dat het bovenliggende uit staat.
    const blockedBy = (g.needs && bovenBeslist && bovenWaarde === false) ? g.needs : null;
    return {
      feature: g.feature,
      kind: g.kind,
      reversible: !!g.reversible,
      value,
      decided: beslist,
      // Vast staat vast: tonen mag, verzetten niet.
      // Wat er niet is, valt niet te verzetten. Een knop die op unknown_feature
      // strandt is erger dan geen knop.
      available: g.available !== false,
      adjustable: g.available !== false && !g.fixed && !blockedBy,
      blockedBy: blockedBy || undefined,
      // Zonder bekend aantal guardians GEEN drempel verzinnen. Nul of een gok
      // leest als een feit, en dit is precies waar een guardian op afgaat.
      threshold: (guardianCount && guardianCount > 0)
        ? { need: thresholdFor(guardianCount), of: guardianCount } : null,
      proposal: proposals.find((p) => p.feature === g.feature) || undefined,
      waiting: waiting[g.feature] || undefined,
    };
  });
}

export function featureColumn(feature) {
  return Object.prototype.hasOwnProperty.call(FEATURES, feature) ? FEATURES[feature] : null;
}

/**
 * Record one guardian's answer and settle if the threshold is now reached.
 * Returns the tally state so a caller can report it.
 */
export function recordGatedVote(slug, feature, guardianUri, value) {
  const column = featureColumn(feature);
  if (!column) return { state: 'expired', error: 'unknown_feature' };
  const all = listGuardians(slug).map((g) => g.other_uri);
  if (!all.includes(guardianUri)) return { state: 'expired', error: 'not_a_guardian' };
  // A vote is an answer, whatever it is a vote on (§3.6): the voter is
  // restored first, so it always counts itself back into the set below.
  availability.oneAnswer(guardianUri, Date.now());
  // §3.5: the threshold runs over the AVAILABLE set. Membership is checked
  // against the full list above: any guardian may answer, and answering is
  // exactly what brings it back in.
  const guardians = availability.availableSet(slug, all, Date.now());

  // The window opens with the first answer, and a stale decision starts over:
  // a proposal from last month should not silently count toward today's.
  const existing = db.prepare('SELECT MIN(opened_at) AS opened FROM ap_gated_votes WHERE slug = ? AND feature = ?')
    .get(slug, feature);
  let openedAt = existing && existing.opened ? new Date(existing.opened).getTime() : Date.now();
  if (Number.isNaN(openedAt) || Date.now() - openedAt >= GATED_WINDOW_MS) {
    db.prepare('DELETE FROM ap_gated_votes WHERE slug = ? AND feature = ?').run(slug, feature);
    openedAt = Date.now();
  }
  db.prepare(`INSERT INTO ap_gated_votes (slug, feature, guardian_uri, value, opened_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(slug, feature, guardian_uri) DO UPDATE SET value = excluded.value`)
    .run(slug, feature, guardianUri, value ? 1 : 0, new Date(openedAt).toISOString());

  const votes = db.prepare('SELECT guardian_uri, value FROM ap_gated_votes WHERE slug = ? AND feature = ?')
    .all(slug, feature);
  const result = tallyGatedSetting(votes, guardians, Date.now() - openedAt);
  if (result.state === 'settled') {
    db.prepare(`UPDATE sites SET ${column} = ? WHERE slug = ?`).run(result.value ? 1 : 0, slug);
    db.prepare('DELETE FROM ap_gated_votes WHERE slug = ? AND feature = ?').run(slug, feature);
  } else if (result.state === 'expired') {
    db.prepare('DELETE FROM ap_gated_votes WHERE slug = ? AND feature = ?').run(slug, feature);
  }
  return { ...result, need: thresholdFor(guardians.length), of: guardians.length };
}

/** The open decision for a feature, for showing progress ("1 of 2"). */
export function gatedProgress(slug, feature) {
  const votes = db.prepare('SELECT guardian_uri, value FROM ap_gated_votes WHERE slug = ? AND feature = ?')
    .all(slug, feature);
  // Progress over the available set (§3.5), like the tally itself.
  const guardians = availability.availableSet(slug, listGuardians(slug).map((g) => g.other_uri), Date.now());
  return { votes: votes.length, need: thresholdFor(guardians.length), of: guardians.length };
}

// ── The federated shape (§5.6) ────────────────────────────────────
// An Offer of a shaer:GatedSetting, answered with Accept/Reject. Parsing lives
// here so both the inbox and the outbox read it the same way.

/** Read a shaer:GatedSetting object, or null when this is a different Offer. */
export function parseGatedSetting(object) {
  if (!object || typeof object !== 'object') return null;
  const type = Array.isArray(object.type) ? object.type[0] : object.type;
  if (type !== 'shaer:GatedSetting' && type !== 'GatedSetting') return null;
  const ward = object['shaer:ward'] || object.ward;
  const feature = object['shaer:feature'] || object.feature;
  const value = object['shaer:value'] !== undefined ? object['shaer:value'] : object.value;
  if (typeof ward !== 'string' || typeof feature !== 'string') return null;
  return { ward, feature, value: value === true || value === 1 || value === 'true' };
}

/** Build the Offer a guardian sends to the ward's server. */
export function buildGatedOffer(offerId, actor, ward, feature, value) {
  return {
    id: offerId,
    type: 'Offer',
    actor,
    to: [ward],
    object: {
      type: 'shaer:GatedSetting',
      'shaer:ward': ward,
      'shaer:feature': feature,
      'shaer:value': !!value,
    },
  };
}

// ── The guardian-side copy (the missing leg of §5.6) ──────────────
// A proposal addressed to the ward's server reaches only the proposer and the
// ward. The other guardians never learn it exists, so a threshold of two can
// never be met and every proposal expires unanswered. The ward's server
// therefore FORWARDS it, exactly as it forwards a gated follow (§5.3): each
// guardian stores a copy it can answer, and the answer travels back to the
// ward, which tallies.

let _rs = null;
function rstmts() {
  if (!_rs) {
    _rs = {
      ins: db.prepare(`INSERT INTO ap_gated_reviews (id, guardian_slug, ward_uri, ward_inbox, proposer, feature, value)
                       VALUES (?,?,?,?,?,?,?)
                       ON CONFLICT(guardian_slug, id) DO UPDATE SET value = excluded.value, ward_inbox = excluded.ward_inbox`),
      get: db.prepare('SELECT * FROM ap_gated_reviews WHERE guardian_slug = ? AND id = ?'),
      bySlug: db.prepare('SELECT * FROM ap_gated_reviews WHERE guardian_slug = ? ORDER BY created_at DESC'),
      del: db.prepare('DELETE FROM ap_gated_reviews WHERE guardian_slug = ? AND id = ?'),
      delAll: db.prepare('DELETE FROM ap_gated_reviews WHERE id = ?'),
    };
  }
  return _rs;
}

export function recordGatedReview(guardianSlug, r) {
  rstmts().ins.run(r.id, guardianSlug, r.wardUri, r.wardInbox || null, r.proposer || null, r.feature, r.value ? 1 : 0);
  return rstmts().get.get(guardianSlug, r.id);
}
export function getGatedReview(guardianSlug, id) { return rstmts().get.get(guardianSlug, id); }
export function listGatedReviews(guardianSlug) { return rstmts().bySlug.all(guardianSlug); }
export function removeGatedReview(guardianSlug, id) { rstmts().del.run(guardianSlug, id); }
/** Drop every guardian's copy once the decision has settled or lapsed. */
export function clearGatedReviews(id) { rstmts().delAll.run(id); }

export function rememberGatedOffer(offerId, slug, feature, value, proposer) {
  try {
    db.prepare('INSERT OR REPLACE INTO ap_gated_offers (offer_id, slug, feature, value, proposer) VALUES (?,?,?,?,?)')
      .run(offerId, slug, feature, value ? 1 : 0, proposer || null);
  } catch { /* non-fatal */ }
}

export function recallGatedOffer(offerId) {
  try { return db.prepare('SELECT * FROM ap_gated_offers WHERE offer_id = ?').get(offerId) || null; }
  catch { return null; }
}

// ── The proposer's own record (5.6) ───────────────────────────────
// "Where did my proposal go?" had no answer: the status was a button caption
// that did not survive a refresh. The ward's server tallies elsewhere, so the
// proposer keeps its own row and the ward's server ANSWERS the Offer when the
// decision settles: Accept when it settled on the proposed value, Reject when
// it settled on the opposite. An open row past the window renders as expired,
// because an expired decision settles on nothing and nobody writes home.

export function recordSent(offerId, guardianSlug, wardUri, feature, value) {
  try {
    db.prepare(`INSERT OR REPLACE INTO ap_gated_sent (offer_id, guardian_slug, ward_uri, feature, value)
                VALUES (?,?,?,?,?)`).run(offerId, guardianSlug, wardUri, feature, value ? 1 : 0);
  } catch { /* non-fatal */ }
}

export function recallSent(offerId) {
  try { return db.prepare('SELECT * FROM ap_gated_sent WHERE offer_id = ?').get(offerId) || null; }
  catch { return null; }
}

/**
 * De stand van een gate zoals DEZE guardian hem kent.
 *
 * Er zijn geen lokale accounts: elke ward woont op een andere server, dus de
 * kolom op onze eigen sites-tabel is voor een ward altijd leeg. Wat een guardian
 * wel heeft is de UITSLAG van besluiten -- een geaccepteerd voorstel met waarde
 * true betekent dat de poort openging.
 *
 * Geeft { value, decided }:
 *   decided true   we hebben een aangenomen besluit gezien; value is die waarde
 *   decided false  we hebben er geen; value is de standaard voor een ward (uit)
 *
 * Dat verschil hoort zichtbaar te blijven. "Uit" en "voor zover wij weten uit"
 * zijn niet hetzelfde, en het tweede is wat we meestal hebben.
 *
 * BEKEND GAT: dit ziet alleen onze EIGEN voorstellen. Antwoordde je op dat van
 * een mede-guardian, dan komt de uitslag wel binnen (gated_outcome) maar wordt
 * hij niet bewaard -- handshake.js legt alleen vast voor sent-rijen die van ons
 * zijn. Een gate die een ander heeft geopend leest hier dus als "uit". Dat is de
 * onveilige kant en het hoort gerepareerd te worden.
 */
export function knownSetting(guardianSlug, wardUri, feature) {
  try {
    const r = db.prepare(`SELECT value FROM ap_gated_sent
                           WHERE guardian_slug = ? AND ward_uri = ? AND feature = ? AND status = 'accepted'
                           ORDER BY created_at DESC LIMIT 1`).get(guardianSlug, wardUri, feature);
    if (r) return { value: !!r.value, decided: true };
  } catch { /* val terug op de standaard */ }
  return { value: false, decided: false };
}

export function settleSent(offerId, outcome) {
  try { db.prepare('UPDATE ap_gated_sent SET status = ? WHERE offer_id = ?').run(outcome, offerId); } catch { /* non-fatal */ }
}

/** The latest proposal per feature this guardian sent to this ward. */
export function listSent(guardianSlug, wardUri) {
  try {
    return db.prepare(`SELECT * FROM ap_gated_sent WHERE guardian_slug = ? AND ward_uri = ?
                       GROUP BY feature HAVING MAX(created_at) ORDER BY created_at DESC`).all(guardianSlug, wardUri);
  } catch { return []; }
}

/**
 * What a sent row means on a screen. Pure, so the rule is testable: an answer
 * wins, and silence past the window is not "still running", it is over.
 */
export function sentStatus(row, now) {
  if (!row) return null;
  if (row.status === 'accepted' || row.status === 'rejected') return row.status;
  const opened = new Date(String(row.created_at).includes('T') ? row.created_at : `${row.created_at}Z`.replace(' ', 'T')).getTime();
  if (Number.isFinite(opened) && now - opened >= GATED_WINDOW_MS) return 'expired';
  return 'open';
}

export default {
  GATE_CATALOGUE, gateRows, knownSetting,
  tallyGatedSetting, thresholdFor, featureColumn, recordGatedVote, gatedProgress, GATED_WINDOW_MS,
  parseGatedSetting, buildGatedOffer, rememberGatedOffer, recallGatedOffer,
  recordGatedReview, getGatedReview, listGatedReviews, removeGatedReview, clearGatedReviews,
  recordSent, recallSent, settleSent, listSent, sentStatus,
};
