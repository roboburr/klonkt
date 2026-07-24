/**
 * Guardianship (FEP-633c "Guardians") — the module.
 *
 * Klonkt's kid-safety feature as one cohesive unit:
 *  - context.js:   the shaer JSON-LD namespace + Relationship vocabulary
 *  - offers.js:    the multi-party handshake state (a port of the Shaer daemon)
 *  - relations.js: the COMMITTED ward ↔ guardian relations + actor props
 *  - handshake.js: the adoption Offer/Accept/Reject over C2S and S2S
 *  - queues.js:    the owner-only dashboard collections (offers/follows/wards)
 *  - notes.js:     the shaer:helpRequest flag on direct notes
 *  - delivery.js:  the direct-note leg a ward's call-for-help rides
 *
 * The shared blocklist (Shaer's "in Orbit") lives NEXT TO this module in
 * BlocklistService. ActivityPubService wires the AP helpers in once and
 * delegates; nothing here imports ActivityPubService back.
 */
export { SHAER_CONTEXT, GUARDIAN_RELATIONSHIP, GUARDIAN_RELATIONSHIP_COMPACT, isGuardianRelationship } from './context.js';
export { helpRequestProps, isHelpRequest } from './notes.js';
export { wireDelivery, c2sVisibility, deliverDirectNote } from './delivery.js';
export { wireHandshake, handleOutbox as handleGuardianshipOutbox, handleInbox as handleGuardianshipInbox, parseRelationship } from './handshake.js';
export { offersCollection, followsCollection, wardsCollection } from './queues.js';
export { listForParty as listOffersForParty, getOffer, findOfferAnywhere } from './offers.js';
export {
  listGuardians, listWards, isGuardian, getRelation, removeRelation,
  actorProps as guardianshipActorProps,
} from './relations.js';
