/**
 * Guardianship (FEP-633c) — the owner-only dashboard queues.
 *
 * Three OrderedCollections on the actor (shaer:queues), same contract as the
 * Shaer test daemon so the iOS/Android dashboards read them as-is:
 *  - offers:  pending handshake offers where I am a party (§3), with the full
 *             accept tally so the client shows the right action
 *  - follows: pending gated follows for my wards (§5.3) — Fase 2, empty for now
 *  - wards:   my committed wards
 */
import * as offers from './offers.js';
import * as relations from './relations.js';

const collection = (id, items) => ({
  id, type: 'OrderedCollection', totalItems: items.length, orderedItems: items,
});

/** Pending offers where the local site is a party, each with its accept tally. */
export function offersCollection(id, slug, me) {
  const items = offers.listForParty(slug, me).map((o) => offers.queueItem(o, me));
  return collection(id, items);
}

/** Gated follows awaiting guardian approval — not built in Klonkt yet (Fase 2). */
export function followsCollection(id) {
  return collection(id, []);
}

/** The guardian's committed wards, with cached handle for display. */
export function wardsCollection(id, slug) {
  const items = relations.listWards(slug)
    .map((r) => ({ id: r.other_uri, 'shaer:handle': r.other_handle || undefined, since: r.created_at }));
  return collection(id, items);
}

export default { offersCollection, followsCollection, wardsCollection };
