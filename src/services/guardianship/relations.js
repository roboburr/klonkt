/**
 * Guardianship (FEP-633c) — the COMMITTED ward ↔ guardian relations
 * (ap_guardianships). Pending offers live in offers.js; a row here means the
 * handshake committed (§3.1.4). Every row is one relation seen from a LOCAL
 * site: role 'guardian' = the site guards other_uri; role 'ward' = other_uri
 * guards the site.
 */
import db from '../../config/database.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      commit: db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, other_handle, status, offer_id, created_at)
                          VALUES (?,?,?,?, 'accepted', ?, CURRENT_TIMESTAMP)
                          ON CONFLICT(slug, role, other_uri) DO UPDATE SET status='accepted', offer_id=excluded.offer_id`),
      del: db.prepare('DELETE FROM ap_guardianships WHERE slug=? AND role=? AND other_uri=?'),
      bySlugRole: db.prepare("SELECT * FROM ap_guardianships WHERE slug=? AND role=? AND status='accepted' ORDER BY created_at DESC"),
      one: db.prepare('SELECT * FROM ap_guardianships WHERE slug=? AND role=? AND other_uri=?'),
    };
  }
  return _s;
}

// ── Reads ────────────────────────────────────────────────────────────────

/** Accepted guardian URIs of a local ward (feeds shaer:guardians). */
export function listGuardians(slug) { return stmts().bySlugRole.all(slug, 'ward'); }

/** Accepted wards of a local guardian (the wards queue). */
export function listWards(slug) { return stmts().bySlugRole.all(slug, 'guardian'); }

/** A site is a guardian once it stands in any accepted guardian relation. */
export function isGuardian(slug) { return listWards(slug).length > 0; }

export function getRelation(slug, role, otherUri) { return stmts().one.get(slug, role, otherUri); }

// ── Writes (only the handshake commit lands here) ────────────────────────

/** The local ward gains a guardian (commit, §3.1.4). */
export function commitGuardianForWard(wardSlug, guardianUri, { handle = null, offerId = null } = {}) {
  stmts().commit.run(wardSlug, 'ward', guardianUri, handle, offerId);
  return stmts().one.get(wardSlug, 'ward', guardianUri);
}

/** The local guardian gains a ward (commit, §3.1.4). */
export function commitWardForGuardian(guardianSlug, wardUri, { handle = null, offerId = null } = {}) {
  stmts().commit.run(guardianSlug, 'guardian', wardUri, handle, offerId);
  return stmts().one.get(guardianSlug, 'guardian', wardUri);
}

/** End a relation locally (Undo, §3.2 — federation of the Undo is Fase 4). */
export function removeRelation(slug, role, otherUri) {
  stmts().del.run(slug, role, otherUri);
  return { ok: true };
}

// ── Actor document (FEP-633c §2) ─────────────────────────────────────────

/**
 * Guardianship props for a local actor doc. `id` is the actor URI.
 * - shaer:guardians: accepted guardians of this ward (omitted when none, §2.1)
 * - shaer:isGuardian: true once the site guards anyone
 * - shaer:queues: the owner-only dashboard collections
 *
 * §1 mutual exclusion: a ward (has guardians) is never a guardian, so
 * shaer:isGuardian is suppressed if guardians exist; the offer path already
 * bars a ward from offering.
 */
export function actorProps(id, slug) {
  const props = {
    'shaer:queues': {
      offers: `${id}/queues/offers`,
      follows: `${id}/queues/follows`,
      // Both directions of §5.3, kept apart on purpose: a guardian must be able
      // to tell "someone wants to follow your ward" from "your ward wants to
      // follow someone". Same mechanism, opposite question, different words in
      // the interface (shaer-p729).
      outgoingFollows: `${id}/queues/outgoing-follows`,
      wards: `${id}/queues/wards`,
      guardians: `${id}/queues/guardians`,
    },
  };
  const guardians = listGuardians(slug).map((r) => r.other_uri);
  if (guardians.length) {
    props['shaer:guardians'] = guardians;   // a ward
  } else if (isGuardian(slug)) {
    props['shaer:isGuardian'] = true;        // a guardian (never both, §1)
  }
  return props;
}

export default {
  listGuardians, listWards, isGuardian, getRelation,
  commitGuardianForWard, commitWardForGuardian, removeRelation, actorProps,
};
