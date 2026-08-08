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

/**
 * May EXTERNAL (non-fediverse) embeds be shown to this account?
 *
 * A gated feature in the FEP-633c sense: a ward's world outside the fediverse
 * is the guardians' call. `setting` is `sites.external_embeds`:
 *   null/undefined → auto: off for a ward, on for anyone else
 *   0 → off, 1 → on (the guardians decided)
 *
 * Pure, so the rule is testable on its own. The gate is applied SERVER-side:
 * a blocked embed is never serialised into the feed, because an embed that the
 * client merely hides has still been delivered.
 */
export function externalEmbedsAllowed(setting, isWard) {
  if (setting === 0 || setting === 1) return setting === 1;
  return !isWard;
}

/**
 * May a player run INSIDE the app/page for this account? The heavier sibling
 * of the setting above, and deliberately separate: seeing that a video exists
 * is not the same decision as handing the screen to a third party's player,
 * with its engine, its end-screen and its next-video machine. Same shape, same
 * default (off for a ward), and it only ever matters once embeds are allowed:
 * you cannot play what you may not see.
 */
export function externalPlaybackAllowed(setting, isWard) {
  if (setting === 0 || setting === 1) return setting === 1;
  return !isWard;
}

/**
 * Dezelfde regel voor de hele gate-familie (8-8, "maak ze allemaal
 * functioneel"): een expliciete 0/1 van de guardians wint, anders de
 * automatiek -- dicht voor een ward, open voor de rest. EEN implementatie,
 * zodat er geen tweede plek is die er anders over kan gaan denken; de twee
 * benoemde varianten hierboven blijven bestaan omdat er tests en aanroepen
 * aan hangen, en doen exact hetzelfde.
 */
export function wardGateAllowed(setting, isWard) {
  if (setting === 0 || setting === 1) return setting === 1;
  return !isWard;
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

/** shaer:away (3.6.1): a guardian declaring itself away to its ward, with an
 *  end. Rides a direct note like the help request, so a ward on a plain
 *  server reads a human message; endTime is plain AS2. */
export function awayProps(post) {
  return (post && post.visibility === 'direct' && post.away_until)
    ? { 'shaer:away': true, endTime: new Date(post.away_until).toISOString() }
    : {};
}

export default { helpRequestProps, isHelpRequest, waveProps, isWave, awayProps, hasGuardiansProps, objectHasGuardians, externalEmbedsAllowed, externalPlaybackAllowed };
