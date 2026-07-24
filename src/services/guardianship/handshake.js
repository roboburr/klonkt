/**
 * Guardianship (FEP-633c §3) — the adoption handshake, multi-party and
 * distributed across instances.
 *
 * The candidate Offers a Relationship{subject: ward, object: candidate},
 * addressed to the ward AND every existing guardian of the ward. Each party
 * (ward, existing guardians, and finally the candidate) Accepts, addressed to
 * all the others, so every instance's copy of the tally converges. The
 * candidate's Accept is the LAST one and carries the escalation handle in
 * `result`: that return is the atomic commit (§3.1.3). Only then does the
 * ward gain the guardian in shaer:guardians and the guardian gain the ward.
 * A single Reject from any party voids the offer (§3.2).
 *
 * The state machine lives in offers.js (a faithful port of the Shaer test
 * daemon); this module wires it onto Klonkt's C2S/S2S plumbing. AP helpers
 * arrive once via wireHandshake(deps); nothing here imports ActivityPubService.
 */
import { isGuardianRelationship, GUARDIAN_RELATIONSHIP_COMPACT } from './context.js';
import * as offers from './offers.js';
import * as relations from './relations.js';

let deps = null;
export function wireHandshake(d) { deps = d; }

const idOf = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null));
const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');

/** Parse a Relationship object into {ward, candidate} or null. */
export function parseRelationship(rel) {
  if (!rel || typeof rel !== 'object') return null;
  const type = Array.isArray(rel.type) ? rel.type[0] : rel.type;
  if (type !== 'Relationship') return null;
  if (!isGuardianRelationship(String(rel.relationship || ''))) return null;
  const ward = idOf(rel.subject);
  const candidate = idOf(rel.object);
  return ward && candidate ? { ward, candidate } : null;
}

/** The existing guardians of a ward: local list, or the remote actor's shaer:guardians. */
async function existingGuardiansOf(wardUri) {
  const local = deps.localSlug(wardUri);
  if (local) return relations.listGuardians(local).map((r) => r.other_uri);
  const doc = await deps.fetchActor(wardUri).catch(() => null);
  const g = doc && doc['shaer:guardians'];
  return Array.isArray(g) ? g.filter((x) => typeof x === 'string') : [];
}

function offerActivity(offerId, ward, candidate, recipients) {
  return {
    id: offerId, type: 'Offer', actor: candidate, to: recipients,
    object: { type: 'Relationship', subject: ward, relationship: GUARDIAN_RELATIONSHIP_COMPACT, object: candidate },
  };
}

/** Deliver `activity` to every uri in `recipients` (skipping the local self). */
async function fanout(site, recipients, activity) {
  let anyDelivered = false;
  for (const uri of [...new Set(recipients)]) {
    const r = await deps.deliverTo(site, uri, activity).catch(() => ({ delivered: false }));
    if (r && r.delivered !== false) anyDelivered = true;
  }
  return anyDelivered;
}

/** Apply the local side of a commit: the ward writes its guardian, the
 *  candidate writes its ward. Each instance writes only what it hosts. */
function applyCommitLocally(offer, handle) {
  const wardSlug = deps.localSlug(offer.ward_uri);
  const candSlug = deps.localSlug(offer.candidate_uri);
  if (wardSlug) relations.commitGuardianForWard(wardSlug, offer.candidate_uri, { handle, offerId: offer.offer_id });
  if (candSlug) relations.commitWardForGuardian(candSlug, offer.ward_uri, { handle, offerId: offer.offer_id });
}

/** Commit this local copy of the offer when the tally is complete (ward +
 *  candidate + ≥1 existing guardian, §3.1.2). The handle is the candidate's
 *  inbox (§6 minimum); the commit is order-independent, so whichever accept
 *  lands last triggers it on every copy. */
function maybeCommit(slug, offerId) {
  const offer = offers.getOffer(slug, offerId);
  if (!offer || !offers.readyToCommit(offer)) return null;
  const done = offers.commit(slug, offerId, `${offer.candidate_uri}/inbox`);
  if (done) { applyCommitLocally(done, done.handle); notify(slug, { kind: 'committed', ward: done.ward_uri, guardian: done.candidate_uri }); }
  return done;
}

// ── C2S: a LOCAL party acts (PWA, Berichten, or the Shaer app outbox) ──────

/**
 * Handle a guardianship activity POSTed to the local outbox. Returns null when
 * it is not ours, else {status, ...} for the route.
 */
export async function handleOutbox(site, activity) {
  const type = Array.isArray(activity.type) ? activity.type[0] : activity.type;
  if (!['Offer', 'Accept', 'Reject'].includes(type)) return null;
  const me = deps.selfId(site.slug);

  // ── Offer: the local site is the guardian-candidate. ───────────────────
  if (type === 'Offer') {
    const rel = parseRelationship(activity.object);
    if (!rel) return null;
    if (rel.candidate !== me) return { status: 403, error: 'only_the_candidate_offers' };   // fixed initiator (§3.1)
    if (relations.listGuardians(site.slug).length) return { status: 403, error: 'a_ward_cannot_guard' };  // §1
    const existing = await existingGuardiansOf(rel.ward);
    const offerId = `${me}/offers/${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    offers.start(site.slug, {
      offerId, ward: rel.ward, candidate: me, existingGuardians: existing,
      wardHandle: deps.deriveHandle(rel.ward), candidateHandle: deps.deriveHandle(me),
    });
    // The Offer IS the candidate's agreement to serve: record it as the
    // candidate's accept. So a FREE ward commits on its own single accept (no
    // second guardian to co-approve yet); once it IS a ward, adding another
    // guardian still needs an existing guardian to co-accept.
    offers.recordAccept(site.slug, offerId, me);
    // Addressed to the ward AND every existing guardian (§3.1.1).
    const recipients = [rel.ward, ...existing];
    const delivered = await fanout(site, recipients, offerActivity(offerId, rel.ward, me, recipients));
    notify(site.slug, { kind: 'offer_sent', ward: rel.ward });
    return { status: 202, id: offerId, url: offerId, delivered };
  }

  // ── Accept / Reject: the local site is a party answering an offer. ─────
  const offerId = idOf(activity.object);
  if (!offerId) return { status: 400, error: 'missing_offer' };
  let offer = offers.getOffer(site.slug, offerId);
  if (!offer) return { status: 404, error: 'no_such_offer' };
  const others = offers.parties(offer).filter((p) => p !== me);

  if (type === 'Reject') {
    offers.recordReject(site.slug, offerId, me);
    await fanout(site, others, { id: `${me}/answers/${Date.now().toString(36)}`, type: 'Reject', actor: me, to: others, object: offerId });
    notify(site.slug, { kind: 'offer_rejected', offer: offerId });
    return { status: 202, id: offerId, url: offerId };
  }

  // Accept: record my accept, broadcast it to the other parties, and commit
  // this copy if the tally is now complete (order-independent, §3.1.3).
  offers.recordAccept(site.slug, offerId, me);
  await fanout(site, others, { id: `${me}/answers/${Date.now().toString(36)}`, type: 'Accept', actor: me, to: others, object: offerId });
  const done = maybeCommit(site.slug, offerId);
  return { status: 202, id: offerId, url: offerId, committed: !!done, readyToCommit: offers.readyToCommit(offers.getOffer(site.slug, offerId)) };
}

// ── S2S: a REMOTE party's activity arrives in a local inbox ────────────────

/**
 * Handle an inbound guardianship activity for the local site `site` (the inbox
 * owner). Returns true when consumed.
 */
export async function handleInbox(site, activity) {
  const type = Array.isArray(activity.type) ? activity.type[0] : activity.type;
  if (!['Offer', 'Accept', 'Reject'].includes(type)) return false;
  const me = deps.selfId(site.slug);
  const actor = idOf(activity.actor);

  if (type === 'Offer') {
    const rel = parseRelationship(activity.object);
    if (!rel) return false;
    // I must be a party: the ward, or one of the existing guardians in `to`.
    const recipients = arr(activity.to);
    const existing = recipients.filter((u) => u !== rel.ward);
    if (rel.ward !== me && !existing.includes(me)) return false;
    offers.start(site.slug, {
      offerId: idOf(activity), ward: rel.ward, candidate: rel.candidate, existingGuardians: existing,
      wardHandle: deps.deriveHandle(rel.ward), candidateHandle: deps.deriveHandle(rel.candidate),
    });
    // The Offer carries the candidate's agreement (see the C2S side): record it
    // so this copy's tally matches — a free ward then commits on its own accept.
    offers.recordAccept(site.slug, idOf(activity), rel.candidate);
    notify(site.slug, { kind: rel.ward === me ? 'offer_received' : 'offer_for_ward', ward: rel.ward, candidate: rel.candidate });
    return true;
  }

  // Accept / Reject of an offer we (also) track.
  const offerId = idOf(activity.object);
  let offer = offers.getOffer(site.slug, offerId);
  if (!offer) return false;
  if (!offers.isParty(offer, actor)) return false;

  if (type === 'Reject') {
    offers.recordReject(site.slug, offerId, actor);
    notify(site.slug, { kind: 'offer_rejected', offer: offerId });
    return true;
  }

  offers.recordAccept(site.slug, offerId, actor);
  maybeCommit(site.slug, offerId);   // commits this copy once the tally is complete
  return true;
}

function notify(slug, ev) {
  try { if (deps && typeof deps.onEvent === 'function') deps.onEvent(slug, ev); } catch { /* best-effort */ }
}

export default { wireHandshake, handleOutbox, handleInbox, parseRelationship };
