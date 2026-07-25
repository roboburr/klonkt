/**
 * Guardianship (FEP-633c) — note properties.
 *
 * The shaer:helpRequest flag (spec 5.2.1): a ward's call for help, only ever
 * on direct notes. Everyone who does not speak shaer can ignore it.
 */
import { listGuardians } from './relations.js';

/**
 * shaer:hasGuardians (§2.2): an advisory OBJECT hint that the author is a ward,
 * so a remote server can route interactions to the guardians WITHOUT fetching
 * the actor. Stamped on every object a ward publishes; MUST be safely ignorable.
 */
export function hasGuardiansProps(slug) {
  try { return (slug && listGuardians(slug).length) ? { 'shaer:hasGuardians': true } : {}; }
  catch { return {}; }
}

/** True when an incoming object carries the ward hint (§2.2). Register-only for
 *  now; acted on later at reddings-boei / escalation routing. */
export function objectHasGuardians(o) {
  return !!o && (o['shaer:hasGuardians'] === true || o.hasGuardians === true);
}

/** Extra JSON-LD properties for an outgoing note built from an ap_outbox row. */
export function helpRequestProps(post) {
  return (post && post.visibility === 'direct' && post.help_request)
    ? { 'shaer:helpRequest': true }
    : {};
}

/** True when an incoming (C2S or S2S) note object carries the flag. */
export function isHelpRequest(object) {
  return !!object && (object['shaer:helpRequest'] === true || object.helpRequest === true);
}

/** shaer:wave: a gentle "thinking of you" from a guardian to its ward. A
 *  private nudge, never a feed post; non-shaer clients see a plain DM. */
export function waveProps(post) {
  return (post && post.visibility === 'direct' && post.wave)
    ? { 'shaer:wave': true }
    : {};
}

/** True when an incoming note is a wave. */
export function isWave(object) {
  return !!object && (object['shaer:wave'] === true || object.wave === true);
}

export default { helpRequestProps, isHelpRequest, waveProps, isWave, hasGuardiansProps, objectHasGuardians };
