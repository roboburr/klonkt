/**
 * ActivityPubService — Klonkt as a real ActivityPub actor (fediverse bridge).
 *
 * Phase 1 (this file): the PUBLISH/discoverable side.
 *   - per-site RSA keypair (Mastodon-compatible HTTP Signatures; separate from
 *     the Ed25519 keys used by the lighter Cirkels v1)
 *   - builders for the Actor document, Note objects and the Outbox collection
 *   - apWants(): HTTP content-negotiation helper (activity+json vs HTML)
 *
 * The interactive side (inbox: Follow/Accept, signature verify, delivery to
 * followers) lands in the next step and is tested live against Mastodon.
 *
 * AP actor URLs live under /ap/* so they never clash with the human pages:
 *   actor   = <base>/ap/users/<slug>
 *   inbox   = <actor>/inbox      outbox = <actor>/outbox
 *   note    = <base>/ap/notes/<postId>
 */
import crypto from 'crypto';
import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const MAX_OUTBOX = 20;

// ── RSA keys per actor (lazy, cached in DB) ───────────────────────
// Prepared lazily (NOT at module load) — the ap_keys table is created in
// initializeDatabase(), which runs after this module is imported.
let _sel, _ins;
function keyStmts() {
  if (!_sel) {
    _sel = db.prepare('SELECT public_pem, private_pem FROM ap_keys WHERE slug = ?');
    _ins = db.prepare('INSERT OR IGNORE INTO ap_keys (slug, public_pem, private_pem, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)');
  }
  return { sel: _sel, ins: _ins };
}

export function getOrCreateKeys(slug) {
  const { sel, ins } = keyStmts();
  const row = sel.get(slug);
  if (row) return row;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  ins.run(slug, publicKey, privateKey);
  return sel.get(slug) || { public_pem: publicKey, private_pem: privateKey };
}

// ── content negotiation ───────────────────────────────────────────
// True when the caller wants ActivityPub JSON rather than the HTML page.
export function apWants(req) {
  const a = String(req.headers.accept || '').toLowerCase();
  return a.includes('application/activity+json') ||
         (a.includes('application/ld+json') && a.includes('activitystreams'));
}

const AP_CONTENT_TYPE = 'application/activity+json; charset=utf-8';
export function sendAP(res, obj) {
  res.type(AP_CONTENT_TYPE);
  res.set('Cache-Control', 'public, max-age=120');
  res.send(JSON.stringify(obj));
}

// ── document builders ─────────────────────────────────────────────
export function actorId(base, slug) { return `${base}/ap/users/${encodeURIComponent(slug)}`; }
export function noteId(base, postId) { return `${base}/ap/notes/${encodeURIComponent(postId)}`; }

export function buildActor(base, site) {
  const id = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const actor = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id,
    type: 'Person',
    preferredUsername: site.slug,
    name: site.title || site.slug,
    summary: site.tagline || site.description || '',
    url: `${base}/${site.slug === site.primary_slug ? '' : 'user/' + encodeURIComponent(site.slug)}`,
    manuallyApprovesFollowers: false,
    discoverable: true,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    endpoints: { sharedInbox: `${base}/ap/inbox` },
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: keys.public_pem,
    },
  };
  if (site.profile_photo) {
    const u = /^https?:/.test(site.profile_photo) ? site.profile_photo : `${base}${site.profile_photo.startsWith('/') ? '' : '/'}${site.profile_photo}`;
    actor.icon = { type: 'Image', url: u };
  }
  return actor;
}

// A single post as an AS2 Note (the object), and as a Create activity (for outbox/delivery).
export function buildNote(base, site, post) {
  const id = noteId(base, post.id);
  const aId = actorId(base, site.slug);
  const human = `${base}/${encodeURIComponent(post.slug)}`;
  // Mastodon ignores a Note's `name`, so put the title INTO the content (bold
  // first line) — the standard blog→fediverse convention. post.content is
  // already sanitized HTML; the title is plain text, so escape it.
  const escTitle = String(post.title || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const titleHtml = post.title ? `<p><strong>${escTitle}</strong></p>` : '';

  // Images travel as AP `attachment` (Mastodon strips <img> from content). Collect
  // the cover + any inline <img>, make absolute, then strip <img> from the content
  // to avoid duplicate rendering on clients that DO keep them.
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
  const mediaType = (u) => {
    const e = ((u || '').split('?')[0].match(/\.(\w+)$/) || [])[1];
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' })[(e || '').toLowerCase()] || 'image/jpeg';
  };
  const urls = [];
  if (post.cover_image_url) urls.push(abs(post.cover_image_url));
  let body = post.content || '';
  for (const m of body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) urls.push(abs(m[1]));
  body = body.replace(/<img\b[^>]*>/gi, '');
  const seen = new Set();
  const attachment = urls.filter(Boolean)
    .filter((u) => { if (seen.has(u)) return false; seen.add(u); return true; })
    .map((u) => ({ type: 'Document', mediaType: mediaType(u), url: u }));

  const note = {
    id,
    type: 'Note',
    attributedTo: aId,
    content: titleHtml + body,
    url: human,
    published: new Date(post.published_at || post.created_at || Date.now()).toISOString(),
    to: [PUBLIC],
    cc: [`${aId}/followers`],
    tag: Array.isArray(post.tags) ? post.tags.map((t) => ({ type: 'Hashtag', name: '#' + String(t).replace(/\s+/g, '') })) : [],
  };
  if (attachment.length) note.attachment = attachment;
  return note;
}

export function buildCreate(base, site, post) {
  const note = buildNote(base, site, post);
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: note.id + '#create',
    type: 'Create',
    actor: actorId(base, site.slug),
    published: note.published,
    to: note.to,
    cc: note.cc,
    object: note,
  };
}

export function buildOutbox(base, site, posts) {
  const id = `${actorId(base, site.slug)}/outbox`;
  const items = (posts || []).slice(0, MAX_OUTBOX).map((p) => buildCreate(base, site, p));
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  };
}

export function buildFollowers(base, site, count) {
  const id = `${actorId(base, site.slug)}/followers`;
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id,
    type: 'OrderedCollection',
    totalItems: count || 0,
    orderedItems: [], // hidden for privacy; count only
  };
}

// ── followers store (lazy stmts) ──────────────────────────────────
let _insF, _delF, _listF, _cntF;
function fStmts() {
  if (!_insF) {
    _insF = db.prepare('INSERT OR IGNORE INTO ap_followers (slug, actor_uri, inbox, shared_inbox, created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)');
    _delF = db.prepare('DELETE FROM ap_followers WHERE slug = ? AND actor_uri = ?');
    _listF = db.prepare('SELECT inbox, shared_inbox FROM ap_followers WHERE slug = ?');
    _cntF = db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ?');
  }
  return { ins: _insF, del: _delF, list: _listF, cnt: _cntF };
}
export function followerCount(slug) { return fStmts().cnt.get(slug).n; }

// ── inbound interactions store (replies / likes / boosts) + our outbound replies ──
let _insI, _delLA, _delReply, _listI, _getI, _insO, _listO, _getO;
function iStmts() {
  if (!_insI) {
    _insI = db.prepare('INSERT OR IGNORE INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delLA = db.prepare('DELETE FROM ap_interactions WHERE kind = ? AND post_id = ? AND actor_uri = ?');
    _delReply = db.prepare("DELETE FROM ap_interactions WHERE kind = 'reply' AND object_uri = ?");
    _listI = db.prepare('SELECT id, kind, object_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, created_at FROM ap_interactions WHERE post_id = ? ORDER BY created_at ASC');
    _getI = db.prepare('SELECT * FROM ap_interactions WHERE id = ?');
    _insO = db.prepare('INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, created_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listO = db.prepare('SELECT * FROM ap_outbox WHERE post_id = ? ORDER BY created_at ASC');
    _getO = db.prepare('SELECT * FROM ap_outbox WHERE id = ?');
  }
  return { ins: _insI, delLA: _delLA, delReply: _delReply, list: _listI, getI: _getI, insO: _insO, listO: _listO, getO: _getO };
}

export function getInteractionById(id) { return iStmts().getI.get(id); }

const localPostExists = (id) => { try { return !!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id); } catch { return false; } };
// Extract our local post id from a note URL, but only if it's ours (base match).
function postIdFromNoteUrl(url, base) {
  const s = String(url || '');
  if (base && !s.startsWith(base)) return null;
  const m = s.match(/\/ap\/notes\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function deriveHandle(actorUri) {
  try { const u = new URL(actorUri); const seg = u.pathname.split('/').filter(Boolean).pop() || ''; return `@${seg}@${u.host}`; } catch { return String(actorUri || ''); }
}
function actorInfo(doc, actorUri) {
  let host = ''; try { host = new URL(actorUri).host; } catch { /* keep empty */ }
  const handle = doc && doc.preferredUsername ? `@${doc.preferredUsername}@${host}` : deriveHandle(actorUri);
  const icon = doc && doc.icon ? (doc.icon.url || (Array.isArray(doc.icon) && doc.icon[0] && doc.icon[0].url)) : null;
  return {
    name: (doc && (doc.name || doc.preferredUsername)) || handle,
    handle,
    url: (doc && (doc.url || doc.id)) || actorUri,
    icon: icon || null,
  };
}

// Stored, view-ready summary of a post's inbound fediverse activity + our replies.
export function getInteractions(postId) {
  const s = iStmts();
  const rows = s.list.all(postId);
  const outReplies = s.listO.all(postId).map((o) => ({
    id: o.id, content: o.content, in_reply_to: o.in_reply_to, to_handle: o.to_handle,
    created_at: o.created_at, mine: true,
  }));
  return {
    replies: rows.filter((r) => r.kind === 'reply'),
    outReplies,
    likeCount: rows.filter((r) => r.kind === 'like').length,
    announceCount: rows.filter((r) => r.kind === 'announce').length,
    total: rows.length + outReplies.length,
  };
}

// ── HTTP Signatures + delivery ────────────────────────────────────
const slugFromActorUrl = (url) => { const m = String(url || '').match(/\/ap\/users\/([^/?#]+)/); return m ? decodeURIComponent(m[1]) : null; };

// Sign + POST an activity to a remote inbox (draft-cavage HTTP Signatures, RSA-SHA256).
export async function deliver(inboxUrl, bodyObj, keyId, privatePem) {
  const body = JSON.stringify(bodyObj);
  const u = new URL(inboxUrl);
  const date = new Date().toUTCString();
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
  const signingString = `(request-target): post ${u.pathname}\nhost: ${u.host}\ndate: ${date}\ndigest: ${digest}`;
  const signature = crypto.sign('sha256', Buffer.from(signingString), privatePem).toString('base64');
  const sig = `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`;
  const r = await fetch(inboxUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/activity+json', Accept: 'application/activity+json', Date: date, Digest: digest, Signature: sig },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return r.status;
}

export async function fetchActor(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/activity+json' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Best-effort verification of an incoming signed request. Returns the sender's
// actor doc if the signature checks out, else null. (Not gating yet — MVP.)
export async function verifyRequest(req) {
  const sigH = req.headers['signature'];
  if (!sigH) return null;
  const p = Object.fromEntries([...sigH.matchAll(/([a-zA-Z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!p.keyId || !p.signature) return null;
  const actor = await fetchActor(p.keyId.split('#')[0]);
  const pem = actor && actor.publicKey && actor.publicKey.publicKeyPem;
  if (!pem) return null;
  const hs = (p.headers || '(request-target) host date').split(/\s+/);
  const line = hs.map((h) => h === '(request-target)'
    ? `(request-target): ${req.method.toLowerCase()} ${req.originalUrl}`
    : `${h}: ${req.headers[h] || ''}`).join('\n');
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.from(line), pem, Buffer.from(p.signature, 'base64')); } catch { ok = false; }
  if (ok && hs.includes('digest') && req.rawBody) {
    const exp = 'SHA-256=' + crypto.createHash('sha256').update(req.rawBody).digest('base64');
    if (req.headers['digest'] !== exp) ok = false;
  }
  return ok ? actor : null;
}

// Handle an incoming inbox POST. slugParam = null for the shared /ap/inbox.
export async function handleInbox(req, slugParam) {
  const act = req.body || {};
  const type = act.type;
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const verified = await verifyRequest(req).catch(() => null); // best-effort; not gating (MVP)

  if (type === 'Follow') {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    const slug = slugParam || slugFromActorUrl(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (!who || !slug) return 400;
    const remote = await fetchActor(who);
    if (!remote || !remote.inbox) return 202; // can't reach them → drop quietly
    fStmts().ins.run(slug, who, remote.inbox, (remote.endpoints && remote.endpoints.sharedInbox) || null);
    const me = actorId(base, slug);
    const keys = getOrCreateKeys(slug);
    const accept = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${me}#accept-${Date.now()}`, type: 'Accept', actor: me, object: act };
    deliver(remote.inbox, accept, `${me}#main-key`, keys.private_pem).catch((e) => console.warn('[AP] Accept delivery failed:', e.message));
    console.log('[AP] Follow', who, '→', slug, verified ? '(sig ok)' : '(sig unverified)');
    return 202;
  }
  if (type === 'Undo' && act.object) {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    const ot = act.object.type;
    if (ot === 'Follow') {
      const obj = act.object.object;
      const slug = slugParam || slugFromActorUrl(typeof obj === 'string' ? obj : (obj && obj.id));
      if (who && slug) { fStmts().del.run(slug, who); console.log('[AP] Unfollow', who, '→', slug); }
      return 202;
    }
    if (ot === 'Like' || ot === 'Announce') {
      const tgt = act.object.object;
      const pid = postIdFromNoteUrl(typeof tgt === 'string' ? tgt : (tgt && tgt.id), base);
      if (who && pid) { iStmts().delLA.run(ot.toLowerCase(), pid, who); console.log('[AP] Undo', ot, who, '→', pid); }
      return 202;
    }
    return 202;
  }

  const actorUri = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  const resolveActor = async (uri) => ((verified && verified.id === uri) ? verified : await fetchActor(uri).catch(() => null));

  // Inbound reply: a Create whose object replies to one of our notes.
  if (type === 'Create' && act.object && (act.object.type === 'Note' || act.object.type === 'Article')) {
    const o = act.object;
    const pid = postIdFromNoteUrl(o.inReplyTo, base);
    if (pid && actorUri && localPostExists(pid)) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      const html = HtmlSanitizerService.sanitize(o.content || '');
      iStmts().ins.run('reply', pid, o.id || '', actorUri, ai.name, ai.handle, ai.url, ai.icon, html, o.published || null);
      console.log('[AP] reply', actorUri, '→', pid);
    }
    return 202;
  }
  if (type === 'Like' || type === 'Announce') {
    const tgt = act.object;
    const pid = postIdFromNoteUrl(typeof tgt === 'string' ? tgt : (tgt && tgt.id), base);
    if (pid && actorUri && localPostExists(pid)) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      iStmts().ins.run(type.toLowerCase(), pid, '', actorUri, ai.name, ai.handle, ai.url, ai.icon, null, null);
      console.log('[AP]', type === 'Like' ? 'like' : 'boost', actorUri, '→', pid);
    }
    return 202;
  }
  if (type === 'Delete') {
    // A remote reply was deleted upstream → drop it if we stored it.
    const oid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    if (oid) iStmts().delReply.run(oid);
    return 202;
  }

  console.log('[AP] inbox', type || 'unknown', '→', slugParam || 'shared', '(ignored)');
  return 202;
}

// Deliver a new post as Create(Note) to all followers' inboxes (fire-and-forget).
// Needs PUBLIC_BASE_URL (absolute URLs); no-op without followers or base.
export async function deliverCreate(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${actorId(base, site.slug)}#main-key`;
  const create = buildCreate(base, site, post);
  for (const inbox of inboxes) deliver(inbox, create, keyId, keys.private_pem).catch(() => { /* best-effort */ });
}

// Tell followers a post is gone (Delete + Tombstone) so it's removed from their feeds.
export async function deliverDelete(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !post || !post.id) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const nid = noteId(base, post.id);
  const del = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${nid}#delete-${Date.now()}`,
    type: 'Delete',
    actor: me,
    to: [PUBLIC],
    object: { id: nid, type: 'Tombstone' },
  };
  for (const inbox of inboxes) deliver(inbox, del, `${me}#main-key`, keys.private_pem).catch(() => { /* best-effort */ });
}

// ── outbound replies (Klonkt → fediverse) ─────────────────────────
const escHtml = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const toISO = (v) => { if (!v) return new Date().toISOString(); const s = String(v); const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };

// Build one of OUR outbound reply Notes from an ap_outbox row.
export function buildReplyNote(base, site, row) {
  const me = actorId(base, site.slug);
  return {
    id: noteId(base, row.id),
    type: 'Note',
    attributedTo: me,
    inReplyTo: row.in_reply_to || undefined,
    content: row.content,
    url: row.post_slug ? `${base}/${encodeURIComponent(row.post_slug)}` : undefined,
    published: toISO(row.created_at),
    to: row.to_actor ? [row.to_actor] : [PUBLIC],
    cc: [PUBLIC, `${me}/followers`],
    tag: row.to_actor ? [{ type: 'Mention', href: row.to_actor, name: row.to_handle }] : [],
  };
}

// Resolve one of our outbound reply Notes by id (for /ap/notes/:id fallback).
export function getOutboxNote(base, id) {
  const row = iStmts().getO.get(id);
  if (!row) return null;
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(row.site_slug);
  if (!site) return null;
  return buildReplyNote(base, site, row);
}

// Send a reply FROM this site to a remote actor (in reply to their inbound reply).
// `parent` = an ap_interactions row (actor_uri, actor_url, actor_handle, object_uri).
export async function deliverReply(site, { postId, postSlug, parent, text }) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !parent || !String(text || '').trim()) return null;
  const me = actorId(base, site.slug);
  const handle = parent.actor_handle || deriveHandle(parent.actor_uri);
  const body = escHtml(String(text).trim()).replace(/\r?\n/g, '<br>');
  const mention = parent.actor_uri
    ? `<a href="${escHtml(parent.actor_url || parent.actor_uri)}" class="u-url mention">${escHtml(handle)}</a> ` : '';
  const content = `<p>${mention}${body}</p>`;
  const id = crypto.randomUUID();
  iStmts().insO.run(id, site.slug, postId, postSlug || null, parent.object_uri || null, parent.actor_uri || null, handle, content);
  const row = iStmts().getO.get(id);
  const note = buildReplyNote(base, site, row);
  const create = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: note.id + '#create', type: 'Create', actor: me,
    published: note.published, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${me}#main-key`;
  const inboxes = new Set();
  if (parent.actor_uri) {
    const a = await fetchActor(parent.actor_uri).catch(() => null);
    if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox);
  }
  for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
  let delivered = 0;
  for (const inbox of [...inboxes].filter(Boolean)) {
    try { const st = await deliver(inbox, create, keyId, keys.private_pem); if (st >= 200 && st < 300) delivered++; } catch { /* best-effort */ }
  }
  console.log('[AP] outreply', site.slug, '→', parent.actor_uri, 'delivered', delivered);
  return { id, content, delivered };
}

// Resolve a remote post URL (any fediverse/Klonkt post) into a reply target.
// Returns a parent-shaped object usable by deliverReply(), or null.
export async function resolveRemoteNote(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const note = await fetchActor(url).catch(() => null); // AP GET (content-negotiates)
  if (!note || !note.id) return null;
  const att = note.attributedTo;
  const actorUri = typeof att === 'string' ? att : (att && att.id);
  if (!actorUri) return null;
  const actor = await fetchActor(actorUri).catch(() => null);
  const ai = actorInfo(actor, actorUri);
  return {
    object_uri: note.id,
    actor_uri: actorUri,
    actor_url: ai.url,
    actor_handle: ai.handle,
    actor_name: ai.name,
    actor_icon: ai.icon,
    preview: HtmlSanitizerService.toPlainText(note.content || '').slice(0, 240),
  };
}

export default {
  getOrCreateKeys, apWants, sendAP, actorId, noteId,
  buildActor, buildNote, buildCreate, buildOutbox, buildFollowers,
  followerCount, deliver, fetchActor, verifyRequest, handleInbox, deliverCreate, deliverDelete,
  getInteractions, getInteractionById, buildReplyNote, getOutboxNote, deliverReply, resolveRemoteNote,
};
