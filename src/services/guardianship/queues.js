/**
 * Guardianship (FEP-633c) — the owner-only dashboard queues.
 *
 * Three OrderedCollections on the actor (shaer:queues), same contract as the
 * Shaer test daemon so the iOS/Android guardian dashboards read them as-is:
 *  - offers:  pending guardianship offers where I am a party (§3)
 *  - follows: pending follows for my wards (§5.3) — Klonkt has no gated
 *             follows yet, so this collection is empty for now
 *  - wards:   my wards, for the dashboard's wards list
 */
import { GUARDIAN_RELATIONSHIP_COMPACT } from './context.js';
import * as relations from './relations.js';

const collection = (id, items) => ({
  id, type: 'OrderedCollection', totalItems: items.length, orderedItems: items,
});

/** Pending offers, reconstructed as Offer activities (either side). Each item
 *  also carries the daemon-contract helper fields (shaer:ward, candidate,
 *  needsMyAccept, iAmCandidate, …): the Shaer clients render their accept
 *  button from those, so the shapes must match the test daemon exactly. */
export function offersCollection(id, slug, me) {
  const items = relations.listOffers(slug).map((r) => {
    const ward = r.role === 'guardian' ? r.other_uri : me;
    const candidate = r.role === 'guardian' ? me : r.other_uri;
    return {
      id: r.offer_id || `${me}/offers/pending-${r.id}`,
      type: 'Offer',
      actor: candidate,
      object: {
        type: 'Relationship',
        subject: ward,
        relationship: GUARDIAN_RELATIONSHIP_COMPACT,
        object: candidate,
      },
      'shaer:ward': ward,
      'shaer:candidate': candidate,
      'shaer:existingGuardians': relations.listGuardians(slug).map((g) => g.other_uri),
      'shaer:acceptedBy': [],
      // Klonkt's flow is single-phase: the ward's Accept commits at once, so
      // only the ward-side owner has an action here.
      'shaer:needsMyAccept': r.role === 'ward',
      'shaer:readyToCommit': false,
      'shaer:iAmCandidate': r.role === 'guardian',
      'shaer:handle': r.other_handle || undefined,
      published: r.created_at,
    };
  });
  return collection(id, items);
}

/** Gated follows awaiting guardian approval — not built in Klonkt yet. */
export function followsCollection(id) {
  return collection(id, []);
}

/** The guardian's wards (accepted), with cached handle for display. */
export function wardsCollection(id, slug) {
  const items = relations.listWards(slug)
    .filter((r) => r.status === 'accepted')
    .map((r) => ({ id: r.other_uri, 'shaer:handle': r.other_handle || undefined, since: r.created_at }));
  return collection(id, items);
}

export default { offersCollection, followsCollection, wardsCollection };
