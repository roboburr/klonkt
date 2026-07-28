/**
 * Guardian availability (FEP-633c §3.6): away, dormant, and the lapse.
 *
 * The port of the Shaer test daemon's availability.rs, validated there first
 * (shaer-8z7): same states, same rules, same refusals. Guardianship demands
 * attention; `shaer:guardians` is a public claim about safety, and a guardian
 * who no longer answers makes it untrue. It also quietly breaks the §3.5
 * arithmetic: a majority of a set with absent members can be unreachable.
 *
 * Three states per (ward, guardian), and one rule above everything else:
 * ONE ANSWER RESTORES EVERYTHING, at any moment up to and including a
 * running lapse. Neither away nor dormant is misconduct; neither leaves a
 * mark.
 *
 * Time is always a parameter here, never read from a clock inside the rules,
 * so a fourteen-day window is a number in a test and not a wait.
 */
import db from '../../config/database.js';
import { listGuardians, removeRelation } from './relations.js';

/** Deployment numbers (§3.6.2 keeps them out of the spec on purpose: any
 *  number written there would punish exactly the long-term ill). Matched to
 *  the daemon's defaults so the two backends behave the same under test. */
export const POLICY = {
  requestTtlMs: 7 * 24 * 3600 * 1000,   // how long a request may sit unanswered
  missesForDormant: 3,                   // how many missed requests make dormant
};

/** The lapse window. Irreversible per §3.5, so it always runs in full. */
export const LAPSE_WINDOW_MS = 14 * 24 * 3600 * 1000;

/** Marker detection: the away declaration rides a direct note (§2.4). */
export function isAway(object) {
  return !!object && (object['shaer:away'] === true || object.away === true);
}

/** AS2 endTime → epoch ms. A number passes through; a string goes through
 *  Date.parse (which reads ISO 8601, offsets included). null when absent or
 *  unreadable: an absence without an end is refused, never guessed. */
export function parseEndTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// ── Attention (the per-guardian state) ─────────────────────────────────────

function attentionRow(wardSlug, guardianUri) {
  return db.prepare('SELECT * FROM ap_guardian_attention WHERE ward_slug = ? AND guardian_uri = ?')
    .get(wardSlug, guardianUri) || { ward_slug: wardSlug, guardian_uri: guardianUri, state: 'active', away_until: null };
}

/** What the stored state means at `now`: an away past its end is simply
 *  active again, silently (§3.6.1). */
export function effective(wardSlug, guardianUri, now) {
  const row = attentionRow(wardSlug, guardianUri);
  if (row.state === 'away') return (row.away_until && now < row.away_until) ? 'away' : 'active';
  return row.state;
}

/** The away end, when there is a running one (for display). */
export function awayUntil(wardSlug, guardianUri, now) {
  const row = attentionRow(wardSlug, guardianUri);
  return (row.state === 'away' && row.away_until && now < row.away_until) ? row.away_until : null;
}

/** Declare absence with an end (§3.6.1). The declaration is itself an
 *  answer, so it first restores: declaring away while dormant clears the
 *  dormancy, without a mark. Declaring away is the responsible act. */
export function declareAway(wardSlug, guardianUri, untilMs) {
  db.prepare('DELETE FROM ap_attention_requests WHERE ward_slug = ? AND guardian_uri = ?').run(wardSlug, guardianUri);
  db.prepare(`INSERT INTO ap_guardian_attention (ward_slug, guardian_uri, state, away_until)
              VALUES (?,?, 'away', ?)
              ON CONFLICT(ward_slug, guardian_uri) DO UPDATE SET state = 'away', away_until = excluded.away_until`)
    .run(wardSlug, guardianUri, untilMs);
}

/** A directly addressed request went out to this guardian (a §3.5 decision
 *  naming them, or an explicit check-in). Requests during a declared absence
 *  are not recorded: away MUST NOT count as evidence (§3.6.1). */
export function recordRequest(wardSlug, guardianUri, requestId, now) {
  if (effective(wardSlug, guardianUri, now) === 'away') return;
  db.prepare(`INSERT OR IGNORE INTO ap_attention_requests (ward_slug, guardian_uri, request_id, asked_at)
              VALUES (?,?,?,?)`).run(wardSlug, guardianUri, requestId, now);
}

/** Missed requests: unanswered ones older than the policy TTL. */
export function misses(wardSlug, guardianUri, now) {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ap_attention_requests
                        WHERE ward_slug = ? AND guardian_uri = ? AND asked_at <= ?`)
    .get(wardSlug, guardianUri, now - POLICY.requestTtlMs);
  return r ? r.n : 0;
}

/** Promote to dormant when the evidence says so. Returns true only on the
 *  transition itself: THAT is the moment the notification duty of §3.6.2
 *  fires (protocol AND the §6 handle), and it is the caller's job — wired
 *  through onDormant below so every call site notifies the same way. */
export function observe(wardSlug, guardianUri, now) {
  if (effective(wardSlug, guardianUri, now) !== 'active') return false;
  if (misses(wardSlug, guardianUri, now) < POLICY.missesForDormant) return false;
  db.prepare(`INSERT INTO ap_guardian_attention (ward_slug, guardian_uri, state, away_until)
              VALUES (?,?, 'dormant', NULL)
              ON CONFLICT(ward_slug, guardian_uri) DO UPDATE SET state = 'dormant', away_until = NULL`)
    .run(wardSlug, guardianUri);
  notifyDormant(wardSlug, guardianUri);
  return true;
}

/** The notification duty of §3.6.2, wired once (ActivityPubService). The
 *  one-answer rule is worthless to someone who does not know an answer is
 *  wanted; the §6 handle exists for precisely this moment. */
let _onDormant = null;
export function wireAvailability({ onDormant } = {}) { _onDormant = onDormant || null; }
function notifyDormant(wardSlug, guardianUri) {
  try { if (_onDormant) _onDormant(wardSlug, guardianUri); } catch { /* best-effort */ }
}

/**
 * One answer restores everything (§3.6). Any activity from an actor that
 * guards someone on this server restores it to active for those wards and
 * cancels any lapse running against it, up to the last moment of the window.
 * Returns what changed, so a caller can log or announce it.
 */
export function oneAnswer(guardianUri, now) {
  if (!guardianUri) return { restored: [], cancelledLapses: [] };
  const restored = [];
  for (const row of db.prepare(`SELECT ward_slug, state FROM ap_guardian_attention WHERE guardian_uri = ?`).all(guardianUri)) {
    if (row.state !== 'active') restored.push(row.ward_slug);
  }
  const hadRequests = db.prepare('SELECT DISTINCT ward_slug FROM ap_attention_requests WHERE guardian_uri = ?').all(guardianUri);
  for (const r of hadRequests) if (!restored.includes(r.ward_slug)) restored.push(r.ward_slug);
  db.prepare("UPDATE ap_guardian_attention SET state = 'active', away_until = NULL WHERE guardian_uri = ?").run(guardianUri);
  db.prepare('DELETE FROM ap_attention_requests WHERE guardian_uri = ?').run(guardianUri);

  const cancelledLapses = [];
  for (const l of db.prepare('SELECT * FROM ap_lapses WHERE target_uri = ? AND cancelled = 0 AND applied = 0').all(guardianUri)) {
    if (lapseOutcome(l, now) === 'open') {
      db.prepare('UPDATE ap_lapses SET cancelled = 1 WHERE id = ?').run(l.id);
      cancelledLapses.push({ id: l.id, wardSlug: l.ward_slug, wardUri: l.ward_uri, set: JSON.parse(l.set_json) });
    }
  }
  return { restored, cancelledLapses };
}

/** The available set of §3.5: the guardians minus away and dormant members.
 *  Observation (and thus the dormancy promotion) happens here, so reading the
 *  set is what moves the clock's consequences. */
export function availableSet(wardSlug, guardianUris, now) {
  return guardianUris.filter((g) => {
    observe(wardSlug, g, now);
    return effective(wardSlug, g, now) === 'active';
  });
}

/** The guardians queue items (§3.6.1: never public, owner-only): the real
 *  size of the ward's safety net. Same shape the daemon serves. */
export function statusesFor(wardSlug, guardianUris, now) {
  return guardianUris.map((g) => {
    observe(wardSlug, g, now);
    const running = db.prepare(`SELECT id FROM ap_lapses WHERE ward_slug = ? AND target_uri = ? AND cancelled = 0 AND applied = 0`)
      .get(wardSlug, g);
    return {
      id: g,
      'shaer:availability': effective(wardSlug, g, now),
      'shaer:awayUntil': awayUntil(wardSlug, g, now),
      'shaer:lapse': running && lapseOutcome(db.prepare('SELECT * FROM ap_lapses WHERE id = ?').get(running.id), now) === 'open' ? running.id : null,
    };
  });
}

// ── The lapse (§3.6.3): release in absentia ────────────────────────────────

/** Read a shaer:Lapse object, or null when this is a different Offer. */
export function parseLapse(object) {
  if (!object || typeof object !== 'object') return null;
  const type = Array.isArray(object.type) ? object.type[0] : object.type;
  if (type !== 'shaer:Lapse' && type !== 'Lapse') return null;
  const ward = object['shaer:ward'] || object.ward;
  const target = typeof object.object === 'string' ? object.object : (object.object && object.object.id);
  return (typeof ward === 'string' && typeof target === 'string') ? { ward, target } : null;
}

/** Strict majority of the set (§3.5 default). */
export function lapseThreshold(setSize) { return Math.floor(setSize / 2) + 1; }

/** Pure outcome: cancelled beats everything; the window always runs in full
 *  (§3.5, irreversible), then a strict majority completes, else it fails
 *  closed. */
export function lapseOutcome(row, now) {
  if (!row) return null;
  if (row.cancelled) return 'cancelled';
  if (now - row.opened_at < row.window_ms) return 'open';
  const accepts = JSON.parse(row.accepts_json).length;
  return accepts >= lapseThreshold(JSON.parse(row.set_json).length) ? 'completed' : 'failed';
}

/**
 * Open a lapse on this server (we host the ward). Refusals mirror the
 * daemon's, status for status:
 *  - not_a_guardian: the target does not guard this ward
 *  - would_emancipate: removing the last guardian is §3.4, never a lapse
 *  - not_dormant: a lapse opens only against a guardian already dormant
 *  - not_in_available_set: only an available co-guardian proposes
 */
export function openLapse({ id, wardSlug, wardUri, target, openedBy, now, windowMs = LAPSE_WINDOW_MS }) {
  const guardians = listGuardians(wardSlug).map((g) => g.other_uri);
  if (!guardians.includes(target)) return { error: 'not_a_guardian' };
  if (guardians.length <= 1) return { error: 'would_emancipate' };
  observe(wardSlug, target, now);
  if (effective(wardSlug, target, now) !== 'dormant') return { error: 'not_dormant' };
  const set = availableSet(wardSlug, guardians, now).filter((g) => g !== target);
  if (!set.includes(openedBy)) return { error: 'not_in_available_set' };
  // The proposal carries the proposer's own accept (§3.1's one-step clause,
  // exactly as §5.6 applies it).
  db.prepare(`INSERT INTO ap_lapses (id, ward_slug, ward_uri, target_uri, opened_by, set_json, accepts_json, opened_at, window_ms)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, wardSlug, wardUri, target, openedBy, JSON.stringify(set), JSON.stringify([openedBy]), now, windowMs);
  return { lapse: db.prepare('SELECT * FROM ap_lapses WHERE id = ?').get(id), set, threshold: lapseThreshold(set.length) };
}

/** Record a vote from a set member. Answers from outside the snapshot are
 *  refused, not counted: a stranger cannot make up the majority. */
export function lapseVote(id, actor, accept, now) {
  const row = db.prepare('SELECT * FROM ap_lapses WHERE id = ?').get(id);
  if (!row) return null;
  const outcome = lapseOutcome(row, now);
  if (outcome !== 'open') return { error: outcome === 'cancelled' ? 'cancelled' : 'closed' };
  const set = JSON.parse(row.set_json);
  if (!set.includes(actor)) return { error: 'not_in_set' };
  const accepts = new Set(JSON.parse(row.accepts_json));
  const rejects = new Set(JSON.parse(row.rejects_json));
  if (accept) { rejects.delete(actor); accepts.add(actor); }
  else { accepts.delete(actor); rejects.add(actor); }
  db.prepare('UPDATE ap_lapses SET accepts_json = ?, rejects_json = ? WHERE id = ?')
    .run(JSON.stringify([...accepts]), JSON.stringify([...rejects]), id);
  return { outcome: 'open', accepts: accepts.size, threshold: lapseThreshold(set.length) };
}

/**
 * Evaluate a lapse at `now`, executing the removal exactly once when the
 * window has closed with a majority. The refusal to empty shaer:guardians
 * stands as a second lock under this one: even a completed lapse must not
 * take the last guardian (that is emancipation, §3.4).
 */
export function settleLapse(id, now) {
  const row = db.prepare('SELECT * FROM ap_lapses WHERE id = ?').get(id);
  if (!row) return null;
  const outcome = lapseOutcome(row, now);
  if (outcome !== 'completed' || row.applied) return { outcome, applied: !!row.applied, row };
  if (listGuardians(row.ward_slug).length <= 1) {
    return { outcome, applied: false, refused: 'would_emancipate', row };
  }
  removeRelation(row.ward_slug, 'ward', row.target_uri);
  db.prepare('UPDATE ap_lapses SET applied = 1 WHERE id = ?').run(id);
  return { outcome, applied: true, row };
}

/** The offers-queue items for running lapses this account is a party to:
 *  the ward itself, or a co-located guardian in the set. Same shape as the
 *  daemon's, so the Shaer clients render them as-is. */
export function lapseQueueItems(slug, me, now) {
  const items = [];
  for (const row of db.prepare('SELECT * FROM ap_lapses WHERE applied = 0 AND cancelled = 0').all()) {
    settleLapse(row.id, now);   // reads are where lazy completion happens
    if (lapseOutcome(row, now) !== 'open') continue;
    const set = JSON.parse(row.set_json);
    if (row.ward_slug !== slug && !set.includes(me)) continue;
    const accepts = JSON.parse(row.accepts_json);
    const rejects = JSON.parse(row.rejects_json);
    items.push({
      id: row.id,
      type: 'Offer',
      actor: row.opened_by,
      object: { type: 'shaer:Lapse', 'shaer:ward': row.ward_uri, object: row.target_uri },
      'shaer:set': set,
      'shaer:accepts': accepts.length,
      'shaer:threshold': lapseThreshold(set.length),
      'shaer:myVote': accepts.includes(me) || rejects.includes(me),
      'shaer:outcome': 'open',
      'shaer:closesAt': row.opened_at + row.window_ms,
    });
  }
  return items;
}

export function getLapse(id) { return db.prepare('SELECT * FROM ap_lapses WHERE id = ?').get(id); }

export default {
  POLICY, LAPSE_WINDOW_MS, isAway, parseEndTime, effective, awayUntil, declareAway,
  recordRequest, misses, observe, oneAnswer, availableSet, statusesFor, wireAvailability,
  parseLapse, lapseThreshold, lapseOutcome, openLapse, lapseVote, settleLapse, lapseQueueItems, getLapse,
};
