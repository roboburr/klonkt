/**
 * Guardianship (FEP-633c §3) — the adoption handshake.
 *
 * Offer(Relationship{subject: ward, relationship: shaer:Guardian, object:
 * candidate}) travels from the guardian-candidate to the ward; the ward
 * answers Accept (relation becomes real) or Reject (row disappears). The
 * shape mirrors the Shaer test daemon, so the iOS/Android clients speak it
 * unchanged.
 *
 * Wired like delivery.js: no import back into ActivityPubService; the AP
 * helpers arrive once via wireHandshake(deps). `deps.onEvent(slug, ev)` is an
 * optional hook the Guardian PWA uses for push notifications.
 */
import { isGuardianRelationship, GUARDIAN_RELATIONSHIP_COMPACT } from './context.js';
import * as relations from './relations.js';

let deps = null;
export function wireHandshake(d) { deps = d; }

const idOf = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null));

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

// ── C2S: the local account acts (PWA or Shaer app, via the outbox) ────────

/**
 * Handle a guardianship activity POSTed to the local outbox. Returns null
 * when the activity is not ours to handle, else {status, ...} for the route.
 */
export async function handleOutbox(site, activity) {
  const { selfId, deliverTo, deriveHandle } = deps;
  const type = Array.isArray(activity.type) ? activity.type[0] : activity.type;
  if (!['Offer', 'Accept', 'Reject'].includes(type)) return null;
  const me = selfId(site.slug);

  if (type === 'Offer') {
    const rel = parseRelationship(activity.object);
    if (!rel) return null;                                   // not a guardianship offer
    // Fixed initiator (FEP resolved B): only the aspirant guardian offers.
    if (rel.candidate !== me) return { status: 403, error: 'only_the_candidate_offers' };
    // A ward can never become a guardian (FEP §1).
    if (relations.listGuardians(site.slug).length) return { status: 403, error: 'a_ward_cannot_guard' };
    const offerId = `${me}/offers/${Date.now().toString(36)}`;
    const offer = {
      id: offerId, type: 'Offer', actor: me, to: [rel.ward],
      object: { type: 'Relationship', subject: rel.ward, relationship: GUARDIAN_RELATIONSHIP_COMPACT, object: me },
    };
    relations.recordOffer(site.slug, 'guardian', rel.ward, { handle: deriveHandle(rel.ward), offerId });
    const delivered = await deliverTo(site, rel.ward, offer).catch(() => false);
    notify(site.slug, { kind: 'offer_sent', ward: rel.ward });
    return { status: delivered ? 202 : 502, id: offerId, url: offerId };
  }

  // Accept / Reject: the local ward answers a pending offer.
  const obj = activity.object;
  const offerId = idOf(obj);
  const rel = parseRelationship(obj && obj.object) || parseRelationship(obj);
  let row = null;
  if (offerId) row = relations.findByOfferId(offerId).find((r) => r.slug === site.slug && r.role === 'ward') || null;
  if (!row && rel) row = relations.getRelation(site.slug, 'ward', rel.candidate) || null;
  if (!row) return { status: 404, error: 'no_such_offer' };

  const answer = {
    id: `${me}/answers/${Date.now().toString(36)}`, type, actor: me, to: [row.other_uri],
    object: row.offer_id || { type: 'Relationship', subject: me, relationship: GUARDIAN_RELATIONSHIP_COMPACT, object: row.other_uri },
  };
  if (type === 'Accept') {
    // The committed handle rides in `result` (daemon contract): the guardian
    // learns where the ward lives.
    answer.result = `${me}/inbox`;
    relations.acceptRelation(site.slug, 'ward', row.other_uri);
  } else {
    relations.removeRelation(site.slug, 'ward', row.other_uri);
  }
  const delivered = await deliverTo(site, row.other_uri, answer).catch(() => false);
  notify(site.slug, { kind: type === 'Accept' ? 'offer_accepted' : 'offer_rejected', guardian: row.other_uri });
  return { status: delivered ? 202 : 502, id: answer.id, url: answer.id };
}

// ── S2S: a remote party acts (arrives in the local inbox) ────────────────

/**
 * Handle an inbound guardianship activity for local site `site`. Returns
 * true when consumed (the generic inbox skips it), false otherwise.
 */
export async function handleInbox(site, activity) {
  const { selfId } = deps;
  const type = Array.isArray(activity.type) ? activity.type[0] : activity.type;
  if (!['Offer', 'Accept', 'Reject'].includes(type)) return false;
  const me = selfId(site.slug);
  const actor = idOf(activity.actor);

  if (type === 'Offer') {
    const rel = parseRelationship(activity.object);
    if (!rel || rel.ward !== me) return false;
    // A remote candidate offers to guard the local ward: park it in the queue.
    relations.recordOffer(site.slug, 'ward', rel.candidate, { handle: deps.deriveHandle(rel.candidate), offerId: idOf(activity) });
    notify(site.slug, { kind: 'offer_received', candidate: rel.candidate });
    return true;
  }

  // Accept / Reject of an offer WE (local guardian) sent.
  const obj = activity.object;
  const offerId = idOf(obj);
  const rel = parseRelationship(obj && obj.object) || parseRelationship(obj);
  let row = null;
  if (offerId) row = relations.findByOfferId(offerId).find((r) => r.slug === site.slug && r.role === 'guardian') || null;
  if (!row && actor) row = relations.getRelation(site.slug, 'guardian', actor) || null;
  if (!row && rel) row = relations.getRelation(site.slug, 'guardian', rel.ward) || null;
  if (!row) return false;

  if (type === 'Accept') {
    relations.acceptRelation(site.slug, 'guardian', row.other_uri);
    notify(site.slug, { kind: 'ward_accepted', ward: row.other_uri });
  } else {
    relations.removeRelation(site.slug, 'guardian', row.other_uri);
    notify(site.slug, { kind: 'ward_rejected', ward: row.other_uri });
  }
  return true;
}

function notify(slug, ev) {
  try { if (deps && typeof deps.onEvent === 'function') deps.onEvent(slug, ev); } catch { /* best-effort */ }
}

export default { wireHandshake, handleOutbox, handleInbox, parseRelationship };
