/**
 * Guardianship (FEP-633c §5.3, the other direction) — gating a ward's OWN
 * follows. Bead shaer-p729; the design is in docs/ward-outbound-follows-design.md,
 * and the spec question it answers is shaer-yeo5.
 *
 * The inbound gate in `follows.js` decides who may follow a ward. This one
 * decides who a ward may follow. Until now that went out unchecked: the
 * guardians got a note afterwards (1a2f206), which is informing, not gating —
 * the door is already open by the time the message arrives.
 *
 * The rule (Barts besluit): every outgoing follow waits for a guardian, EXCEPT
 * where the target already follows the ward through the gate. A guardian
 * already said yes to that person; asking the same question twice only teaches
 * people to stop reading the question.
 */
import db from '../../config/database.js';
import { followThreshold } from './follows.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      ins: db.prepare(`INSERT OR IGNORE INTO ap_pending_outgoing_follows
        (id, ward_slug, target_uri, target_inbox, target_name, target_handle, target_icon, quorum, created_at)
        VALUES (?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`),
      get: db.prepare('SELECT * FROM ap_pending_outgoing_follows WHERE id = ?'),
      byTarget: db.prepare('SELECT * FROM ap_pending_outgoing_follows WHERE ward_slug = ? AND target_uri = ?'),
      byWard: db.prepare("SELECT * FROM ap_pending_outgoing_follows WHERE ward_slug = ? AND status = 'pending' ORDER BY created_at DESC"),
      approve: db.prepare('INSERT OR IGNORE INTO ap_outgoing_follow_approvals (follow_id, guardian_uri, decision, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)'),
      answers: db.prepare('SELECT guardian_uri, decision FROM ap_outgoing_follow_approvals WHERE follow_id = ?'),
      setStatus: db.prepare('UPDATE ap_pending_outgoing_follows SET status = ? WHERE id = ?'),
      del: db.prepare('DELETE FROM ap_pending_outgoing_follows WHERE id = ?'),
      delByTarget: db.prepare('DELETE FROM ap_pending_outgoing_follows WHERE ward_slug = ? AND target_uri = ?'),
      gateApproved: db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND actor_uri = ? AND gate_approved = 1'),
    };
  }
  return _s;
}

/**
 * Does this target already follow the ward, with a guardian's blessing?
 *
 * Only a gate-approved follower counts. A follower a free actor picked up
 * before it was ever a ward was never seen by a guardian, so following them
 * back is a new question, not a settled one. (Rows that predate the marker are
 * grandfathered at migration; see config/database.js.)
 */
export function isMutual(wardSlug, targetUri) {
  return !!stmts().gateApproved.get(wardSlug, targetUri);
}

/** Record an outgoing follow awaiting guardian approval. */
export function recordPending(wardSlug, f) {
  stmts().ins.run(
    f.id, wardSlug, f.target, f.inbox || null,
    f.name || null, f.handle || null, f.icon || null, f.quorum || 'any',
  );
  return stmts().byTarget.get(wardSlug, f.target);
}

export function getPending(id) { return stmts().get.get(id); }
export function findFor(wardSlug, targetUri) { return stmts().byTarget.get(wardSlug, targetUri); }

/** Outgoing follows this ward is waiting on — the guardian's queue. */
export function listForWard(wardSlug) { return stmts().byWard.all(wardSlug); }

/**
 * A guardian's answer. Same shape and the same quorum arithmetic as the
 * inbound gate, so the two directions cannot drift apart in how they count:
 * a single reject denies outright, approvals accumulate toward the quorum.
 */
export function decide(id, guardianUri, decision, guardiansOfWard) {
  const follow = stmts().get.get(id);
  if (!follow || follow.status !== 'pending') return { outcome: 'gone', follow };
  stmts().approve.run(id, guardianUri, decision === 'reject' ? 'reject' : 'approve');
  const rows = stmts().answers.all(id);
  if (rows.some((r) => r.decision === 'reject')) {
    stmts().setStatus.run('denied', id);
    return { outcome: 'rejected', follow };
  }
  const approvers = new Set(rows.filter((r) => r.decision === 'approve').map((r) => r.guardian_uri));
  const guardians = (guardiansOfWard || []).filter(Boolean);
  // Dezelfde eenvoudige meerderheid als bij een inkomend volgverzoek
  // (followThreshold): het is dezelfde vraag, alleen omgedraaid. Twee
  // verschillende drempels voor "mag dit kind met deze persoon te maken hebben"
  // zou een guardian nooit kunnen uitleggen.
  const enough = approvers.size >= followThreshold(guardians.length);
  if (enough) {
    stmts().setStatus.run('approved', id);
    return { outcome: 'approved', follow };
  }
  return { outcome: 'waiting', follow };
}

/** The ward changed its mind, or blocked the target: the request is gone. */
export function withdraw(wardSlug, targetUri) { stmts().delByTarget.run(wardSlug, targetUri); }
export function remove(id) { stmts().del.run(id); }

/** One request as the queue item the Shaer clients parse, mirroring the
 *  inbound gated-follow item so a dashboard can render both side by side. */
export function queueItem(o, me) {
  const rows = stmts().answers.all(o.id);
  return {
    id: o.id,
    type: 'Follow',
    actor: o.ward_slug,
    object: o.target_uri,
    'shaer:direction': 'outgoing',
    'shaer:target': o.target_uri,
    'shaer:targetHandle': o.target_handle || undefined,
    'shaer:quorum': o.quorum || 'any',
    'shaer:approvals': rows.filter((r) => r.decision === 'approve').length,
    'shaer:myVote': rows.some((r) => r.guardian_uri === me),
    published: o.created_at,
  };
}

export default {
  isMutual, recordPending, getPending, findFor, listForWard, decide, withdraw, remove, queueItem,
};
