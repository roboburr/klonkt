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
const FEATURES = { 'shaer:externalEmbeds': 'external_embeds' };
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

export function rememberGatedOffer(offerId, slug, feature, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO ap_gated_offers (offer_id, slug, feature, value) VALUES (?,?,?,?)')
      .run(offerId, slug, feature, value ? 1 : 0);
  } catch { /* non-fatal */ }
}

export function recallGatedOffer(offerId) {
  try { return db.prepare('SELECT * FROM ap_gated_offers WHERE offer_id = ?').get(offerId) || null; }
  catch { return null; }
}

export default {
  tallyGatedSetting, thresholdFor, featureColumn, recordGatedVote, gatedProgress, GATED_WINDOW_MS,
  parseGatedSetting, buildGatedOffer, rememberGatedOffer, recallGatedOffer,
  recordGatedReview, getGatedReview, listGatedReviews, removeGatedReview, clearGatedReviews,
};
