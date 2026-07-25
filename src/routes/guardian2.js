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
import { injectCspNonce } from '../middleware/render.js';

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
    'pending', 'active', 'retract', 'release', 'open', 'push_unavailable',
    'accept', 'reject', 'complete', 'awaiting_others', 'coguard'];
  return Object.fromEntries(keys.map((k) => [k, i18nT(L, `guardian.${k}`)]));
}

function dashboardState(site, L) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const help = db.prepare(
    `SELECT object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, content, published, created_at
     FROM ap_mentions WHERE slug = ? AND help_request = 1 ORDER BY created_at DESC LIMIT 50`
  ).all(site.slug);
  return {
    site: site.slug,
    me,
    wards: Guardianship.listWards(site.slug),               // committed wards
    offers: Guardianship.offersCollection(`${me}/queues/offers`, site.slug, me).orderedItems,
    help,
    strings: uiStrings(L),
  };
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
  res.render('pages/guardian2', {
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
      authorName: p.author_name,
      authorIcon: p.author_icon,
      content: p.content,
      url: p.url,
      published: p.published || p.created_at,
      cw: p.cw || null,
      media: p.media_json ? JSON.parse(p.media_json) : [],
    }));
  res.json({ items, following: wardUris.size });
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
router.get('/app.js', pwaAsset('js/guardian2.js', 'application/javascript'));
router.get('/app.css', pwaAsset('css/guardian2.css', 'text/css'));

// ── Manage: release a committed ward (local Undo; federation is Fase 4). ──
router.post('/wards/remove', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.body?.uri || '').trim();
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  Guardianship.removeRelation(site.slug, 'guardian', uri);
  res.json({ ok: true });
});

// ── The installable identity: own scope so the Guardian corner installs as
//    its own app next to the site PWA.
router.get('/manifest.webmanifest', (req, res) => {
  const site = res.locals.site;
  res.set('Cache-Control', 'no-cache');
  res.json({
    id: `klonkt-guardian2-${site?.slug || 'guardian'}`,
    name: 'Klonkt Guardian',
    short_name: 'Guardian 2',
    description: 'Ward management and help requests for guardians.',
    scope: '/guardian2/',
    start_url: '/guardian?source=pwa',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#141a24',
    theme_color: '#ff6b35',
    lang: site?.language || 'nl',
    icons: [
      { src: '/guardian2/icon.svg', sizes: 'any', type: 'image/svg+xml' },
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
  const url = `${base}/guardian2/join/${token}`;
  res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:480px;margin:40px auto">
    <h2>Invite a guardian</h2>
    <p>Share this link. It lets one person create a guardian account here:</p>
    <p><a href="${url}">${url}</a></p>
    <p><a href="/guardian2">Back</a></p></body>`);
});

function joinForm(token, error) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <body style="font-family:sans-serif;max-width:420px;margin:40px auto">
  <h2>Become a guardian</h2>
  <p>Watch over someone you care about. Pick a name and a password; that is all.</p>
  ${error ? `<p style="color:#b00">${error}</p>` : ''}
  <form method="post" action="/guardian2/join/${token}">
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
  res.redirect('/guardian2');
});

export default router;
