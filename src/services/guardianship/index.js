/**
 * Guardianship (FEP-633c "Guardians") — the module.
 *
 * Klonkt's kid-safety feature as one cohesive unit:
 *  - context.js:   the shaer JSON-LD namespace + Relationship vocabulary
 *  - relations.js: ward ↔ guardian relations (ap_guardianships) + actor props
 *  - handshake.js: the adoption Offer/Accept/Reject over C2S and S2S
 *  - queues.js:    the owner-only dashboard collections (offers/follows/wards)
 *  - notes.js:     the shaer:helpRequest flag on direct notes
 *  - delivery.js:  the direct-note leg a ward's call-for-help rides
 *
 * The shared blocklist (Shaer's "in Orbit") intentionally lives NEXT TO this
 * module in BlocklistService: Klonkt's own Block tab uses it too.
 *
 * ActivityPubService wires the AP helpers in once (wireDelivery/wireHandshake)
 * and delegates; nothing here imports ActivityPubService back.
 */
export { SHAER_CONTEXT, GUARDIAN_RELATIONSHIP, GUARDIAN_RELATIONSHIP_COMPACT, isGuardianRelationship } from './context.js';
export { helpRequestProps, isHelpRequest } from './notes.js';
export { wireDelivery, c2sVisibility, deliverDirectNote } from './delivery.js';
export { wireHandshake, handleOutbox as handleGuardianshipOutbox, handleInbox as handleGuardianshipInbox, parseRelationship } from './handshake.js';
export { offersCollection, followsCollection, wardsCollection } from './queues.js';
export {
  listGuardians, listWards, listOffers, isGuardian, getRelation, findByOfferId,
  recordOffer, acceptRelation, removeRelation, actorProps as guardianshipActorProps,
} from './relations.js';
