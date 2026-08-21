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
/**
 * Hoeveel guardians moeten ja zeggen voor een volgverzoek (Barts besluit, 8-8).
 *
 * EENVOUDIGE MEERDERHEID: 1 van 1, 1 van 2, 2 van 3, 2 van 4. Bart: "1/2 is
 * voldoende."
 *
 * BEWUST SOEPELER DAN DE POORTDREMPEL, en dat verschil hoort uitgelegd. Een gate
 * opent een deur voor alles wat daarna komt; die vraagt om een STRIKTE
 * meerderheid (thresholdFor in gated.js: 2 van 2, 3 van 4). Een volgverzoek gaat
 * over een persoon, is met ontvolgen terug te draaien, en stond hier tot vandaag
 * op 'any' -- een enkele ja, hoeveel guardians er ook waren. Dit is dus geen
 * versoepeling maar een AANSCHERPING voor iedereen met drie of meer guardians.
 *
 * De 'all'-stand die hier stond is weg. Hij werd nergens gezet -- elke schrijver
 * gaf 'any' mee -- dus het was een keuze die niemand kon maken en die alleen in
 * de weg stond bij het lezen van deze regel.
 */
export function followThreshold(setSize) {
  return Math.max(1, Math.ceil(setSize / 2));
}

/**
 * Een race naar de drempel, net als de poorttelling: zodra het aantal gehaald
 * is, is het besluit gevallen.
 *
 * TODO (shaer-8vt): wie antwoordt weet niet dat hij de doorslag geeft. Bij 1 van
 * 2 is de eerste ja meteen de beslissing, en het scherm zegt dat nergens. Dat is
 * hetzelfde gat als bij de gate-voorstellen en het hoort daar samen opgelost.
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
  const enough = approvers.size >= followThreshold(guardians.length);
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
        (id, guardian_slug, ward_uri, ward_inbox, follower_uri, follower_handle, follower_icon, follow_json,
         direction, target_uri, target_handle, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`),
      get: db.prepare('SELECT * FROM ap_follow_reviews WHERE guardian_slug = ? AND id = ?'),
      bySlug: db.prepare("SELECT * FROM ap_follow_reviews WHERE guardian_slug = ? AND status = 'pending' ORDER BY created_at DESC"),
      del: db.prepare('DELETE FROM ap_follow_reviews WHERE guardian_slug = ? AND id = ?'),
    };
  }
  return _r;
}

/**
 * De guardian-zijdige kopie van een gate-verzoek op een REMOTE ward.
 *
 * `direction` is niet cosmetisch (shaer-jdb). Bij een INKOMENDE is de follower
 * iemand anders en de ward het doel. Bij een UITGAANDE is de ward zelf de
 * follower en staat het doel in het Follow-object -- die werd hiervoor
 * opgeslagen als "deze ward wil deze ward volgen", met het doel weggegooid.
 */
export function recordReview(guardianSlug, r) {
  const richting = r.direction === 'outgoing' ? 'outgoing' : 'incoming';
  rstmts().ins.run(r.id, guardianSlug, r.wardUri, r.wardInbox || null, r.follower, r.followerHandle || null,
    r.followerIcon || null, r.followJson || null, richting, r.target || null, r.targetHandle || null);
  return rstmts().get.get(guardianSlug, r.id);
}

/**
 * Een openstaande review als wachtrij-item, in dezelfde vorm die de clients al
 * lezen (offers en outgoing-follows doen het net zo).
 */
export function reviewQueueItem(r, me, guardianCount) {
  // guardianCount blijft WEG als we hem niet kennen. Bij een remote ward wordt
  // de guardian-set op diens eigen server bijgehouden, en 0 sturen zou lezen als
  // "dit kind heeft geen guardians" -- het tegenovergestelde van onbekend.
  const stemmen = (() => {
    try { return db.prepare('SELECT guardian_uri, decision FROM ap_pending_follow_approvals WHERE follow_id = ?').all(r.id); }
    catch { return []; }
  })();
  const uitgaand = r.direction === 'outgoing';
  return {
    id: r.id,
    type: 'Follow',
    // Bij een uitgaande is de WARD de volger; bij een inkomende is dat de vreemde.
    actor: uitgaand ? r.ward_uri : r.follower_uri,
    object: uitgaand ? (r.target_uri || '') : r.ward_uri,
    'shaer:direction': uitgaand ? 'outgoing' : 'incoming',
    'shaer:ward': r.ward_uri,
    'shaer:target': uitgaand ? (r.target_uri || undefined) : undefined,
    'shaer:targetHandle': uitgaand ? (r.target_handle || undefined) : undefined,
    'shaer:follower': uitgaand ? undefined : r.follower_uri,
    'shaer:followerHandle': uitgaand ? undefined : (r.follower_handle || undefined),
    'shaer:quorum': 'all',
    'shaer:approvals': stemmen.filter((x) => x.decision === 'approve').length,
    'shaer:guardianCount': guardianCount || undefined,
    'shaer:myVote': stemmen.some((x) => x.guardian_uri === me),
    published: r.created_at,
  };
}

/** De openstaande reviews van een guardian, per richting. */
export function listReviewsByDirection(guardianSlug, direction) {
  return listReviews(guardianSlug).filter((r) => (r.direction === 'outgoing' ? 'outgoing' : 'incoming') === direction);
}
export function getReview(guardianSlug, id) { return rstmts().get.get(guardianSlug, id); }
export function listReviews(guardianSlug) { return rstmts().bySlug.all(guardianSlug); }
export function removeReview(guardianSlug, id) { rstmts().del.run(guardianSlug, id); }

export default {
  recordPending, getPending, listForWard, decide, remove,
  recordReview, getReview, listReviews, removeReview,
  listReviewsByDirection, reviewQueueItem,
};
