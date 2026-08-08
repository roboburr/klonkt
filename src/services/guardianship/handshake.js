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
import { isGuardianRelationship, GUARDIAN_RELATIONSHIP_COMPACT, carriesGuardians } from './context.js';
import * as offers from './offers.js';
import * as relations from './relations.js';
import * as gated from './gated.js';
import * as availability from './availability.js';

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

/**
 * De overgebleven guardians opnieuw vertellen of ZIJ nu de doorslag geven
 * (shaer-8vt, Barts correctie 8-8).
 *
 * "Doorslaggevend" is geen eigenschap van een moment maar van een STAND: zodra
 * er nog een stem nodig is, is iedereen die nog moet antwoorden het. Eenmalig
 * berekenen bij het doorsturen bevriest een antwoord dat verandert.
 *
 * Nooit dragend: lukt de update niet, dan blijft de oude waarde staan. Die is
 * dan te voorzichtig of te stil -- en juist daarom staat de FAALSTAND aan de
 * kant van waarschuwen (isDecisive leest onbekend als "ja, jij beslist").
 */
function herzieDoorslag(site, offerId, gsOffer, laatsteStem) {
  try {
    const p = gated.gatedProgress(site.slug, gsOffer.feature);
    if (!gated.isDecisive(p.votes, p.need)) return;   // nog niets veranderd
    const me = deps.selfId(site.slug);
    const gestemd = new Set([gsOffer.proposer, laatsteStem].filter(Boolean));
    for (const g of relations.listGuardians(site.slug).map((x) => x.other_uri)) {
      if (gestemd.has(g)) continue;
      deps.deliverTo(site, g, {
        id: offerId, type: 'Offer', actor: me, to: [g],
        object: { type: 'shaer:GatedSetting', 'shaer:ward': me, 'shaer:feature': gsOffer.feature, 'shaer:value': !!gsOffer.value },
        'shaer:proposer': gsOffer.proposer || undefined,
        'shaer:decisive': true,
      }).catch(() => { /* de bezorgwachtrij probeert opnieuw */ });
    }
  } catch { /* nooit dragend */ }
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

/**
 * §5.6, the closing of the loop: a settled gated decision answers the Offer
 * that opened it. Accept when it settled on the proposed value, Reject when on
 * the opposite. Without this the proposer's screen can only ever say
 * "waiting", forever, whatever actually happened: the tally lives on the
 * ward's server and nobody else may read it, so the ward's server must speak.
 */
function answerGatedProposer(site, offerId, r) {
  const o = gated.recallGatedOffer(offerId);
  if (!o || !o.proposer) return;
  const me = deps.selfId(site.slug);
  if (o.proposer === me) return;   // the ward proposed to itself: nothing to write home
  const agreed = r.value === !!o.value;
  deps.deliverTo(site, o.proposer, {
    id: `${me}#gatedanswer-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    type: agreed ? 'Accept' : 'Reject',
    actor: me, to: [o.proposer], object: offerId,
  }).catch(() => { /* the delivery queue retries */ });
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

/**
 * FEP-633c §4.2 — is this candidate fit to be a guardian at all?
 *
 * A guardian MUST be free of guardians (§1). Checked here and not at the Offer,
 * because guardianship state can change in between: a candidate that was free
 * when it offered may have been adopted before the ward accepted. So the check
 * runs against a freshly dereferenced actor document, at the moment the
 * relationship would become real.
 *
 * Three answers, and the third is not a failure of this check but a failure to
 * perform it:
 *   'ok'          — free of guardians, may serve
 *   'malformed'   — carries shaer:guardians; a teapot (§4)
 *   'unverified'  — the actor could not be read at all
 */
async function candidateFitness(candidateUri) {
  // A candidate on this instance needs no dereference: our own tables are the
  // document, and fresher than anything we could fetch from ourselves. This is
  // also the co-located case (ward and guardian on one Klonkt), where there is
  // no network to be unreachable on.
  const local = deps.localSlug(candidateUri);
  if (local) return relations.listGuardians(local).length > 0 ? 'malformed' : 'ok';

  const doc = await deps.fetchActor(candidateUri).catch(() => null);
  if (!doc) return 'unverified';
  return carriesGuardians(doc) ? 'malformed' : 'ok';
}

/** Commit this local copy of the offer when the tally is complete (ward +
 *  candidate + ≥1 existing guardian, §3.1.2). The handle is the candidate's
 *  inbox (§6 minimum); the commit is order-independent, so whichever accept
 *  lands last triggers it on every copy. */
async function maybeCommit(slug, offerId) {
  const offer = offers.getOffer(slug, offerId);
  if (!offer || !offers.readyToCommit(offer)) return { done: null, refused: null };

  const fitness = await candidateFitness(offer.candidate_uri);

  // §4.2: unlike the soft skip at delivery (§4.1), this refusal is loud. A
  // handshake concerns exactly one candidate, so there is no remaining
  // well-formed target to continue to; committing anyway would leave the ward
  // counting a guardian whose escalations get dropped. Voiding is all this
  // function does; saying so on the wire belongs to whoever was acting.
  if (fitness === 'malformed') {
    offers.recordReject(slug, offerId, offer.ward_uri);   // voids this copy (§3.2)
    notify(slug, {
      kind: 'offer_rejected', offer: offerId,
      reason: 'not_a_teapot', candidate: offer.candidate_uri,
    });
    return { done: null, refused: 'not_a_teapot', offer };
  }

  // Could not read the candidate: neither commit nor void. Refusing outright
  // would let a momentary outage destroy a multi-party adoption; committing
  // would record a guardian nobody checked. The offer stays pending and the
  // next accept retries.
  if (fitness === 'unverified') return { done: null, refused: null };

  const done = offers.commit(slug, offerId, `${offer.candidate_uri}/inbox`);
  if (done) { applyCommitLocally(done); notify(slug, { kind: 'committed', ward: done.ward_uri, guardian: done.candidate_uri }); }
  return { done, refused: null };
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
  // One answer restores everything (§3.6): any C2S activity from this actor
  // is that answer, for every local ward it guards. Runs before anything is
  // even looked at, so the target of a running lapse cancels it by doing
  // anything at all — including trying to vote on it.
  try { availability.oneAnswer(me, Date.now()); } catch { /* never load-bearing */ }

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
    // §3.6.3 over C2S: a guardian here proposes releasing a dormant
    // co-guardian. A ward we host opens locally; a remote ward gets the
    // proposal delivered, because the ward's server is the one that tallies
    // and enforces (the §5.6 line: a guardian next door must not have more
    // say than one far away).
    const lp = availability.parseLapse(activity.object);
    if (lp) {
      // ONE path (Robins regel, 29-7): the ward's server opens, tallies and
      // enforces, wherever it lives. A local ward is reached by the same
      // deliverTo, which loops back into the inbox handler; co-location is a
      // transport detail and never a shortcut past the decision.
      const id = `${me}/lapses/${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      const offer = { id, type: 'Offer', actor: me, to: [lp.ward], object: { type: 'shaer:Lapse', 'shaer:ward': lp.ward, object: lp.target } };
      const delivered = await fanout(site, [lp.ward], offer);
      return { status: 202, id, url: id, delivered };
    }
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
  // A lapse vote over C2S (§3.6.3): the same Accept/Reject wire the offers
  // and gated follows use, which is exactly why the Shaer clients need no
  // new verbs for it.
  if (availability.getLapse(offerId)) {
    const r = availability.lapseVote(offerId, me, type === 'Accept', Date.now());
    if (r && r.error) return { status: r.error === 'not_in_set' ? 403 : 409, error: r.error };
    return { status: 202, id: offerId, url: offerId, 'shaer:outcome': 'open', 'shaer:accepts': r.accepts, 'shaer:threshold': r.threshold };
  }
  let offer = offers.getOffer(site.slug, offerId);
  if (!offer) return { status: 404, error: 'no_such_offer' };
  const others = offers.parties(offer).filter((p) => p !== me);

  if (type === 'Reject') {
    offers.recordReject(site.slug, offerId, me);
    await fanout(site, others, { id: `${me}/answers/${Date.now().toString(36)}`, type: 'Reject', actor: me, to: others, object: offerId });
    notify(site.slug, { kind: 'offer_rejected', offer: offerId });
    return { status: 202, id: offerId, url: offerId };
  }

  // §1 is flat in BOTH directions. The Offer path above bars a ward from
  // offering to guard; this is the mirror: an actor that already guards wards
  // must not become a ward itself. Only the ward's own accept can create that
  // state, so the candidate and the existing guardians pass through untouched.
  //
  // Without it the inconsistency would also be invisible. actorProps() picks
  // one role with an if/else and would publish shaer:guardians while dropping
  // shaer:isGuardian, so this account keeps routing its wards' escalations
  // locally while every remote §4 check reads it as malformed and drops it —
  // a ward believing it is watched over when it is not, silent on both sides.
  if (me === offer.ward_uri && relations.listWards(site.slug).length) {
    return { status: 403, error: 'a_guardian_cannot_be_guarded' };
  }

  // Accept: record my accept, broadcast it to the other parties, and commit
  // this copy if the tally is now complete (order-independent, §3.1.3).
  offers.recordAccept(site.slug, offerId, me);
  await fanout(site, others, { id: `${me}/answers/${Date.now().toString(36)}`, type: 'Accept', actor: me, to: others, object: offerId });
  const { done, refused, offer: voided } = await maybeCommit(site.slug, offerId);
  if (refused) {
    // §4.2: the refusal travels as a `Reject` of the Offer (§3.2), which an
    // implementation unaware of §4 still handles correctly. Who is told WHY is
    // not uniform, and deliberately so.
    const answer = (to, withReason) => ({
      id: `${me}/answers/${Date.now().toString(36)}`,
      type: 'Reject', actor: me, to, object: offerId,
      ...(withReason ? { 'shaer:notATeapot': true } : {}),
    });
    const candidate = voided && voided.candidate_uri;
    // The ward and its existing guardians MUST learn the reason: they are
    // parties, the condition is public data (§2.1), and a bare void would
    // leave a ward believing an adoption completed that did not.
    const family = others.filter((u) => u !== candidate);
    if (family.length) await fanout(site, family, answer(family, true));
    // The candidate gets a BARE Reject. Commit is the last step of §3.1, so a
    // refusal that names itself technical also discloses that every human
    // party already accepted and only the protocol objected — which, where a
    // guardianship is contested, is not theirs to learn. The kind path for an
    // merely misconfigured candidate is the check on the Offer, before anyone
    // has consented to anything.
    if (candidate && others.includes(candidate)) await fanout(site, [candidate], answer([candidate], false));
    return { status: 202, id: offerId, url: offerId, committed: false, refused };
  }
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
      const offerId = idOf(activity);
      // ── I am the WARD: record, tally, and forward to the other guardians.
      if (gs.ward === me) {
        gated.rememberGatedOffer(offerId, site.slug, gs.feature, gs.value, actor);
        // The proposer's Offer carries its own agreement (§3.1's one-step clause).
        const r = gated.recordGatedVote(site.slug, gs.feature, actor, gs.value);
        // The forward is the leg that was missing. A proposal addressed to the
        // ward's server reaches only the proposer and the ward; the other
        // guardians never learn it exists, so a threshold of two can never be
        // met and every proposal expires unanswered. The ward's server is the
        // one that knows the authoritative guardian list, which is exactly why
        // §5.3 forwards a gated follow from here too.
        if (r.state === 'open') {
          for (const g of relations.listGuardians(site.slug).map((x) => x.other_uri)) {
            if (g === actor) continue;   // the proposer already answered
            // The forward goes out AS THE WARD, because the ward's key signs
            // it. Keeping the proposer in `actor` made every receiver answer
            // 401 signer mismatch, and rightly so: the body claimed one author
            // and the signature proved another. §5.3 forwards a gated follow
            // the same way. Who proposed it rides along separately, for the
            // guardian's screen.
            // Zou DIT antwoord het besluit afmaken (shaer-8vt)? De telling loopt
            // hier, op de server van het kind, en nergens anders -- zonder dit
            // veld kan een guardian elders onmogelijk weten dat hij de doorslag
            // geeft. Een ja/nee en geen getal: zie isDecisive.
            const p = gated.gatedProgress(site.slug, gs.feature);
            deps.deliverTo(site, g, {
              id: offerId, type: 'Offer', actor: me, to: [g], object: activity.object,
              'shaer:proposer': actor,
              'shaer:decisive': gated.isDecisive(p.votes, p.need),
            }).catch(() => { /* the delivery queue retries */ });
          }
        } else {
          gated.clearGatedReviews(offerId);   // settled at once: nothing left to ask
          answerGatedProposer(site, offerId, r);
        }
        notify(site.slug, { kind: 'gated_setting', feature: gs.feature, value: gs.value, state: r.state });
        return true;
      }
      // ── I am one of the GUARDIANS: the forwarded copy. Store it so this
      //    guardian can answer; the answer goes back to the ward, which tallies.
      if (relations.getRelation(site.slug, 'guardian', gs.ward)) {
        const wardDoc = await deps.fetchActor(gs.ward).catch(() => null);
        gated.recordGatedReview(site.slug, {
          id: offerId, wardUri: gs.ward, wardInbox: wardDoc && wardDoc.inbox,
          // A forward is signed by the ward, so `actor` is the ward; the
          // guardian who opened it travels in shaer:proposer.
          proposer: (typeof activity['shaer:proposer'] === 'string' ? activity['shaer:proposer'] : actor),
          feature: gs.feature, value: gs.value,
          // Ontbreekt het veld (een oudere server), dan WAARSCHUWEN we: niets
          // zeggen terwijl je beslist is de gevaarlijke kant (shaer-8vt).
          decisive: activity['shaer:decisive'] !== false,
        });
        notify(site.slug, { kind: 'gated_review', feature: gs.feature, value: gs.value, ward: gs.ward });
        return true;
      }
      return false;   // not our ward, and not a ward we guard
    }
    // §3.6.3: a co-guardian proposes releasing a dormant guardian of THIS
    // ward. The ward's server opens, tallies and (after the full window)
    // executes, exactly as it does for the gated settings above.
    const lp = availability.parseLapse(activity.object);
    if (lp) {
      if (lp.ward !== me) return false;   // not our ward
      const id = idOf(activity) || `${me}/lapses/${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      const r = availability.openLapse({ id, wardSlug: site.slug, wardUri: me, target: lp.target, openedBy: actor, now: Date.now() });
      if (r.error) {
        notify(site.slug, { kind: 'lapse_refused', reason: r.error, target: lp.target });
        return true;   // consumed: the refusal is the answer
      }
      // The target is notified like any dormancy marking (§3.6.2): in
      // protocol (a copy of the Offer, so one answer can cancel it) AND the
      // §6 handle, which for a committed guardian is its inbox — the same
      // door this delivery knocks on.
      deps.deliverTo(site, lp.target, activity).catch(() => { /* best-effort */ });
      notify(site.slug, { kind: 'lapse_opened', lapse: id, target: lp.target, set: r.set });
      return true;
    }
    const rel = parseRelationship(activity.object);
    if (!rel) return false;
    // I must be a party: the ward, or one of the existing guardians in `to`.
    const recipients = arr(activity.to);
    const existing = recipients.filter((u) => u !== rel.ward);
    if (rel.ward !== me && !existing.includes(me)) return false;
    // §4.2: check the candidate here too, and refuse before anyone accepts.
    // At this point no party has consented, so saying why discloses nothing
    // about anyone's position, and a candidate that is merely misconfigured
    // can find that out and fix it. The commit-time check stays REQUIRED as
    // the backstop for a candidate whose state changes in between.
    if (await candidateFitness(rel.candidate) === 'malformed') {
      notify(site.slug, { kind: 'offer_refused', offer: idOf(activity), reason: 'not_a_teapot', candidate: rel.candidate });
      await fanout(site, [rel.candidate], {
        id: `${me}/answers/${Date.now().toString(36)}`,
        type: 'Reject', actor: me, to: [rel.candidate], object: idOf(activity), 'shaer:notATeapot': true,
      });
      return true;
    }
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
  // §5.6, the answer coming HOME: the ward's server settled a decision we
  // proposed and answers our Offer. Accept = it settled on what we proposed,
  // Reject = on the opposite. Only the ward may say so: the answer must come
  // from the ward the proposal was about, or anyone could close our books.
  const sent = gated.recallSent(offerId);
  if (sent && sent.guardian_slug === site.slug) {
    if (actor !== sent.ward_uri) return false;   // not the ward's voice: not an outcome
    const outcome = type === 'Accept' ? 'accepted' : 'rejected';
    gated.settleSent(offerId, outcome);
    notify(site.slug, { kind: 'gated_outcome', feature: sent.feature, value: !!sent.value, outcome, ward: sent.ward_uri });
    return true;
  }
  // §5.6: a fellow guardian answering a gated-setting proposal. The Accept only
  // references the offer, so the value comes from the proposal we stored. A
  // Reject is a vote for the opposite, not a shrug: it is still an answer.
  const gsOffer = gated.recallGatedOffer(offerId);
  if (gsOffer && gsOffer.slug === site.slug) {
    const value = type === 'Accept' ? !!gsOffer.value : !gsOffer.value;
    const r = gated.recordGatedVote(site.slug, gsOffer.feature, actor, value);
    if (r.state === 'settled') answerGatedProposer(site, offerId, r);
    // DOORSLAGGEVEND SCHUIFT MEE (Barts correctie, 8-8). Ik berekende dit een
    // keer bij het doorsturen en bevroor het. Bij vijf guardians staat er dan
    // "je beslist niets" -- en zodra er een ja bij komt IS elk van de anderen de
    // doorslag. Dat is precies de stille kant: het scherm zwijgt op het moment
    // dat het moet spreken.
    //
    // Dus na elke stem die het open laat: de overgeblevenen opnieuw vertellen
    // waar ze staan. Alleen wie NOG NIET geantwoord heeft, en alleen als het
    // antwoord verandert -- anders is dit een bericht per stem per guardian.
    else herzieDoorslag(site, offerId, gsOffer, actor);
    notify(site.slug, { kind: 'gated_setting', feature: gsOffer.feature, value, state: r.state });
    return true;
  }
  // §3.6.3: a set member answering a running lapse. Irreversible, so even a
  // full tally leaves it open until the window closes (§3.5); the completion
  // happens lazily on reads (queues) once the window has run.
  if (availability.getLapse(offerId)) {
    const r = availability.lapseVote(offerId, actor, type === 'Accept', Date.now());
    notify(site.slug, { kind: 'lapse_vote', lapse: offerId, by: actor, state: r && !r.error ? 'recorded' : (r && r.error) || 'refused' });
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
  await maybeCommit(site.slug, offerId);   // commits this copy once the tally is complete (§4.2 may refuse)
  return true;
}

/**
 * §4.2 SHOULD: retry the dereference for handshakes left deferred because the
 * candidate could not be read.
 *
 * Waiting for a further activity from a party is not enough: the commit is
 * triggered by the LAST `Accept`, so if that one has already arrived nothing
 * will ever poke it again and the handshake would sit until its window closed.
 * The ward's dashboard polling its own offers queue is this instance's
 * schedule, exactly as a read settles a lapse (§3.6.3).
 *
 * Deliberately not awaited by the read: a poll should render what is true now,
 * not block on someone else's slow server. A retry that succeeds shows up in
 * the next poll, which is the same second or two later.
 */
export async function retryDeferred(slug) {
  for (const o of offers.listDeferred(slug)) {
    await maybeCommit(slug, o.offer_id).catch(() => { /* next poll tries again */ });
  }
}

function notify(slug, ev) {
  try { if (deps && typeof deps.onEvent === 'function') deps.onEvent(slug, ev); } catch { /* best-effort */ }
}

export default { wireHandshake, handleOutbox, handleInbox, parseRelationship, parseUndoRelationship, endGuardianship, retryDeferred };
