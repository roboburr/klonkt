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

/** Pending offers, reconstructed as Offer activities (either side). */
export function offersCollection(id, slug, me) {
  const items = relations.listOffers(slug).map((r) => ({
    id: r.offer_id || undefined,
    type: 'Offer',
    actor: r.role === 'guardian' ? me : r.other_uri,
    object: {
      type: 'Relationship',
      subject: r.role === 'guardian' ? r.other_uri : me,
      relationship: GUARDIAN_RELATIONSHIP_COMPACT,
      object: r.role === 'guardian' ? me : r.other_uri,
    },
    'shaer:handle': r.other_handle || undefined,
    published: r.created_at,
  }));
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
