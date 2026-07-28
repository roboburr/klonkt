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
import * as gated from './gated.js';

let deps = null;
export function wireHandshake(d) { deps = d; }

const idOf = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null));
const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');

/**
 * FEP-633c §3.2/§3.3 — ending a guardianship.
 *
 * "After commit, either side MAY end the relationship with `Undo` of the
 * `Relationship`. An `Undo` from a guardian, or from the ward co-signed by an
 * existing guardian, removes the guardian from `shaer:guardians`."
 *
 * §3.3 bounds it: this is how ONE guardian goes while others remain. Removing
 * the last one empties `shaer:guardians` and that is emancipation (§3.4), which
 * has its own flow and is explicitly not a single party's call. So an Undo that
 * would leave a ward with nobody is refused here rather than quietly performed.
 */
export function parseUndoRelationship(activity) {
  const type = Array.isArray(activity && activity.type) ? activity.type[0] : (activity && activity.type);
  if (type !== 'Undo') return null;
  return parseRelationship(activity && activity.object);
}

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
 *  candidate writes its ward. Each instance writes only what it hosts.
 *  other_handle is the human @handle for display (from the offer); the FEP
 *  escalation handle (candidate inbox) lives on the offer row, not here. */
function applyCommitLocally(offer) {
  const wardSlug = deps.localSlug(offer.ward_uri);
  const candSlug = deps.localSlug(offer.candidate_uri);
  if (wardSlug) relations.commitGuardianForWard(wardSlug, offer.candidate_uri, { handle: offer.candidate_handle, offerId: offer.offer_id });
  if (candSlug) relations.commitWardForGuardian(candSlug, offer.ward_uri, { handle: offer.ward_handle, offerId: offer.offer_id });
}

/** Commit this local copy of the offer when the tally is complete (ward +
 *  candidate + ≥1 existing guardian, §3.1.2). The handle is the candidate's
 *  inbox (§6 minimum); the commit is order-independent, so whichever accept
 *  lands last triggers it on every copy. */
function maybeCommit(slug, offerId) {
  const offer = offers.getOffer(slug, offerId);
  if (!offer || !offers.readyToCommit(offer)) return null;
  const done = offers.commit(slug, offerId, `${offer.candidate_uri}/inbox`);
  if (done) { applyCommitLocally(done); notify(slug, { kind: 'committed', ward: done.ward_uri, guardian: done.candidate_uri }); }
  return done;
}

/**
 * End a guardianship from the local guardian's side and let it travel (§3.2).
 *
 * One path for both callers: the button in the Guardian PWA and an `Undo` a
 * Guardian app POSTs to its own outbox. Addressed like the Offer that started
 * it (§3.1.1): the ward, and every other guardian, so no copy is left behind
 * believing the relation still stands.
 */
export async function endGuardianship(site, wardUri) {
  const me = deps.selfId(site.slug);
  if (!relations.getRelation(site.slug, 'guardian', wardUri)) return { status: 404, error: 'not_my_ward' };
  const set = await existingGuardiansOf(wardUri);
  const others = set.filter((g) => g !== me);
  // Only a set we actually read counts as proof. A remote ward whose server is
  // down reads as an empty set; refusing on that would trap the guardian, and
  // the ward's server checks again on arrival anyway.
  if (set.length && others.length === 0) return { status: 409, error: 'would_emancipate' };
  const recipients = [wardUri, ...others];
  const undo = {
    id: `${me}/undo/${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    type: 'Undo', actor: me, to: recipients,
    object: { type: 'Relationship', subject: wardUri, relationship: GUARDIAN_RELATIONSHIP_COMPACT, object: me },
  };
  const delivered = await fanout(site, recipients, undo);
  relations.removeRelation(site.slug, 'guardian', wardUri);
  // A ward we host ourselves never receives its own delivery: an inbox on this
  // machine is not reachable over HTTP from this machine (and should not be).
  // The commit path has the same shape and solves it the same way — each
  // instance writes what it hosts (applyCommitLocally).
  const wardSlug = deps.localSlug(wardUri);
  if (wardSlug) dropGuardianFromWard(wardSlug, deps.selfId(site.slug));
  notify(site.slug, { kind: 'guardianship_ended', ward: wardUri, delivered });
  return { status: 202, delivered, guardiansLeft: others.length };
}

/**
 * The ward's side of an ended guardianship: drop that guardian, unless doing so
 * would empty the set. §3.3 only permits this while more than one remains;
 * emptying it is emancipation (§3.4) and no single party decides that.
 */
function dropGuardianFromWard(wardSlug, guardianUri) {
  const set = relations.listGuardians(wardSlug).map((r) => r.other_uri);
  if (!set.includes(guardianUri)) return false;   // already gone: an Undo is idempotent
  if (set.length <= 1) {
    notify(wardSlug, { kind: 'guardianship_end_refused', guardian: guardianUri, reason: 'would_emancipate' });
    return false;
  }
  relations.removeRelation(wardSlug, 'ward', guardianUri);
  notify(wardSlug, { kind: 'guardian_left', guardian: guardianUri });
  return true;
}

/** The receiving side of that Undo. Returns true when consumed. */
function applyInboundUndo(site, activity) {
  const rel = parseUndoRelationship(activity);
  if (!rel) return false;
  const me = deps.selfId(site.slug);
  const actor = idOf(activity.actor);
  const ward = rel.ward;
  const guardian = rel.candidate;   // in an Undo the Relationship's object is the leaving guardian

  if (ward === me) {
    // I am the ward. Only the guardian itself may end its own relation here;
    // the ward-co-signed variant of §3.2 needs a second signature and is not
    // built, so it is refused rather than half-honoured.
    if (actor !== guardian) return false;
    dropGuardianFromWard(site.slug, guardian);
    return true;
  }

  // I am one of the other guardians: nothing of mine changes, but being left
  // as one of fewer is exactly the kind of thing a guardian should hear about.
  if (relations.getRelation(site.slug, 'guardian', ward)) {
    notify(site.slug, { kind: 'coguardian_left', ward, guardian });
    return true;
  }
  return false;
}

// ── C2S: a LOCAL party acts (PWA, Berichten, or the Shaer app outbox) ──────

/**
 * Handle a guardianship activity POSTed to the local outbox. Returns null when
 * it is not ours, else {status, ...} for the route.
 */
export async function handleOutbox(site, activity) {
  const type = Array.isArray(activity.type) ? activity.type[0] : activity.type;
  if (!['Offer', 'Accept', 'Reject', 'Undo'].includes(type)) return null;
  const me = deps.selfId(site.slug);

  // ── Undo: a guardian ends its own guardianship (§3.2). Same path as the
  //    button in the Guardian PWA, so an app and the dashboard cannot drift.
  if (type === 'Undo') {
    const rel = parseUndoRelationship(activity);
    if (!rel) return null;
    if (rel.candidate !== me) return { status: 403, error: 'not_your_relation' };
    return endGuardianship(site, rel.ward);
  }

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
  if (!['Offer', 'Accept', 'Reject', 'Undo'].includes(type)) return false;
  if (type === 'Undo') return applyInboundUndo(site, activity);
  const me = deps.selfId(site.slug);
  const actor = idOf(activity.actor);

  // §5.6: a guardian proposes a gated setting for THIS ward. The ward's server
  // tallies and enforces, so the decision lands here, not on the proposer.
  if (type === 'Offer') {
    const gs = gated.parseGatedSetting(activity.object);
    if (gs) {
      if (gs.ward !== me) return false;                       // not our ward
      gated.rememberGatedOffer(idOf(activity), site.slug, gs.feature, gs.value);
      // The proposer's Offer carries its own agreement (§3.1's one-step clause).
      const r = gated.recordGatedVote(site.slug, gs.feature, actor, gs.value);
      notify(site.slug, { kind: 'gated_setting', feature: gs.feature, value: gs.value, state: r.state });
      return true;
    }
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
  // §5.6: a fellow guardian answering a gated-setting proposal. The Accept only
  // references the offer, so the value comes from the proposal we stored. A
  // Reject is a vote for the opposite, not a shrug: it is still an answer.
  const gsOffer = gated.recallGatedOffer(offerId);
  if (gsOffer && gsOffer.slug === site.slug) {
    const value = type === 'Accept' ? !!gsOffer.value : !gsOffer.value;
    const r = gated.recordGatedVote(site.slug, gsOffer.feature, actor, value);
    notify(site.slug, { kind: 'gated_setting', feature: gsOffer.feature, value, state: r.state });
    return true;
  }
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

export default { wireHandshake, handleOutbox, handleInbox, parseRelationship, parseUndoRelationship, endGuardianship };
