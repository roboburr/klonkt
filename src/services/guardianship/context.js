/**
 * Guardianship (FEP-633c "Guardians") — JSON-LD vocabulary.
 *
 * One source of truth for the shaer namespace and the terms Klonkt emits.
 * ActivityPubService spreads SHAER_CONTEXT into its AP_CONTEXT term block, so
 * every outgoing document declares the namespace and strict JSON-LD
 * processors resolve the terms instead of dropping them.
 */

/** The term block merged into AP_CONTEXT. */
export const SHAER_CONTEXT = {
  // FEP-633c (Guardians): the shaer namespace. helpRequest marks a direct
  // note as a ward's call for help (spec 5.2.1); ignorable by everyone else.
  shaer: 'https://ns.klonkt.com/shaer#',
};

/** The Relationship value in the adoption Offer (FEP-633c §3), both forms. */
export const GUARDIAN_RELATIONSHIP = 'https://ns.klonkt.com/shaer#Guardian';
export const GUARDIAN_RELATIONSHIP_COMPACT = 'shaer:Guardian';

/** True when an Offer's relationship names the guardian relation. */
export function isGuardianRelationship(value) {
  return value === GUARDIAN_RELATIONSHIP || value === GUARDIAN_RELATIONSHIP_COMPACT;
}

export default { SHAER_CONTEXT, GUARDIAN_RELATIONSHIP, GUARDIAN_RELATIONSHIP_COMPACT, isGuardianRelationship };
