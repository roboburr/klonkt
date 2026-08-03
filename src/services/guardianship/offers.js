/**
 * Guardianship (FEP-633c §3) — the multi-party handshake state.
 *
 * A faithful port of the Shaer test daemon's `Handshake`, persisted per local
 * site (so the two implementations behave identically and the clients speak
 * one contract). One row in ap_guardian_offers per offer this instance is a
 * party to; the accepts accumulate in ap_guardian_offer_accepts.
 *
 * The offer commits only when the guardian-candidate returns the handle
 * (§3.1.3) after ward + candidate + at least one existing guardian have
 * accepted (§3.1.2). A single Reject from any party voids it (§3.2). This is
 * the core safety property: no single party creates a guardianship alone, and
 * no new guardian is added without an existing guardian's consent.
 */
import db from '../../config/database.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      insOffer: db.prepare(`INSERT OR IGNORE INTO ap_guardian_offers
        (offer_id, slug, ward_uri, candidate_uri, existing_guardians, status, ward_handle, candidate_handle, created_at)
        VALUES (?,?,?,?,?, 'pending', ?, ?, CURRENT_TIMESTAMP)`),
      getOffer: db.prepare('SELECT * FROM ap_guardian_offers WHERE slug=? AND offer_id=?'),
      offerAnywhere: db.prepare('SELECT * FROM ap_guardian_offers WHERE offer_id=? LIMIT 1'),
      setStatus: db.prepare('UPDATE ap_guardian_offers SET status=?, handle=COALESCE(?, handle) WHERE slug=? AND offer_id=?'),
      listBySlug: db.prepare("SELECT * FROM ap_guardian_offers WHERE slug=? AND status='pending' ORDER BY created_at DESC"),
      insAccept: db.prepare('INSERT OR IGNORE INTO ap_guardian_offer_accepts (offer_id, slug, party_uri, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)'),
      accepts: db.prepare('SELECT party_uri FROM ap_guardian_offer_accepts WHERE slug=? AND offer_id=?'),
    };
  }
  return _s;
}

const parties = (o) => [o.ward_uri, o.candidate_uri, ...JSON.parse(o.existing_guardians || '[]')];
const isParty = (o, actor) => !!actor && parties(o).includes(actor);
const acceptsOf = (o) => stmts().accepts.all(o.slug, o.offer_id).map((r) => r.party_uri);

/** ward + candidate + (no existing guardians OR at least one existing) accepted. */
export function readyToCommit(o) {
  if (!o || o.status !== 'pending') return false;
  const acc = new Set(acceptsOf(o));
  const existing = JSON.parse(o.existing_guardians || '[]');
  const existingOk = existing.length === 0 || existing.some((g) => acc.has(g));
  return acc.has(o.ward_uri) && acc.has(o.candidate_uri) && existingOk;
}

/** Start tracking an offer on `slug` (idempotent). */
export function start(slug, { offerId, ward, candidate, existingGuardians = [], wardHandle = null, candidateHandle = null }) {
  stmts().insOffer.run(offerId, slug, ward, candidate, JSON.stringify(existingGuardians || []), wardHandle, candidateHandle);
  return stmts().getOffer.get(slug, offerId);
}

export function getOffer(slug, offerId) { return stmts().getOffer.get(slug, offerId); }
export function findOfferAnywhere(offerId) { return stmts().offerAnywhere.get(offerId); }

/** Record an Accept from one party; ignored if not a party or already resolved. */
export function recordAccept(slug, offerId, party) {
  const o = stmts().getOffer.get(slug, offerId);
  if (!o || o.status !== 'pending' || !isParty(o, party)) return o;
  stmts().insAccept.run(offerId, slug, party);
  return stmts().getOffer.get(slug, offerId);
}

/** A single Reject from any party voids the handshake (§3.2). */
export function recordReject(slug, offerId, party) {
  const o = stmts().getOffer.get(slug, offerId);
  if (!o || o.status !== 'pending' || !isParty(o, party)) return o;
  stmts().setStatus.run('void', null, slug, offerId);
  return stmts().getOffer.get(slug, offerId);
}

/** Commit (only when ready): store the returned handle, mark committed. */
export function commit(slug, offerId, handle) {
  const o = stmts().getOffer.get(slug, offerId);
  if (!o || o.status !== 'pending' || !readyToCommit(o)) return null;
  stmts().setStatus.run('committed', handle || null, slug, offerId);
  return stmts().getOffer.get(slug, offerId);
}

/**
 * How long a guardianship handshake stays open (§3.5). Adding a guardian is a
 * reversible decision, but not a quick one: the ward, the candidate and every
 * existing guardian have to answer, and they are people, sometimes on holiday.
 * A week is long enough that nobody is rushed and short enough that a forgotten
 * offer does not sit in a child's queue for a month looking like a live choice.
 */
export const OFFER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** SQLite writes CURRENT_TIMESTAMP as UTC 'YYYY-MM-DD HH:MM:SS', which
 *  Date.parse reads as LOCAL time — hours out, and enough to expire an offer
 *  early or late. Same correction as ActivityPubService.isoStamp. */
const stampMs = (v) => {
  const s = String(v || '');
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
};

export const closesAt = (o) => stampMs(o.created_at) + OFFER_WINDOW_MS;

/**
 * §3.5 fails closed: once the window has run, a handshake that never completed
 * is over. WHICH failure it was matters (§4.2), so the two get different
 * terminal states and neither of them is `void`:
 *
 *   'expired'     — the parties never all answered. Nothing to say about anyone.
 *   'unverified'  — everyone answered; the candidate could never be read, so
 *                   the check never got to run. The parties MUST be told this
 *                   and MUST NOT be told the candidate was refused. It was not:
 *                   nobody ever managed to look.
 */
export function expireIfDue(slug, offerId, now = Date.now()) {
  const o = stmts().getOffer.get(slug, offerId);
  if (!o || o.status !== 'pending') return null;
  const due = closesAt(o);
  if (!Number.isFinite(due) || due > now) return null;
  const status = readyToCommit(o) ? 'unverified' : 'expired';
  stmts().setStatus.run(status, null, slug, offerId);
  return { ...o, status };
}

/** Pending offers where `me` is a party — the offers queue (daemon shape).
 *  Reads are where lazy completion happens, as with the lapses (§3.6.3): a
 *  closed window is settled here rather than by a sweeper nobody runs. */
export function listForParty(slug, me, now = Date.now()) {
  if (!stmts().listBySlug.get) return [];
  for (const o of stmts().listBySlug.all(slug)) expireIfDue(slug, o.offer_id, now);
  return stmts().listBySlug.all(slug).filter((o) => isParty(o, me));
}

/** Handshakes whose tally is complete but which are not committed: the §4.2
 *  deferred set, waiting on a candidate nobody could dereference. */
export function listDeferred(slug) {
  if (!stmts().listBySlug.get) return [];
  return stmts().listBySlug.all(slug).filter((o) => readyToCommit(o));
}

/** One offer as the offers-queue item the Shaer clients parse. */
export function queueItem(o, me) {
  const acc = acceptsOf(o).sort();
  return {
    id: o.offer_id,
    type: 'Offer',
    actor: o.candidate_uri,
    object: { type: 'Relationship', subject: o.ward_uri, relationship: 'shaer:Guardian', object: o.candidate_uri },
    'shaer:ward': o.ward_uri,
    'shaer:candidate': o.candidate_uri,
    'shaer:existingGuardians': JSON.parse(o.existing_guardians || '[]'),
    'shaer:acceptedBy': acc,
    'shaer:needsMyAccept': !acc.includes(me),
    'shaer:readyToCommit': readyToCommit(o),
    'shaer:iAmCandidate': me === o.candidate_uri,
    'shaer:wardHandle': o.ward_handle || undefined,
    'shaer:candidateHandle': o.candidate_handle || undefined,
    published: o.created_at,
  };
}

export { parties, isParty, acceptsOf };
export default {
  start, getOffer, findOfferAnywhere, recordAccept, recordReject, commit,
  readyToCommit, listForParty, queueItem, parties, isParty, acceptsOf,
  OFFER_WINDOW_MS, closesAt, expireIfDue, listDeferred,
};
