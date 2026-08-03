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
import * as availability from './availability.js';
import * as handshake from './handshake.js';

const collection = (id, items) => ({
  id, type: 'OrderedCollection', totalItems: items.length, orderedItems: items,
});

/** Pending offers where the local site is a party, each with its accept
 *  tally. The same collection carries the running lapses (§3.6.3) this
 *  account is a party to, exactly as the daemon serves them, so the Shaer
 *  clients render both without a second fetch. */
export function offersCollection(id, slug, me) {
  // §4.2: a handshake whose candidate could not be dereferenced is deferred,
  // not decided, and the last Accept may already have landed — so nothing else
  // would ever retry it. This poll is the schedule. Not awaited: the read
  // answers with what is true now, and a retry that succeeds surfaces in the
  // next one. `listForParty` settles closed windows on the way past.
  handshake.retryDeferred(slug).catch(() => { /* the next read tries again */ });
  const items = offers.listForParty(slug, me).map((o) => offers.queueItem(o, me));
  items.push(...availability.lapseQueueItems(slug, me, Date.now()));
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

/** The ward's guardians with their availability (§3.6.1: never public,
 *  owner-only): the real size of the safety net. Same shape as the daemon. */
export function guardiansCollection(id, slug) {
  const uris = relations.listGuardians(slug).map((r) => r.other_uri);
  return collection(id, availability.statusesFor(slug, uris, Date.now()));
}

export default { offersCollection, followsCollection, wardsCollection, guardiansCollection };
