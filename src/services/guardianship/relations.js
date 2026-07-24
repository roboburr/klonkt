/**
 * Guardianship (FEP-633c) — the ward ↔ guardian relations (ap_guardianships).
 *
 * Every row is one relation seen from a LOCAL site: role 'guardian' means the
 * site guards `other_uri` (a ward, possibly remote); role 'ward' means
 * `other_uri` guards the site. A local ward with a local guardian yields two
 * rows, one per perspective — intentional, each side reads its own.
 *
 * The handshake (spec §3): the guardian-candidate — and only the candidate —
 * Offers a Relationship {subject: ward, relationship: shaer:Guardian,
 * object: candidate}; the ward Accepts (or Rejects). Status walks
 * 'offered' → 'accepted'; a Reject deletes the row.
 */
import db from '../../config/database.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      ins: db.prepare(`INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, other_handle, status, offer_id, created_at)
                       VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`),
      accept: db.prepare(`UPDATE ap_guardianships SET status='accepted' WHERE slug=? AND role=? AND other_uri=?`),
      del: db.prepare('DELETE FROM ap_guardianships WHERE slug=? AND role=? AND other_uri=?'),
      bySlugRole: db.prepare('SELECT * FROM ap_guardianships WHERE slug=? AND role=? ORDER BY created_at DESC'),
      one: db.prepare('SELECT * FROM ap_guardianships WHERE slug=? AND role=? AND other_uri=?'),
      byOffer: db.prepare('SELECT * FROM ap_guardianships WHERE offer_id=?'),
    };
  }
  return _s;
}

// ── Reads ────────────────────────────────────────────────────────────────

/** Accepted guardian URIs of a local ward (feeds shaer:guardians). */
export function listGuardians(slug) {
  return stmts().bySlugRole.all(slug, 'ward').filter((r) => r.status === 'accepted');
}

/** All ward relations of a local guardian (accepted + pending offers). */
export function listWards(slug) {
  return stmts().bySlugRole.all(slug, 'guardian');
}

/** Pending offers where the local site is a party (either side). */
export function listOffers(slug) {
  return [...stmts().bySlugRole.all(slug, 'guardian'), ...stmts().bySlugRole.all(slug, 'ward')]
    .filter((r) => r.status === 'offered');
}

/** A site is a guardian once it stands in any guardian-side relation. */
export function isGuardian(slug) {
  return stmts().bySlugRole.all(slug, 'guardian').length > 0;
}

export function getRelation(slug, role, otherUri) { return stmts().one.get(slug, role, otherUri); }
export function findByOfferId(offerId) { return offerId ? stmts().byOffer.all(offerId) : []; }

// ── Writes (the handshake walks through these) ───────────────────────────

/** Record an outgoing/incoming Offer on the local side with `role`. */
export function recordOffer(slug, role, otherUri, { handle = null, offerId = null } = {}) {
  stmts().ins.run(slug, role, otherUri, handle, 'offered', offerId);
  return stmts().one.get(slug, role, otherUri);
}

/** The ward said yes (or our own offer was accepted): relation becomes real. */
export function acceptRelation(slug, role, otherUri) {
  stmts().accept.run(slug, role, otherUri);
  return stmts().one.get(slug, role, otherUri);
}

/** Reject / retract / end a relation: the row disappears. */
export function removeRelation(slug, role, otherUri) {
  stmts().del.run(slug, role, otherUri);
  return { ok: true };
}

// ── Actor document (FEP-633c §2) ─────────────────────────────────────────

/**
 * The guardianship properties for a local actor doc. `id` is the actor URI.
 * - shaer:guardians: accepted guardians of this ward (omitted when none)
 * - shaer:isGuardian: true once the site guards anyone
 * - shaer:queues: the owner-only dashboard collections (always advertised,
 *   like `blocked`: clients discover, the routes enforce auth)
 */
export function actorProps(id, slug) {
  const props = {
    'shaer:queues': {
      offers: `${id}/queues/offers`,
      follows: `${id}/queues/follows`,
      wards: `${id}/queues/wards`,
    },
  };
  const guardians = listGuardians(slug).map((r) => r.other_uri);
  if (guardians.length) props['shaer:guardians'] = guardians;
  if (isGuardian(slug)) props['shaer:isGuardian'] = true;
  return props;
}

export default {
  listGuardians, listWards, listOffers, isGuardian, getRelation, findByOfferId,
  recordOffer, acceptRelation, removeRelation, actorProps,
};
