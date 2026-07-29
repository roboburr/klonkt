/**
 * The Guardian PWA (FEP-633c): a separate, installable corner of Klonkt for
 * guardians. One place to add and manage wards, a message centre for
 * incoming help requests and adoption traffic, and its own push channel
 * (alert types 'help' and 'guardian', web-push slice reused).
 *
 * Everything is scoped to a site the logged-in user OWNS: the guardian acts
 * as one of their own actors (?site=slug picks one when they own several).
 * Views carry no inline scripts (CSP): logic lives in /assets/js/guardian.js.
 */
import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import AP from '../services/ActivityPubService.js';
import * as Guardianship from '../services/guardianship/index.js';
import { t as i18nT, resolveLang } from '../services/i18n.js';
import { injectCspNonce, renderNoteBody, formatDateTime } from '../middleware/render.js';
import { emojiName } from '../services/NoteRender.js';

const router = express.Router();
const __dir = path.dirname(fileURLToPath(import.meta.url));

/** The acting site: ?site=slug when owned, else the user's first site. */
function siteForUser(req) {
  const userId = req.session.user.id;
  const want = String(req.query.site || req.body?.site || '').trim();
  if (want) {
    const s = db.prepare('SELECT * FROM sites WHERE slug = ? AND owner_id = ?').get(want, userId);
    if (s) return s;
  }
  return db.prepare('SELECT * FROM sites WHERE owner_id = ? ORDER BY id LIMIT 1').get(userId);
}

/** Everything the dashboard shows, one shape for page and API. */
function uiStrings(L) {
  const keys = ['sent', 'sent_retry', 'sending', 'not_found', 'failed', 'network',
    'pending', 'active', 'retract', 'release', 'release_confirm', 'open', 'push_unavailable',
    'embeds_on', 'embeds_off', 'embeds_propose', 'embeds_waiting',
    'accept', 'reject', 'complete', 'awaiting_others', 'coguard',
    // The per-ward panel: everything about one child in one place.
    'settings_title', 'panel_open', 'panel_close', 'panel_help', 'panel_help_empty',
    'panel_follow', 'panel_follow_empty', 'panel_posts', 'panel_posts_empty',
    'panel_actions', 'badge_help', 'badge_follow', 'badge_follow_one', 'help_empty',
    // Releasing a ward: a deliberate two-step answer, never one click.
    'release_title', 'release_effect', 'release_local', 'release_step_down',
    'release_last', 'release_unknown', 'release_yes', 'release_no',
    // Availability (FEP-633c 3.6): the dots, the step-away, the lapse.
    'avail_available', 'avail_away', 'avail_dormant', 'panel_guards', 'panel_guards_remote',
    'lapse_propose', 'lapse_line', 'lapse_tally', 'lapse_note', 'lapse_agree', 'lapse_disagree', 'voted',
    'away_title', 'away_sub', 'away_week', 'away_month', 'away_done',
    // A gated-setting proposal from a fellow guardian (5.6).
    'gated_title', 'gated_line_on', 'gated_line_off', 'gated_agree', 'gated_disagree',
    'play_propose', 'play_on', 'play_off'];
  const s = Object.fromEntries(keys.map((k) => [k, i18nT(L, `guardian.${k}`)]));
  s.wave = i18nT(L, 'guardian.wave');
  s.waved = i18nT(L, 'guardian.waved');
  return s;
}

function dashboardState(site, L) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const help = db.prepare(
    `SELECT object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, content, published, created_at,
            emoji_json, actor_emoji_json, media_json, quote_json, embed_json
     FROM ap_mentions WHERE slug = ? AND help_request = 1 ORDER BY created_at DESC LIMIT 50`
  ).all(site.slug).map((h) => ({
    ...h,
    // The dashboard is built in the browser, so it gets the body finished: the
    // same partial de Krant and Berichten use. A 🛟 often carries a screenshot
    // and a link to the post it is about; both belong in the card.
    body_html: renderNoteBody(h, L),
    name_html: emojiName(h.actor_name || '', h.actor_emoji_json),
    // In the site's own timezone, the same as everywhere else in Klonkt. The
    // PWA used to slice the raw UTC string, so a 20:20 call for help read 18:20.
    when_text: formatDateTime(h.published || h.created_at),
  }));
  return {
    site: site.slug,
    me,
    // Committed wards, each carrying the gated settings a guardian may change.
    // `embeds` is null for a ward we do not host: that setting lives on the
    // ward's own server, so we show it as not-adjustable rather than lying.
    // `guardians` (FEP-633c 3.6): the fellow guardians of a LOCAL ward with
    // their availability; null for a remote ward, whose server tracks it.
    wards: Guardianship.listWards(site.slug).map((w) => ({
      ...w,
      embeds: wardEmbedSetting(w.other_uri),
      playback: wardPlaybackSetting(w.other_uri),
      guardians: wardGuardianStatuses(w.other_uri),
    })),
    offers: Guardianship.offersCollection(`${me}/queues/offers`, site.slug, me).orderedItems,
    // Running lapses (3.6.3) this guardian or its local wards are party to.
    lapses: Guardianship.availability.lapseQueueItems(site.slug, me, Date.now()),
    // Gated-setting proposals another guardian opened on a ward we share
    // (5.6), forwarded here by the ward's server. Without answering these the
    // threshold is never met and the proposal simply expires.
    gatedReviews: Guardianship.gated.listGatedReviews(site.slug).map((r) => ({
      id: r.id, ward: r.ward_uri, proposer: r.proposer, feature: r.feature, value: !!r.value,
    })),
    help,
    strings: uiStrings(L),
  };
}

/** The guardians of a ward WE host, with availability (3.6.1: owner-only in
 *  spirit; the co-guardians are among the owners of the relationship). Null
 *  for a remote ward: its server tracks availability, not us. */
function wardGuardianStatuses(wardUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !String(wardUri || '').startsWith(`${base}/`)) return null;
  const slug = String(wardUri).trim().replace(/\/+$/, '').split('/').pop();
  try {
    const uris = Guardianship.listGuardians(slug).map((g) => ({ uri: g.other_uri, handle: g.other_handle }));
    const st = Object.fromEntries(
      Guardianship.availability.statusesFor(slug, uris.map((u) => u.uri), Date.now()).map((s) => [s.id, s]),
    );
    return uris.map((u) => ({
      uri: u.uri,
      handle: u.handle,
      availability: (st[u.uri] || {})['shaer:availability'] || 'active',
      awayUntil: (st[u.uri] || {})['shaer:awayUntil'] || null,
      lapse: (st[u.uri] || {})['shaer:lapse'] || null,
    }));
  } catch { return null; }
}

// ── The PWA page ─────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const site = siteForUser(req);
  const L = resolveLang(req);
  if (!site) return res.status(404).send('No site for this account.');
  const sites = db.prepare('SELECT slug, title FROM sites WHERE owner_id = ? ORDER BY id').all(req.session.user.id);
  // This standalone PWA page is rendered directly (not through renderPage), so
  // the CSP nonce must be injected here — otherwise strict-dynamic blocks
  // guardian.js and the whole dashboard is dead (buttons do nothing).
  res.render('pages/guardian', {
    state: dashboardState(site, L),
    sites,
    lang: L,
    t: (k, v) => i18nT(L, k, v),
    cspNonce: res.locals.cspNonce,
  }, (err, html) => {
    if (err) { console.error('[guardian] render error', err); return res.status(500).send('Internal Server Error'); }
    res.send(injectCspNonce(html, res.locals.cspNonce));
  });
});

// ── JSON state for refreshes ─────────────────────────────────────────────
router.get('/api/state', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  res.json(dashboardState(site, resolveLang(req)));
});

// ── Meekijken (FEP-633c §5, interop-hoofdroute): a committed guardian FOLLOWS
//    its wards, so their posts (incl. followers-only) are DELIVERED to the
//    guardian's inbox → timeline. The follow is the mechanism; no new fetch.
//    First contact also backfills the ward's recent PUBLIC posts as a cold
//    start so the corner is not empty before delivery catches up.
function ensureWardConnections(site) {
  let wards;
  try { wards = Guardianship.listWards(site.slug); } catch { return; }
  for (const w of wards) {
    const already = db.prepare('SELECT 1 FROM ap_following WHERE slug = ? AND actor_uri = ?')
      .get(site.slug, w.other_uri);
    if (already) continue;
    // Follow (guardian's server auto-accepts today; §5.3 gating is a later fase).
    AP.followActor(site, w.other_uri).catch(() => { /* retried by the queue */ });
    // Cold start: pull recent public posts now so oma sees something at once.
    AP.backfillFromOutbox(site.slug, w.other_uri).catch(() => { /* best-effort */ });
  }
}

// ── The wards' corner: your wards' posts, read-only. No reply, no share; a
//    guardian watches, it does not publish (Robins besluit).
router.get('/api/feed', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  ensureWardConnections(site);
  const wardUris = new Set(Guardianship.listWards(site.slug).map((w) => w.other_uri));
  // Only show the wards you actually guard (the timeline can hold more).
  const items = AP.getTimeline(site.slug, 60, 0)
    .filter((p) => wardUris.has(p.author_uri))
    .map((p) => ({
      id: p.id,
      author: p.author_handle || p.author_name || p.author_uri,
      authorUri: p.author_uri,   // the grouping key: which child's panel this belongs in
      authorName: p.author_name,
      authorIcon: p.author_icon,
      content: p.content,
      url: p.url,
      published: p.published || p.created_at,
      when_text: formatDateTime(p.published || p.created_at),
      cw: p.cw || null,
      media: p.media_json ? JSON.parse(p.media_json) : [],
    }));
  res.json({ items, following: wardUris.size });
});

// ── Follow-gating (FEP-633c §5.3): pending follows on MY wards, for me to
//    approve. Ward and guardian are co-located on the family Klonkt here, so
//    the guardian reads its wards' pending follows locally.
function wardSlugsOf(site) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return Guardianship.listWards(site.slug)
    .map((w) => (w.other_uri.startsWith(base) ? { slug: w.other_uri.split('/').pop(), uri: w.other_uri } : null))
    .filter(Boolean);
}

router.get('/api/follow-requests', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const items = [];
  const host = (() => { try { return new URL(process.env.PUBLIC_BASE_URL || '').host; } catch { return ''; } })();
  // wardUri is the grouping key for the per-ward panel: the handle is for
  // reading, the URI is what identifies the child across both cases below.
  // Local wards (guardian co-located): read the pending follows directly.
  for (const w of wardSlugsOf(site)) {
    for (const f of Guardianship.follows.listForWard(w.slug)) {
      items.push({ id: f.id, ward: `@${w.slug}@${host}`, wardUri: w.uri, follower: f.follower_handle || f.follower_name || f.follower_uri, followerIcon: f.follower_icon, remote: false, created: f.created_at });
    }
  }
  // Remote wards: the copies forwarded here as Offer(Follow) (cross-instance).
  for (const rev of Guardianship.follows.listReviews(site.slug)) {
    const wardName = (() => { try { const u = new URL(rev.ward_uri); return `@${u.pathname.split('/').pop()}@${u.host}`; } catch { return rev.ward_uri; } })();
    items.push({ id: rev.id, ward: wardName, wardUri: rev.ward_uri, follower: rev.follower_handle || rev.follower_uri, followerIcon: rev.follower_icon, remote: true, created: rev.created_at });
  }
  res.json({ items });
});

router.post('/api/follow/:id', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';

  // Remote ward: a forwarded copy. Send my Accept/Reject back to the ward,
  // which tallies quorum and returns the Accept(Follow) to the follower.
  const review = Guardianship.follows.getReview(site.slug, req.params.id);
  if (review) {
    try { await AP.sendFollowDecision(site, review, decision); }
    catch { return res.status(502).json({ error: 'delivery' }); }
    Guardianship.follows.removeReview(site.slug, req.params.id);
    return res.json({ ok: true, outcome: decision === 'reject' ? 'rejected' : 'sent' });
  }

  // Local ward: decide directly (quorum on this instance).
  const pending = Guardianship.follows.getPending(req.params.id);
  if (!pending) return res.status(404).json({ error: 'gone' });
  const allGuardians = Guardianship.listGuardians(pending.ward_slug).map((g) => g.other_uri);
  if (!allGuardians.includes(me)) return res.status(403).json({ error: 'not_a_guardian' });
  // Acting from the dashboard is an answer (3.6), and the quorum runs over
  // the available set (3.5): both applied here, the same as over the wire.
  Guardianship.availability.oneAnswer(me, Date.now());
  const guardians = Guardianship.availability.availableSet(pending.ward_slug, allGuardians, Date.now());
  const r = Guardianship.follows.decide(pending.id, me, decision, guardians);
  try {
    if (r.outcome === 'approved') { await AP.acceptGatedFollow(r.follow); Guardianship.follows.remove(r.follow.id); }
    else if (r.outcome === 'rejected') { await AP.rejectGatedFollow(r.follow); Guardianship.follows.remove(r.follow.id); }
  } catch (e) { return res.status(502).json({ error: 'delivery', outcome: r.outcome }); }
  res.json({ ok: true, outcome: r.outcome });
});

// ── Wave (FEP-633c §5, shaer:wave): a gentle "thinking of you" from a
//    guardian to a ward. A private direct note, never a feed post. Warmth
//    without publishing (Robins besluit).
router.post('/api/wave', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const wardUri = String(req.body?.ward || '').trim();
  // Only wave at a ward you actually guard.
  const isWard = Guardianship.listWards(site.slug).some((w) => w.other_uri === wardUri);
  if (!wardUri || !isWard) return res.status(403).json({ error: 'not_your_ward' });
  const text = String(req.body?.text || '').trim().slice(0, 200) || '👋 thinking of you';
  const r = await AP.deliverDirectNote(site, { recipients: [wardUri], text, wave: true }).catch(() => null);
  if (!r) return res.status(502).json({ error: 'delivery' });
  res.json({ ok: true, delivered: r.delivered });
});

// ── Adopt a ward: handle → resolve → C2S Offer through the same pipeline
//    the Shaer apps use (one path, one behavior).
router.post('/adopt', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const handle = String(req.body?.handle || '').trim();
  if (!handle) return res.status(400).json({ error: 'empty_handle' });
  const wardUri = /^https?:\/\//i.test(handle) ? handle : await AP.webfingerResolve(handle).catch(() => null);
  if (!wardUri) return res.status(404).json({ error: 'not_found' });   // the handle does not resolve to an account
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const r = await AP.ingestOutboxActivity(site, req.session.user, {
    type: 'Offer',
    object: { type: 'Relationship', subject: wardUri, relationship: 'shaer:Guardian', object: me },
  });
  // 403/400 = a real refusal (e.g. you are a ward yourself); anything else the
  // offer is recorded and delivery is retried in the background.
  if (!r || (r.status >= 400 && r.status !== 502)) return res.status(r?.status || 500).json({ error: r?.error || 'offer_failed' });
  res.json({ ok: true, ward: wardUri, delivered: r.delivered !== false });
});

// ── Answer an offer (co-guardian accept/reject, or the candidate's final
//    "complete"). All three are a C2S Accept/Reject on the offer id; the
//    handshake module decides when it commits (§3.1).
// ── Step away (FEP-633c 3.6.1): the guardian declares itself unavailable ──
// One direct note with shaer:away and an endTime to every ward, the same
// path Shaer takes over C2S. Wards on this instance are applied directly (a
// local inbox never receives its own delivery); the rest travels S2S.
router.post('/api/away', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const days = Math.min(365, Math.max(1, parseInt(req.body?.days, 10) || 0));
  if (!days) return res.status(400).json({ error: 'away_needs_an_end' });
  const wards = Guardianship.listWards(site.slug).map((w) => w.other_uri);
  if (!wards.length) return res.status(409).json({ error: 'no_wards' });
  const until = Date.now() + days * 24 * 3600 * 1000;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  let applied = 0;
  for (const uri of wards) {
    const wslug = uri.startsWith(`${base}/`) ? uri.replace(/\/+$/, '').split('/').pop() : null;
    if (wslug && Guardianship.listGuardians(wslug).some((g) => g.other_uri === me)) {
      Guardianship.availability.declareAway(wslug, me, until);
      applied++;
    }
  }
  const L = resolveLang(req);
  const text = i18nT(L, 'guardian.away_msg', { date: new Date(until).toLocaleDateString('nl-NL') });
  const r = await AP.deliverDirectNote(site, { recipients: wards, text, awayUntil: until }).catch(() => null);
  if (!applied && !(r && r.id)) return res.status(502).json({ error: 'away_failed' });
  res.json({ ok: true, until });
});

// ── Propose a lapse (FEP-633c 3.6.3) against a dormant co-guardian ────────
// The same C2S pipeline the Shaer apps would use: an Offer of shaer:Lapse.
// A local ward opens directly; a remote ward gets the proposal delivered,
// because the ward's server is the one that tallies and enforces.
router.post('/api/lapse', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const ward = String(req.body?.ward || '').trim();
  const target = String(req.body?.target || '').trim();
  if (!ward || !target) return res.status(400).json({ error: 'missing_ward_or_target' });
  if (!Guardianship.listWards(site.slug).some((w) => w.other_uri === ward)) {
    return res.status(403).json({ error: 'not_my_ward' });
  }
  const r = await AP.ingestOutboxActivity(site, req.session.user, {
    type: 'Offer', object: { type: 'shaer:Lapse', 'shaer:ward': ward, object: target },
  });
  if (!r || r.status >= 400) return res.status(r?.status || 500).json({ error: r?.error || 'lapse_failed' });
  res.json({ ok: true, lapse: r.id });
});

// ── Answer a forwarded gated-setting proposal (FEP-633c 5.6) ─────────────
// The decision belongs to the ward's server, so the answer travels there as an
// Accept/Reject on the offer id, exactly like a gated follow's decision.
router.post('/api/gated/:id', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const review = Guardianship.gated.getGatedReview(site.slug, req.params.id);
  if (!review) return res.status(404).json({ error: 'gone' });
  const agree = req.body?.answer !== 'reject';
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const activity = {
    id: `${me}#gated-${Date.now().toString(36)}`,
    type: agree ? 'Accept' : 'Reject', actor: me, to: [review.ward_uri], object: review.id,
  };
  try { await AP.deliverToActor(site, review.ward_uri, activity); }
  catch { return res.status(502).json({ error: 'delivery' }); }
  Guardianship.gated.removeGatedReview(site.slug, review.id);
  res.json({ ok: true, answer: agree ? 'accept' : 'reject' });
});

router.post('/offer', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const offerId = String(req.body?.offer || '').trim();
  const answer = req.body?.answer === 'reject' ? 'Reject' : 'Accept';
  if (!offerId) return res.status(400).json({ error: 'empty_offer' });
  const r = await AP.ingestOutboxActivity(site, req.session.user, { type: answer, object: offerId });
  if (!r || r.status >= 400) return res.status(r?.status || 500).json({ error: r?.error || 'answer_failed' });
  res.json({ ok: true, committed: !!r.committed, readyToCommit: !!r.readyToCommit });
});

// ── PWA assets served no-cache, so an update is never masked by the 1-year
//    /assets cache or a stuck install (that was the whole "nothing works after
//    a deploy" bug). Small files; the browser revalidates and gets a 304 when
//    unchanged, the fresh file when changed.
function pwaAsset(rel, type) {
  return (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type(type);
    res.sendFile(path.join(__dir, '..', 'assets', rel));
  };
}
router.get('/app.js', pwaAsset('js/guardian.js', 'application/javascript'));
router.get('/app.css', pwaAsset('css/guardian.css', 'text/css'));

// ── Manage: release a committed ward (local Undo; federation is Fase 4). ──
/**
 * What actually happens if this guardian releases this ward?
 *
 * Releasing is not one action but two very different ones, and the difference
 * is the number of guardians the child has left (FEP-633c):
 *   - more than one → §3.3, you step down and the child stays a ward;
 *   - you are the last → §3.4, that is emancipation, and the FEP is explicit
 *     that no single guardian decides it alone (three consenting adults, or a
 *     majority plus two witnesses).
 * On top of that, today's release is LOCAL: the Undo is not federated yet
 * (relations.js, fase 4), so the ward's server keeps listing this guardian.
 * A guardian pressing the button would otherwise believe the child is released.
 *
 * Answered on demand rather than in the dashboard state: for a ward we do not
 * host this reaches out to that ward's server, and nobody should pay for that
 * on every refresh.
 */
router.get('/wards/release-check', requireAuth, async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.query.uri || '').trim();
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  if (!Guardianship.listWards(site.slug).some((w) => w.other_uri === uri)) {
    return res.status(403).json({ error: 'not_my_ward' });
  }
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const local = !!base && uri.startsWith(`${base}/`);
  let guardians = null;   // null = we could not find out; say so rather than guess
  if (local) {
    const slug = uri.replace(/\/+$/, '').split('/').pop();
    try { guardians = Guardianship.listGuardians(slug).length; } catch { /* stays null */ }
  } else {
    const doc = await AP.fetchActor(uri).catch(() => null);
    const g = doc && doc['shaer:guardians'];
    if (Array.isArray(g)) guardians = g.length;
    else if (typeof g === 'string') guardians = 1;
    else if (g && Array.isArray(g.items)) guardians = g.items.length;
    else if (doc) guardians = 0;   // the actor answered and names no guardians
  }
  res.json({
    guardians,
    last: guardians === null ? null : guardians <= 1,
    local,
  });
});

router.post('/wards/remove', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.body?.uri || '').trim();
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  // Ending a guardianship is an Undo of the Relationship that travels to the
  // ward and the other guardians (§3.2), not a local delete. Same call the
  // Guardian apps reach over C2S, so the two cannot drift apart.
  const r = await Guardianship.endGuardianship(site, uri);
  if (r.status >= 400) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, delivered: r.delivered, guardiansLeft: r.guardiansLeft });
});

/**
 * The external-embeds setting of a ward we host: true/false when a guardian has
 * decided, null when it is still on auto (which means off for a ward) or when
 * the ward lives elsewhere and the setting is not ours to show.
 */
function wardEmbedSetting(uri) { return wardGateSetting(uri, 'external_embeds'); }
/** The playback gate of a ward we host (5.6): the heavier sibling. */
function wardPlaybackSetting(uri) { return wardGateSetting(uri, 'external_playback'); }
function wardGateSetting(uri, column) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !String(uri || '').startsWith(`${base}/`)) return null;
  const slug = String(uri).trim().replace(/\/+$/, '').split('/').pop();
  const row = slug ? db.prepare(`SELECT ${column === 'external_playback' ? 'external_playback' : 'external_embeds'} AS v FROM sites WHERE slug = ?`).get(slug) : null;
  if (!row) return null;
  return row.v === null || row.v === undefined ? false : row.v === 1;
}

// ── Gated feature: may this ward see external (non-fediverse) embeds? ──
// The first real gated setting (FEP-633c §5-style). The gate itself is applied
// server-side when the feed is serialised, so this endpoint is the only way it
// can move, and only a committed guardian of THAT ward may move it.
router.post('/wards/embeds', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  req.body = { ...req.body, feature: req.body?.feature === 'shaer:externalPlayback' ? 'shaer:externalPlayback' : 'shaer:externalEmbeds' };
  return proposeGated(req, res);
});
function proposeGated(req, res) {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.body?.uri || '').trim();
  const allow = req.body?.allow === true;
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  // Only a guardian of this ward, and only for a ward we host: a setting on a
  // remote ward belongs to that ward's own server (federating it is Fase 4).
  const isMyWard = Guardianship.listWards(site.slug).some((w) => w.other_uri === uri);
  if (!isMyWard) return res.status(403).json({ error: 'not_your_ward' });
  // §5.6: propose it to the WARD'S server, wherever that is. The ward's server
  // tallies (a majority of its guardians, §3.5) and enforces. Co-location is
  // just the case where that server happens to be this one, so it takes the
  // same road: propose, then let the tally decide. Anything else would make a
  // guardian on the ward's own instance more powerful than one elsewhere.
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const feature = req.body.feature;   // normalised by the route above
  const offerId = `${me}/gated/${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const offer = Guardianship.gated.buildGatedOffer(offerId, me, uri, feature, allow);
  const localSlug = (base && uri.startsWith(`${base}/`)) ? uri.replace(/\/+$/, '').split('/').pop() : null;
  const localWard = localSlug ? db.prepare('SELECT slug FROM sites WHERE slug = ?').get(localSlug) : null;
  if (localWard) {
    Guardianship.gated.rememberGatedOffer(offerId, localWard.slug, feature, allow);
    const r = Guardianship.gated.recordGatedVote(localWard.slug, feature, me, allow);
    // Same forward as the S2S path: without it the other guardians never learn
    // the proposal exists and a threshold of two can never be met.
    if (r.state === 'open') {
      const wardActor = AP.actorId(base, localWard.slug);
      for (const g of Guardianship.listGuardians(localWard.slug).map((x) => x.other_uri)) {
        if (g === me) continue;
        // Signed by the ward, so the body must say the ward: anything else is
        // a signer mismatch and the receiver answers 401 (as it should).
        AP.deliverToActor(
          db.prepare('SELECT * FROM sites WHERE slug = ?').get(localWard.slug),
          g,
          { ...offer, actor: wardActor, to: [g], 'shaer:proposer': me },
        ).catch(() => { /* queued */ });
      }
    }
    return res.json({ ok: true, allow, state: r.state, need: r.need, of: r.of });
  }
  AP.deliverToActor(site, uri, offer).catch(() => { /* queued, best-effort */ });
  res.json({ ok: true, allow, state: 'open', federated: true });
}

// ── The installable identity: own scope so the Guardian corner installs as
//    its own app next to the site PWA.
router.get('/manifest.webmanifest', (req, res) => {
  const site = res.locals.site;
  res.set('Cache-Control', 'no-cache');
  res.json({
    id: `klonkt-guardian-${site?.slug || 'guardian'}`,
    name: 'Klonkt Guardian',
    short_name: 'Guardian',
    description: 'Ward management and help requests for guardians.',
    scope: '/guardian/',
    start_url: '/guardian?source=pwa',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#141a24',
    theme_color: '#ff6b35',
    lang: site?.language || 'nl',
    icons: [
      { src: '/guardian/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  });
});

// The buoy mark, in the guardian accent (mirrors the site favicon pattern).
router.get('/icon.svg', (req, res) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#ff6b35"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="36">&#128735;</text>
</svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ── Losse guardians (Guardian 2): uitnodigen en aansluiten ───────────────
// De familie nodigt oma uit; zij kiest naam + wachtwoord en heeft daarmee een
// guardian-only account: user + minimale site (guardian_only=1). Alles wat al
// per slug werkt (actor, inbox, offers, push, deze PWA) werkt dan meteen.

router.post('/invite', requireAuth, (req, res) => {
  const token = crypto.randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO ap_guardian_invites (token, created_by) VALUES (?,?)')
    .run(token, req.session.user.id);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = `${base}/guardian/join/${token}`;
  res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:480px;margin:40px auto">
    <h2>Invite a guardian</h2>
    <p>Share this link. It lets one person create a guardian account here:</p>
    <p><a href="${url}">${url}</a></p>
    <p><a href="/guardian">Back</a></p></body>`);
});

function joinForm(token, error) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <body style="font-family:sans-serif;max-width:420px;margin:40px auto">
  <h2>Become a guardian</h2>
  <p>Watch over someone you care about. Pick a name and a password; that is all.</p>
  ${error ? `<p style="color:#b00">${error}</p>` : ''}
  <form method="post" action="/guardian/join/${token}">
    <p><input name="name" placeholder="your name (grandma)" required pattern="[a-z0-9_-]{1,32}"
       style="width:100%;padding:10px" autocapitalize="none"></p>
    <p><input name="password" type="password" placeholder="password" required minlength="8"
       style="width:100%;padding:10px"></p>
    <p><button style="width:100%;padding:12px">Create my guardian account</button></p>
  </form></body>`;
}

router.get('/join/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM ap_guardian_invites WHERE token = ? AND used_at IS NULL')
    .get(req.params.token);
  if (!inv) return res.status(404).send('This invite is no longer valid.');
  res.send(joinForm(req.params.token));
});

router.post('/join/:token', express.urlencoded({ extended: false }), (req, res) => {
  const inv = db.prepare('SELECT * FROM ap_guardian_invites WHERE token = ? AND used_at IS NULL')
    .get(req.params.token);
  if (!inv) return res.status(404).send('This invite is no longer valid.');
  const name = String(req.body.name || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) return res.status(400).send(joinForm(req.params.token, 'Only lowercase letters, digits, - and _.'));
  if (password.length < 8) return res.status(400).send(joinForm(req.params.token, 'Password: at least 8 characters.'));
  if (db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(name) || db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
    return res.status(409).send(joinForm(req.params.token, 'That name is taken, pick another.'));
  }
  const userId = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(userId, name, `${name}@guardian.invalid`, bcrypt.hashSync(password, 10), 'member');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary, guardian_only) VALUES (?,?,?,?,0,1)')
    .run(crypto.randomUUID(), name, name, userId);
  db.prepare('UPDATE ap_guardian_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE token = ?')
    .run(userId, req.params.token);
  req.session.user = { id: userId, username: name, role: 'member' };
  res.redirect('/guardian');
});

export default router;
