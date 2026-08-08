/**
 * Guardianship (FEP-633c) — the owner-only dashboard queues.
 *
 * Three OrderedCollections on the actor (shaer:queues), same contract as the
 * Shaer test daemon so the iOS/Android dashboards read them as-is:
 *  - offers:  pending handshake offers where I am a party (§3), with the full
 *             accept tally so the client shows the right action
 *  - follows: pending gated follows ON my wards (§5.3), Fase 2 (shaer-jdb)
 *  - wards:   my committed wards
 */
import * as offers from './offers.js';
import * as relations from './relations.js';
import * as availability from './availability.js';
import * as outgoing from './outgoing.js';
import * as follows from './follows.js';
import * as gated from './gated.js';
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

/**
 * Gate-verzoeken OP mijn wards die op mijn antwoord wachten (Guardianship Fase 2,
 * shaer-jdb). Dit was een lege stub: de gating zelf werkt sinds shaer-hxg, maar
 * werd nooit aan een C2S-client doorgegeven omdat de koers toen op de PWA lag.
 *
 * Twee bronnen, want een guardian kan wards op andere servers hebben en (nog)
 * op deze:
 *   - ap_follow_reviews: de doorgestuurde kopie van een REMOTE ward
 *   - ap_pending_follows: een ward op deze instance
 * Zie shaer-h6u: die tweede hoort op termijn ook over de lijn te gaan.
 */
export function followsCollection(id, slug, me) {
  const items = follows.listReviewsByDirection(slug, 'incoming')
    .map((r) => follows.reviewQueueItem(r, me));
  for (const w of relations.listWards(slug)) {
    const wardSlug = slugOf(w.other_uri);
    if (!wardSlug) continue;
    for (const p of follows.listForWard(wardSlug)) {
      items.push({
        id: p.id, type: 'Follow', actor: p.follower_uri, object: w.other_uri,
        'shaer:direction': 'incoming', 'shaer:ward': w.other_uri,
        'shaer:follower': p.follower_uri, 'shaer:followerHandle': p.follower_handle || undefined,
        'shaer:quorum': p.quorum || 'any', published: p.created_at,
      });
    }
  }
  return collection(id, items);
}

/** De slug van een actor-uri op DEZE instance, of null als hij elders woont. */
function slugOf(uri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !String(uri || '').startsWith(`${base}/ap/users/`)) return null;
  return decodeURIComponent(String(uri).slice(`${base}/ap/users/`.length).split(/[/?#]/)[0]) || null;
}

/**
 * §5.3 uitgaand. Twee lezers, een wachtrij, en dat kan omdat §1 een ward en een
 * guardian wederzijds uitsluit: je bent het een of het ander.
 *
 *   ALS WARD      wat IK wil volgen en waar mijn guardians nog over moeten
 *   ALS GUARDIAN  wat mijn WARDS willen volgen en waar IK over moet (shaer-jdb)
 *
 * Dat tweede ontbrak. De wachtrij serveerde alleen listForWard(slug), en voor
 * een guardian is dat per definitie leeg -- dus het scherm "Your wards want to
 * follow" kon nooit iets tonen.
 */
export function outgoingFollowsCollection(id, slug, me) {
  const items = outgoing.listForWard(slug).map((o) => outgoing.queueItem(o, me));
  for (const r of follows.listReviewsByDirection(slug, 'outgoing')) {
    items.push(follows.reviewQueueItem(r, me));
  }
  return collection(id, items);
}

/** The guardian's committed wards, with cached handle for display. */
export function wardsCollection(id, slug) {
  const items = relations.listWards(slug)
    .map((r) => ({
      id: r.other_uri,
      'shaer:handle': r.other_handle || undefined,
      since: r.created_at,
      // Alles wat voor dit kind gated is, met soort, drempel en lopend voorstel
      // (shaer-ahy.1). Zonder dit kon een app wel een ward TONEN maar niets over
      // hem zeggen -- en dat is precies de helft van het antwoord op "wat mag
      // dit kind". Dezelfde rijen als het PWA-paneel, uit dezelfde functie.
      'shaer:gates': wardGates(slug, r.other_uri),
    }));
  return collection(id, items);
}

/** The ward's guardians with their availability (§3.6.1: never public,
 *  owner-only): the real size of the safety net. Same shape as the daemon. */
export function guardiansCollection(id, slug) {
  const uris = relations.listGuardians(slug).map((r) => r.other_uri);
  return collection(id, availability.statusesFor(slug, uris, Date.now()));
}

export default { offersCollection, followsCollection, outgoingFollowsCollection, wardsCollection, guardiansCollection, wardGates, wardGuardianStatuses };

// ── Wat er voor een ward gated is (shaer-ahy.1) ─────────────────────────
//
// STOND IN routes/guardian.js, en daar kon alleen de PWA erbij. De Shaer-apps
// lezen dezelfde toestand via de wards-queue, en een tweede berekening naast
// deze zou vroeg of laat een ander antwoord geven op dezelfde vraag -- dat is
// hier geen schoonheidsfoutje maar twee guardians die een verschillend beeld
// van hetzelfde kind krijgen. Een plek dus, en beide schermen lezen eruit.
/** The guardians of a ward WE host, with availability (3.6.1: owner-only in
 *  spirit; the co-guardians are among the owners of the relationship). Null
 *  for a remote ward: its server tracks availability, not us. */
export function wardGuardianStatuses(wardUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !String(wardUri || '').startsWith(`${base}/`)) return null;
  const slug = String(wardUri).trim().replace(/\/+$/, '').split('/').pop();
  try {
    const uris = relations.listGuardians(slug).map((g) => ({ uri: g.other_uri, handle: g.other_handle }));
    const st = Object.fromEntries(
      availability.statusesFor(slug, uris.map((u) => u.uri), Date.now()).map((s) => [s.id, s]),
    );
    return uris.map((u) => ({
      uri: u.uri,
      handle: u.handle,
      availability: (st[u.uri] || {})['shaer:availability'] || 'active',
      awayUntil: (st[u.uri] || {})['shaer:awayUntil'] || null,
      lapse: (st[u.uri] || {})['shaer:lapse'] || null,
    }));
  } catch { return null; }
}
/**
 * De gate-rijen van een ward voor het paneel.
 *
 * De standen komen uit onze eigen kolommen als we het kind hosten; bij een ward
 * elders weten we ze niet en blijft het NULL -- onbekend, niet uit. Het aantal
 * guardians idem: dat wordt op de server van die ward bijgehouden, en zonder dat
 * getal wordt er geen drempel verzonnen.
 */
export function wardGates(mySlug, wardUri) {
  const statuses = wardGuardianStatuses(wardUri);
  const wachtend = follows.listReviewsByDirection(mySlug, 'incoming')
    .filter((r) => r.ward_uri === wardUri).length;
  return gated.gateRows({
    // Uit de BESLUITEN, niet uit onze eigen kolom. Er zijn geen lokale accounts:
    // elke ward woont elders, dus wardEmbedSetting() gaf voor iedere ward null en
    // stond er in het paneel overal "onbekend". Wat een guardian wel heeft is de
    // uitslag van wat hij voorstelde.
    settings: Object.fromEntries(gated.GATE_CATALOGUE
      .filter((g) => g.available !== false && gated.featureColumn(g.feature))
      .map((g) => [g.feature, gated.knownSetting(mySlug, wardUri, g.feature)])),
    guardianCount: statuses ? statuses.length : null,
    proposals: gated.listSent(mySlug, wardUri).map((p) => ({
      feature: p.feature, value: !!p.value, status: gated.sentStatus(p, Date.now()),
    })),
    waiting: { 'shaer:follows': wachtend || undefined },
  });
}
