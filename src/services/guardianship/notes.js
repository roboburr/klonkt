/**
 * Guardianship (FEP-633c) — note properties.
 *
 * The shaer:helpRequest flag (spec 5.2.1): a ward's call for help, only ever
 * on direct notes. Everyone who does not speak shaer can ignore it.
 */

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

export default { helpRequestProps, isHelpRequest, waveProps, isWave };
