/**
 * Guardianship (FEP-633c §5.3) — follow-gating for wards.
 *
 * A `Follow` targeting a ward is NOT auto-accepted. It is held pending and
 * routed to the ward's guardians, who approve or deny. A committed guardian's
 * own Follow is auto-accepted (it needs no gate). Quorum policy per ward:
 * 'any' (one guardian suffices, default), 'all', or 'none' (open).
 *
 * This module is the store + the decision; the AP plumbing (sending the
 * Accept, inserting the follower) stays in ActivityPubService.
 */
import db from '../../config/database.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      ins: db.prepare(`INSERT OR IGNORE INTO ap_pending_follows
        (id, ward_slug, follower_uri, follower_inbox, follower_shared_inbox, follower_name, follower_handle, follower_icon, activity_json, quorum, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`),
      get: db.prepare('SELECT * FROM ap_pending_follows WHERE id = ?'),
      byWard: db.prepare("SELECT * FROM ap_pending_follows WHERE ward_slug = ? AND status = 'pending' ORDER BY created_at DESC"),
      approvers: db.prepare('SELECT guardian_uri FROM ap_pending_follow_approvals WHERE follow_id = ?'),
      approve: db.prepare('INSERT OR IGNORE INTO ap_pending_follow_approvals (follow_id, guardian_uri, decision, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)'),
      setStatus: db.prepare('UPDATE ap_pending_follows SET status = ? WHERE id = ?'),
      del: db.prepare('DELETE FROM ap_pending_follows WHERE id = ?'),
    };
  }
  return _s;
}

/** Record a gated follow awaiting guardian approval. */
export function recordPending(wardSlug, f) {
  stmts().ins.run(
    f.id, wardSlug, f.follower, f.inbox, f.sharedInbox || null,
    f.name || null, f.handle || null, f.icon || null,
    JSON.stringify(f.activity || null), f.quorum || 'any',
  );
  return stmts().get.get(f.id);
}

export function getPending(id) { return stmts().get.get(id); }

/** Pending follows for a local ward (its guardians decide). */
export function listForWard(wardSlug) { return stmts().byWard.all(wardSlug); }

/**
 * Record a guardian's decision on a pending follow. Returns
 * { outcome: 'approved'|'rejected'|'waiting', follow } so the caller can
 * send the Accept/Reject. A single reject denies; approvals meet the quorum.
 */
export function decide(id, guardianUri, decision, guardiansOfWard) {
  const follow = stmts().get.get(id);
  if (!follow || follow.status !== 'pending') return { outcome: 'gone', follow };
  stmts().approve.run(id, guardianUri, decision === 'reject' ? 'reject' : 'approve');
  const rows = db.prepare('SELECT guardian_uri, decision FROM ap_pending_follow_approvals WHERE follow_id = ?').all(id);
  if (rows.some((r) => r.decision === 'reject')) {
    stmts().setStatus.run('denied', id);
    return { outcome: 'rejected', follow };
  }
  const approvers = new Set(rows.filter((r) => r.decision === 'approve').map((r) => r.guardian_uri));
  const guardians = (guardiansOfWard || []).filter(Boolean);
  const enough = follow.quorum === 'all'
    ? guardians.length > 0 && guardians.every((g) => approvers.has(g))
    : approvers.size >= 1;                                   // 'any' (default)
  if (enough) {
    stmts().setStatus.run('accepted', id);
    return { outcome: 'approved', follow };
  }
  return { outcome: 'waiting', follow };
}

export function remove(id) { stmts().del.run(id); }

// ── Guardian-side copy (cross-instance, modelled on the guardian offer): a
//    gated follow on a REMOTE ward this account guards, forwarded here as an
//    Offer(Follow). The decision is Accept/Reject sent back to ward_inbox. ──
let _r = null;
function rstmts() {
  if (!_r) {
    _r = {
      ins: db.prepare(`INSERT OR IGNORE INTO ap_follow_reviews
        (id, guardian_slug, ward_uri, ward_inbox, follower_uri, follower_handle, follower_icon, follow_json, created_at)
        VALUES (?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`),
      get: db.prepare('SELECT * FROM ap_follow_reviews WHERE guardian_slug = ? AND id = ?'),
      bySlug: db.prepare("SELECT * FROM ap_follow_reviews WHERE guardian_slug = ? AND status = 'pending' ORDER BY created_at DESC"),
      del: db.prepare('DELETE FROM ap_follow_reviews WHERE guardian_slug = ? AND id = ?'),
    };
  }
  return _r;
}

export function recordReview(guardianSlug, r) {
  rstmts().ins.run(r.id, guardianSlug, r.wardUri, r.wardInbox || null, r.follower, r.followerHandle || null, r.followerIcon || null, r.followJson || null);
  return rstmts().get.get(guardianSlug, r.id);
}
export function getReview(guardianSlug, id) { return rstmts().get.get(guardianSlug, id); }
export function listReviews(guardianSlug) { return rstmts().bySlug.all(guardianSlug); }
export function removeReview(guardianSlug, id) { rstmts().del.run(guardianSlug, id); }

export default {
  recordPending, getPending, listForWard, decide, remove,
  recordReview, getReview, listReviews, removeReview,
};
