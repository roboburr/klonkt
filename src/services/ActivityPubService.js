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
import dns from 'dns';
import net from 'net';
import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

// Short random suffix so two activity ids minted in the same millisecond (e.g.
// parallel saves) don't collide and get deduped by a receiver.
const rid = () => crypto.randomBytes(4).toString('hex');

// Keep only http(s) URLs — drops javascript:/data:/etc so a remote actor can't
// smuggle a dangerous scheme into a stored href/src (rendered in owner-only views).
const safeUrl = (u) => { const s = String(u == null ? '' : u).trim(); return /^https?:\/\//i.test(s) ? s : ''; };

// ── SSRF guard for outbound fetches ───────────────────────────────
// Remote URLs (actor/keyId/webfinger/inbox/inReplyTo) are attacker-controlled, so
// every outbound fetch must refuse hosts that resolve to private/loopback ranges
// (cloud metadata, internal services) — on the initial host AND each redirect hop.
function isBlockedIp(ip) {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    return o[0] === 127 || o[0] === 10 || o[0] === 0
      || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
      || (o[0] === 192 && o[1] === 168)
      || (o[0] === 169 && o[1] === 254)
      || (o[0] === 100 && o[1] >= 64 && o[1] <= 127); // CGNAT
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
      || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.')
      || s.startsWith('::ffff:169.254.') || s.startsWith('::ffff:172.');
  }
  return true; // not an IP literal we recognise → refuse
}
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) { if (isBlockedIp(hostname)) throw new Error('ssrf-blocked-ip'); return; }
  const addrs = await dns.promises.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new Error('ssrf-blocked-host');
}
async function safeFetch(url, opts = {}, maxRedirects = 3) {
  let target = url;
  for (let hop = 0; ; hop++) {
    const u = new URL(target); // throws on malformed → caller's catch
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('ssrf-bad-scheme');
    await assertPublicHost(u.hostname);
    const r = await fetch(target, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const loc = (r.status >= 300 && r.status < 400) ? r.headers.get('location') : null;
    if (loc && hop < maxRedirects) { target = new URL(loc, target).toString(); continue; }
    return r;
  }
}
const MAX_OUTBOX = 20;
// Cache-buster for the music listen-link → forces Mastodon to re-crawl a FRESH
// (square) player card. Bump this whenever the twitter:player card dimensions change.
const FEDI_CARD_VER = '2';

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
    featured: `${id}/featured`,
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

// Does a post's audio shortcodes reference at least one PLAYABLE (file-backed)
// track? Link-only tracks (external Spotify/YouTube, media_id NULL) don't count —
// they have no Klonkt-hosted audio to embed, so no player card / cover-suppression.
export function hasPlayableAudio(content, siteId) {
  if (!content || !/\[\[(track|album|playlist):/i.test(content)) return false;
  try {
    for (const m of content.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) { const r = db.prepare('SELECT media_id FROM audio_tracks WHERE id = ?').get(m[1]); if (r && r.media_id) return true; }
    for (const m of content.matchAll(/\[\[album:([^\]]+)\]\]/g)) { if (db.prepare('SELECT 1 FROM audio_tracks WHERE site_id = ? AND album = ? AND media_id IS NOT NULL LIMIT 1').get(siteId, m[1].trim())) return true; }
    for (const m of content.matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) { if (db.prepare('SELECT 1 FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? AND t.media_id IS NOT NULL LIMIT 1').get(m[1])) return true; }
  } catch { /* non-fatal */ }
  return false;
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
  const hadAudio = /\[\[(track|album|playlist):/i.test(post.content || '');
  const playable = hasPlayableAudio(post.content || '', site && site.id);
  const urls = [];
  // Posts with PLAYABLE hosted audio suppress image attachments so Mastodon renders
  // the player CARD (twitter:player) instead of the cover — media attachment and
  // link/player card are mutually exclusive on Mastodon. Link-only audio (external)
  // keeps its cover (no player card to show).
  if (post.cover_image_url && !playable) urls.push(abs(post.cover_image_url));
  let body = post.content || '';
  if (!playable) for (const m of body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) urls.push(abs(m[1]));
  body = body.replace(/<img\b[^>]*>/gi, '');
  // Audio shortcodes: do NOT federate the raw audio file — Klonkt deliberately
  // gates audio (the /audio/stream URL has friction), and shipping it as an AP
  // audio attachment would hand Mastodon a plain, downloadable mp3 URL. Instead,
  // replace the shortcodes with a "🎵 listen on the site" link so the post invites
  // a click-through to the protected player (discovery without leaking the file).
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const audioLabels = [];
  try {
    for (const m of body.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) { const r = db.prepare('SELECT title FROM audio_tracks WHERE id = ?').get(m[1]); if (r && r.title) audioLabels.push(r.title); }
    for (const m of body.matchAll(/\[\[album:([^\]]+)\]\]/g)) audioLabels.push(m[1].trim());
  } catch { /* non-fatal */ }
  body = body.replace(/\[\[(track|album|playlist):[^\]]+\]\]/gi, '');
  // External embeds ([[embed:url]]) → emit the bare URL as a link so Mastodon
  // renders its OWN preview/player card (YouTube/Spotify/SoundCloud/etc) instead
  // of federating the raw shortcode text.
  body = body.replace(/\[\[embed:([^\]]+)\]\]/gi, (mm, raw) => {
    const u = esc(raw.trim().replace(/&amp;/g, '&'));
    return `<p><a href="${u}">${u}</a></p>`;
  });
  if (hadAudio) {
    const lbl = audioLabels.length ? esc(audioLabels.slice(0, 4).join(', ')) : '';
    // For playable posts, append a version param to the listen-link so Mastodon
    // sees a NEW card URL and re-crawls it (fresh SQUARE player card) instead of
    // reusing the cached landscape one. Invisible: the link TEXT stays clean, the
    // page ignores the param. Bump FEDI_CARD_VER when the card dimensions change.
    const listenHref = playable ? `${human}?fc=${FEDI_CARD_VER}` : human;
    body += `<p>🎵 ${lbl ? `<strong>${lbl}</strong> — ` : ''}<a href="${listenHref}">listen on ${esc(site.title || 'the site')}</a></p>`;
  }
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
    replies: `${id}/replies`,
  };
  if (attachment.length) note.attachment = attachment;
  return note;
}

// All reply note URIs on a local post (inbound fediverse replies + our own
// outbound replies) — backs the Note's `replies` Collection so remote servers
// can fetch the whole thread.
export function getReplyUris(base, postId) {
  const out = [];
  try {
    for (const r of db.prepare("SELECT object_uri FROM ap_interactions WHERE kind = 'reply' AND post_id = ? AND object_uri != '' ORDER BY created_at").all(postId)) out.push(r.object_uri);
    for (const r of db.prepare('SELECT id FROM ap_outbox WHERE post_id = ? ORDER BY rowid').all(postId)) out.push(`${base}/ap/notes/${r.id}`);
  } catch { /* non-fatal */ }
  return out;
}

// Notifications "seen" tracking → a real bell badge. Stored per site in app_settings.
export function markNotificationsSeen(slug) {
  try {
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
      .run(`fedi_notif_seen:${slug}`, new Date().toISOString());
  } catch { /* non-fatal */ }
}
export function countUnseenNotifications(slug) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`fedi_notif_seen:${slug}`);
    const seen = row ? Date.parse(row.value) : 0;
    let n = 0;
    for (const it of getNotifications(slug, 50)) { if (Date.parse(it.created_at) > seen) n++; }
    return n;
  } catch { return 0; }
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

// Pinned posts → the actor's `featured` collection. Mastodon reads this and shows
// these as the "Featured" tab (pinned to the profile). Posts come ordered by pin
// rank; embedded as full Notes so a remote server doesn't need extra fetches.
export function buildFeatured(base, site, posts) {
  const id = `${actorId(base, site.slug)}/featured`;
  const items = (posts || []).map((p) => buildNote(base, site, p));
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
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
    _insI = db.prepare('INSERT OR IGNORE INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, parent_uri, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delLA = db.prepare('DELETE FROM ap_interactions WHERE kind = ? AND post_id = ? AND actor_uri = ?');
    _delReply = db.prepare("DELETE FROM ap_interactions WHERE kind = 'reply' AND object_uri = ?");
    _listI = db.prepare('SELECT id, kind, object_uri, parent_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, created_at FROM ap_interactions WHERE post_id = ? ORDER BY created_at ASC');
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
    url: safeUrl((doc && (doc.url || doc.id)) || actorUri) || null,
    icon: safeUrl(icon) || null,
  };
}

// Given an inReplyTo note URL, find which local post the thread belongs to + the
// note being replied to (parent), so a reply-to-a-comment can be nested.
function findThreadTarget(inReplyTo, base) {
  if (!inReplyTo) return null;
  const seg = postIdFromNoteUrl(inReplyTo, base); // our /ap/notes/<id> segment (if ours)
  if (seg && localPostExists(seg)) return { post_id: seg, parent_uri: inReplyTo };
  if (seg) {
    try { const o = db.prepare('SELECT post_id FROM ap_outbox WHERE id = ?').get(seg); if (o && o.post_id) return { post_id: o.post_id, parent_uri: inReplyTo }; } catch { /* ignore */ }
  }
  try { const row = db.prepare("SELECT post_id FROM ap_interactions WHERE object_uri = ? AND kind = 'reply' LIMIT 1").get(inReplyTo); if (row && row.post_id) return { post_id: row.post_id, parent_uri: inReplyTo }; } catch { /* ignore */ }
  return null;
}

// View-ready threaded view of a post's fediverse activity (inbound replies +
// our outbound replies, nested), plus like/boost counts.
export function getInteractions(postId, base, site) {
  const s = iStmts();
  const rows = s.list.all(postId);
  const baseClean = (base || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const postNoteId = baseClean ? `${baseClean}/ap/notes/${postId}` : null;
  // Our own (outbound) replies show the SITE identity for everyone (not "You").
  let host = ''; try { host = new URL(baseClean).host; } catch { /* ignore */ }
  const siteName = (site && (site.title || site.slug)) || '';
  const siteHandle = (site && site.slug && host) ? `@${site.slug}@${host}` : '';
  const siteUrl = baseClean ? `${baseClean}/` : '';
  const siteIcon = (site && site.profile_photo) || null;

  const nodes = [];
  for (const r of rows) {
    if (r.kind !== 'reply') continue;
    nodes.push({
      noteId: r.object_uri, parent: r.parent_uri || null, mine: false, id: r.id,
      actor_name: r.actor_name, actor_handle: r.actor_handle, actor_url: r.actor_url,
      actor_icon: r.actor_icon, content: r.content, created_at: r.published || r.created_at,
      children: [],
    });
  }
  for (const o of s.listO.all(postId)) {
    nodes.push({
      noteId: baseClean ? `${baseClean}/ap/notes/${o.id}` : o.id, parent: o.in_reply_to || null,
      mine: true, outboxId: o.id, content: o.content, created_at: o.created_at,
      actor_name: siteName, actor_handle: siteHandle, actor_url: siteUrl, actor_icon: siteIcon,
      children: [],
    });
  }

  const byId = new Map(nodes.map((n) => [n.noteId, n]));
  const isTop = (n) => !n.parent || n.parent === postNoteId || !byId.has(n.parent);
  const tops = [];
  for (const n of nodes) {
    if (isTop(n)) { tops.push(n); continue; }
    let anc = n, guard = 0;
    while (!isTop(anc) && guard++ < 12) anc = byId.get(anc.parent);
    anc.children.push(n);
  }
  const byTime = (a, b) => new Date(a.created_at) - new Date(b.created_at);
  tops.sort(byTime).forEach((t) => t.children.sort(byTime));

  return {
    thread: tops,
    likeCount: rows.filter((r) => r.kind === 'like').length,
    announceCount: rows.filter((r) => r.kind === 'announce').length,
    total: nodes.length,
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
  const r = await safeFetch(inboxUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/activity+json', Accept: 'application/activity+json', Date: date, Digest: digest, Signature: sig },
    body,
  });
  return r.status;
}

export async function fetchActor(url) {
  try {
    const r = await safeFetch(url, { headers: { Accept: 'application/activity+json' } });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 2_000_000) return null; // refuse oversized actor docs
    return await r.json();
  } catch { return null; }
}

// ── Delivery queue with retries ───────────────────────────────────
// Outbound deliveries are tried immediately; on failure (down server, timeout,
// non-2xx) they're queued and retried with backoff so a briefly-offline follower
// doesn't silently miss the post. The signing key is NOT stored — the worker
// re-derives it from the actor slug at send time.
const DELIVERY_MAX_ATTEMPTS = 6;
const DELIVERY_BACKOFF_MIN = [1, 5, 15, 60, 180, 360];
let _insDeliv, _dueDeliv, _delDeliv, _bumpDeliv;
function deliveryStmts() {
  if (!_insDeliv) {
    _insDeliv = db.prepare('INSERT INTO ap_delivery (slug, inbox, body, attempts, next_at) VALUES (?,?,?,0,CURRENT_TIMESTAMP)');
    _dueDeliv = db.prepare("SELECT * FROM ap_delivery WHERE datetime(next_at) <= datetime('now') ORDER BY next_at LIMIT 30");
    _delDeliv = db.prepare('DELETE FROM ap_delivery WHERE id = ?');
    _bumpDeliv = db.prepare('UPDATE ap_delivery SET attempts = ?, next_at = ? WHERE id = ?');
  }
  return { ins: _insDeliv, due: _dueDeliv, del: _delDeliv, bump: _bumpDeliv };
}
export function enqueueDelivery(slug, inbox, activity) {
  if (!slug || !inbox || !activity) return;
  try { deliveryStmts().ins.run(slug, inbox, JSON.stringify(activity)); } catch { /* ignore */ }
}
// Deliver now; queue for retry if it fails.
export async function deliverWithRetry(slug, inbox, activity, keyId, privPem) {
  if (!inbox) return;
  try { const st = await deliver(inbox, activity, keyId, privPem); if (st >= 200 && st < 300) return; } catch { /* queue below */ }
  enqueueDelivery(slug, inbox, activity);
}
let _processingDeliv = false;
export async function processDeliveryQueue() {
  if (_processingDeliv) return; // re-entrancy guard: 30 rows × 8s can exceed the 60s tick → no double-delivery
  _processingDeliv = true;
  try {
    let rows;
    try { rows = deliveryStmts().due.all(); } catch { return; }
    if (!rows || !rows.length) return;
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    for (const row of rows) {
      let ok = false;
      try {
        const keys = getOrCreateKeys(row.slug);
        const st = await deliver(row.inbox, JSON.parse(row.body), `${actorId(base, row.slug)}#main-key`, keys.private_pem);
        ok = st >= 200 && st < 300;
      } catch { ok = false; }
      if (ok) { deliveryStmts().del.run(row.id); continue; }
      const attempts = row.attempts + 1;
      if (attempts >= DELIVERY_MAX_ATTEMPTS) { deliveryStmts().del.run(row.id); console.warn('[AP] delivery gave up after', attempts, 'tries →', row.inbox); continue; }
      // Index the backoff on the CURRENT attempt count (row.attempts) so the first
      // retry uses the 1-min tier instead of skipping it.
      const mins = DELIVERY_BACKOFF_MIN[Math.min(row.attempts, DELIVERY_BACKOFF_MIN.length - 1)];
      deliveryStmts().bump.run(attempts, new Date(Date.now() + mins * 60000).toISOString(), row.id);
    }
  } finally { _processingDeliv = false; }
}
let _delivTimer = null;
export function startDeliveryWorker() {
  if (_delivTimer) return;
  _delivTimer = setInterval(() => { processDeliveryQueue().catch(() => {}); }, 60 * 1000);
  if (_delivTimer.unref) _delivTimer.unref();
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
  const verified = await verifyRequest(req).catch(() => null);

  // ENFORCE HTTP signatures: a data-affecting activity must be signed by the very
  // actor it claims to be. No valid signature, or signer ≠ actor → reject (no
  // forged replies/likes/follows/timeline posts). GET/discovery stays open.
  const claimedActor = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  // Blocked actor/domain → silently drop (202, don't reveal the block).
  if (claimedActor && isBlockedAny(claimedActor)) { console.log('[AP] inbox dropped (blocked)', claimedActor); return 202; }
  const GATED = ['Create', 'Like', 'Announce', 'Follow', 'Delete', 'Undo', 'Accept', 'Reject', 'Add', 'Remove', 'Update'];
  if (GATED.includes(type)) {
    if (!verified || !claimedActor || verified.id !== claimedActor) {
      console.warn('[AP] inbox REJECTED (signature)', type, claimedActor || '?', verified ? '(signer mismatch)' : '(unsigned/invalid)');
      return 401;
    }
  }

  if (type === 'Follow') {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    const slug = slugParam || slugFromActorUrl(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (!who || !slug) return 400;
    const remote = await fetchActor(who);
    if (!remote || !remote.inbox) return 202; // can't reach them → drop quietly
    const sharedInbox = (remote.endpoints && remote.endpoints.sharedInbox) || null;
    fStmts().ins.run(slug, who, remote.inbox, sharedInbox);
    const me = actorId(base, slug);
    const keys = getOrCreateKeys(slug);
    const accept = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${me}#accept-${Date.now()}-${rid()}`, type: 'Accept', actor: me, object: act };
    deliver(remote.inbox, accept, `${me}#main-key`, keys.private_pem).catch((e) => console.warn('[AP] Accept delivery failed:', e.message));
    // Auto-backfill: send our recent posts as Create so the instance has our history
    // (Mastodon doesn't fetch history on follow). ONCE PER REMOTE INSTANCE only —
    // Mastodon dedupes notes per-instance, so re-filling an instance that already has
    // a follower of ours is wasted work (and won't re-populate the new follower's
    // timeline anyway). Deliver to the shared inbox (instance-level) when present.
    // Sync insert+check (no await between) → no interleave race with concurrent Follows.
    const instanceFilled = sharedInbox &&
      db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND shared_inbox = ? AND actor_uri != ? LIMIT 1')
        .get(slug, sharedInbox, who);
    if (!instanceFilled) {
      backfillNewFollower(base, slug, sharedInbox || remote.inbox).catch(() => { /* best-effort */ });
    }
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
  // Activities from our OWN actors are already stored via ap_outbox — don't re-store.
  const isLocalActor = !!(base && actorUri && actorUri.startsWith(`${base}/ap/users/`));

  // Inbound reply: a Create whose object replies to one of our notes (post OR comment).
  if (type === 'Create' && act.object && (act.object.type === 'Note' || act.object.type === 'Article')) {
    const o = act.object;
    const tgt = findThreadTarget(o.inReplyTo, base);
    if (tgt && actorUri && !isLocalActor) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      const html = HtmlSanitizerService.sanitize(o.content || '');
      iStmts().ins.run('reply', tgt.post_id, o.id || '', actorUri, ai.name, ai.handle, ai.url, ai.icon, html, o.published || null, tgt.parent_uri);
      console.log('[AP] reply', actorUri, '→', tgt.post_id);
      return 202;
    }
    // Home timeline (client): a top-level post from an account we follow.
    if (actorUri && !isLocalActor && !o.inReplyTo && o.id) {
      let subs = []; try { subs = db.prepare('SELECT slug, auto_boost FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist yet */ }
      if (subs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const html = HtmlSanitizerService.sanitize(o.content || '');
        const media = JSON.stringify((Array.isArray(o.attachment) ? o.attachment : []).map((a) => ({ url: safeUrl(a && a.url), type: (a && a.mediaType) || '' })).filter((m) => m.url));
        for (const s of subs) {
          tlStmts().ins.run(o.id, s.slug, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.url || null, o.published || null, media);
          // "Feature an artist": auto-boost (re-Announce) their new posts to our own followers.
          if (s.auto_boost) sendInteraction({ slug: s.slug }, 'boost', o.id, actorUri).catch(() => { /* best-effort */ });
        }
        console.log('[AP] timeline +', actorUri, 'x' + subs.length);
      }
    }
    return 202;
  }
  if (type === 'Like' || type === 'Announce') {
    const tgt = act.object;
    const pid = postIdFromNoteUrl(typeof tgt === 'string' ? tgt : (tgt && tgt.id), base);
    if (pid && actorUri && !isLocalActor && localPostExists(pid)) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      iStmts().ins.run(type.toLowerCase(), pid, '', actorUri, ai.name, ai.handle, ai.url, ai.icon, null, null, null);
      console.log('[AP]', type === 'Like' ? 'like' : 'boost', actorUri, '→', pid);
    }
    return 202;
  }
  if (type === 'Delete') {
    // A remote note was deleted upstream → drop it from replies AND the timeline.
    // Scope to the SIGNING actor so actor B can't delete actor A's content (the
    // signature gate guarantees claimedActor == the verified signer here).
    const oid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    if (oid && claimedActor) {
      try { db.prepare('DELETE FROM ap_interactions WHERE object_uri = ? AND actor_uri = ?').run(oid, claimedActor); } catch { /* ignore */ }
      try { db.prepare('DELETE FROM ap_timeline WHERE id = ? AND author_uri = ?').run(oid, claimedActor); } catch { /* ignore */ }
    }
    return 202;
  }
  // Accept/Reject of a Follow WE sent (client side).
  if (type === 'Accept' && act.object) {
    const fid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    if (fid) { try { fwStmts().acc.run(fid); } catch { /* ignore */ } }
    console.log('[AP] follow accepted', actorUri);
    return 202;
  }
  if (type === 'Reject' && act.object) {
    const who = actorUri;
    if (who && slugParam) { try { fwStmts().del.run(slugParam, who); } catch { /* ignore */ } }
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
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, create, keyId, keys.private_pem);
}

// On a new Follow, send that follower our most recent posts as Create so their
// timeline shows our history (Mastodon does not backfill on follow). Oldest-first
// so they sort into the follower's timeline at their original dates.
async function backfillNewFollower(base, slug, inbox) {
  if (!base || !slug || !inbox) return;
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
  if (!site) return;
  const recent = db.prepare(
    `SELECT id, slug, title, content, cover_image_url, published_at, created_at
     FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20`
  ).all(site.id).reverse();
  if (!recent.length) return;
  const keys = getOrCreateKeys(slug);
  const keyId = `${actorId(base, slug)}#main-key`;
  for (const p of recent) {
    try { await deliver(inbox, buildCreate(base, site, p), keyId, keys.private_pem); } catch { /* best-effort */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log('[AP] backfilled', recent.length, 'posts to new follower of', slug);
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
    id: `${nid}#delete-${Date.now()}-${rid()}`,
    type: 'Delete',
    actor: me,
    to: [PUBLIC],
    object: { id: nid, type: 'Tombstone' },
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, del, `${me}#main-key`, keys.private_pem);
}

// Tell followers an already-published post changed (Update + edited Note) so
// Mastodon refreshes the cached copy (e.g. after fixing content).
export async function deliverUpdate(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !post || !post.id) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const note = buildNote(base, site, post);
  note.updated = new Date().toISOString();
  const update = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${noteId(base, post.id)}#update-${Date.now()}-${rid()}`,
    type: 'Update', actor: me, to: [PUBLIC], cc: [`${me}/followers`],
    object: note,
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, update, `${me}#main-key`, keys.private_pem);
}

// Tell followers the ACTOR changed (Update + Person) so Mastodon re-processes the
// account AND re-fetches the featured (pinned) collection — there is no standard
// "featured changed" activity, so this is how a pin/unpin propagates promptly.
export async function deliverActorUpdate(site) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const update = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id: `${me}#update-${Date.now()}-${rid()}`,
    type: 'Update', actor: me, to: [PUBLIC], cc: [`${me}/followers`],
    object: buildActor(base, site),
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, update, `${me}#main-key`, keys.private_pem);
}

// Reliably set the pinned order on followers' instances via Add/Remove activities
// (how Mastodon itself federates pins) — pushed to the inbox + processed immediately,
// unlike the featured COLLECTION which Mastodon caches with sticky StatusPins.
// Mastodon's Add skips an already-pinned status, so we REMOVE every pin first, wait,
// then ADD in rank-DESCENDING order (rank 1 added LAST → newest StatusPin → shown first,
// because Mastodon displays pins newest-first). `alsoRemove` = ids to unpin too.
export async function resyncFeaturedPins(site, alsoRemove = []) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const keyId = `${me}#main-key`;
  const featured = `${me}/featured`;
  const AS = 'https://www.w3.org/ns/activitystreams';
  const note = (id) => noteId(base, id);
  const pinned = db.prepare(
    `SELECT id FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
       AND pinned IS NOT NULL AND pinned > 0
     ORDER BY pinned DESC, COALESCE(published_at, created_at) ASC LIMIT 20`
  ).all(site.id);
  const removeIds = [...new Set([...pinned.map((p) => p.id), ...alsoRemove])];
  // 1. Remove every current pin so Mastodon can recreate them in order.
  for (const id of removeIds) {
    const rm = { '@context': AS, id: `${me}#rm-${id}-${Date.now()}-${rid()}`, type: 'Remove', actor: me, object: note(id), target: featured, to: [PUBLIC] };
    for (const inbox of inboxes) deliver(inbox, rm, keyId, keys.private_pem).catch(() => { /* best-effort */ });
  }
  if (!pinned.length) { console.log('[AP] unpinned all featured for', site.slug); return; }
  await new Promise((r) => setTimeout(r, 5000)); // let the Removes land first
  // 2. Add in rank-DESC order, gaps so each StatusPin gets an increasing created_at.
  for (const p of pinned) {
    const add = { '@context': AS, id: `${me}#add-${p.id}-${Date.now()}-${rid()}`, type: 'Add', actor: me, object: note(p.id), target: featured, to: [PUBLIC], cc: [`${me}/followers`] };
    for (const inbox of inboxes) deliver(inbox, add, keyId, keys.private_pem).catch(() => { /* best-effort */ });
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('[AP] resynced', pinned.length, 'featured pins for', site.slug);
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
  // Dedup: skip if the exact same reply was already sent (double-submit guard).
  const dup = db.prepare('SELECT 1 FROM ap_outbox WHERE site_slug = ? AND IFNULL(in_reply_to, \'\') = ? AND content = ? LIMIT 1')
    .get(site.slug, parent.object_uri || '', content);
  if (dup) { console.log('[AP] outreply skipped (duplicate)'); return { duplicate: true, delivered: 0 }; }
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
  if (parent.threadInbox) inboxes.add(parent.threadInbox); // back-compat (single)
  (parent.threadInboxes || []).forEach((i) => inboxes.add(i)); // whole ancestor chain
  for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
  inboxes.delete(`${me}/inbox`);       // never deliver to ourselves (already in ap_outbox)
  inboxes.delete(`${base}/ap/inbox`);  // (our own shared inbox) → avoids a self-duplicate
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
  // Is what we're replying to a post (or a comment) on one of OUR posts? If so,
  // link our reply to that local post so it shows nested in the post thread.
  const localTgt = findThreadTarget(note.id, (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''));
  // Walk the WHOLE reply chain upward (comment → parent comment → … → root post)
  // and collect every ancestor author's inbox, so each participant's server —
  // including the original post's author — receives + threads our reply.
  const threadInboxes = [];
  const seenInbox = new Set();
  let cursor = note.inReplyTo, guard = 0;
  while (cursor && guard++ < 6) {
    const url = typeof cursor === 'string' ? cursor : (cursor && cursor.id);
    if (!url) break;
    const pn = await fetchActor(url).catch(() => null);
    if (!pn) break;
    const pa = typeof pn.attributedTo === 'string' ? pn.attributedTo : (pn.attributedTo && pn.attributedTo.id);
    if (pa && pa !== actorUri) {
      const paDoc = await fetchActor(pa).catch(() => null);
      const inbox = paDoc && ((paDoc.endpoints && paDoc.endpoints.sharedInbox) || paDoc.inbox);
      if (inbox && !seenInbox.has(inbox)) { seenInbox.add(inbox); threadInboxes.push(inbox); }
    }
    cursor = pn.inReplyTo; // climb to the next ancestor
  }
  const rawHtml = String(note.content || '').replace(/\[\[(track|album|playlist):[^\]]+\]\]/gi, '');
  const images = (Array.isArray(note.attachment) ? note.attachment : [])
    .filter((a) => a && a.url && (!a.mediaType || /^image\//i.test(a.mediaType)))
    .map((a) => safeUrl(a.url)).filter(Boolean);
  return {
    object_uri: safeUrl(note.id) || note.id,
    actor_uri: actorUri,
    actor_url: ai.url,
    actor_handle: ai.handle,
    actor_name: ai.name,
    actor_icon: ai.icon,
    url: note.url || url,
    content: HtmlSanitizerService.sanitize(rawHtml),       // full, sanitized
    images,
    threadInboxes,                                          // every ancestor author's inbox
    localPostId: localTgt ? localTgt.post_id : '',          // our post this belongs to (if any)
    preview: HtmlSanitizerService.toPlainText(note.content || '').slice(0, 240),
  };
}

// List a site's own outbound fediverse replies (for the manage/delete view).
export function listOutbox(siteSlug) {
  return db.prepare('SELECT id, content, to_handle, in_reply_to, created_at FROM ap_outbox WHERE site_slug = ? ORDER BY created_at DESC').all(siteSlug);
}

// Delete one of our outbound replies: send Delete(Tombstone) to recipients + remove it.
export async function deliverOutboxDelete(site, outboxId) {
  const row = iStmts().getO.get(outboxId);
  if (!row || row.site_slug !== site.slug) return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base) {
    const me = actorId(base, site.slug);
    const nid = noteId(base, row.id);
    const del = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${nid}#delete-${Date.now()}-${rid()}`, type: 'Delete', actor: me, to: [PUBLIC], object: { id: nid, type: 'Tombstone' } };
    const keys = getOrCreateKeys(site.slug);
    const inboxes = new Set();
    if (row.to_actor) { const a = await fetchActor(row.to_actor).catch(() => null); if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox); }
    for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
    for (const inbox of [...inboxes].filter(Boolean)) { try { await deliver(inbox, del, `${me}#main-key`, keys.private_pem); } catch { /* best-effort */ } }
  }
  db.prepare('DELETE FROM ap_outbox WHERE id = ?').run(outboxId);
  return true;
}

// ── Fediverse CLIENT: follow accounts + home timeline ─────────────
// Resolve an @user@domain handle to its actor URL via WebFinger.
export async function webfingerResolve(handle) {
  const h = String(handle || '').trim().replace(/^@/, '');
  const parts = h.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const acct = `${parts[0]}@${parts[1]}`;
  try {
    const r = await safeFetch(`https://${parts[1]}/.well-known/webfinger?resource=acct:${encodeURIComponent(acct)}`,
      { headers: { Accept: 'application/jrd+json, application/json' } });
    if (!r.ok) return null;
    const jrd = await r.json();
    const link = (jrd.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/.test(l.type || ''));
    return safeUrl(link ? link.href : '') || null;
  } catch { return null; }
}

let _insFw, _delFw, _listFw, _accFw, _oneFw, _setAB;
function fwStmts() {
  if (!_insFw) {
    _insFw = db.prepare('INSERT OR REPLACE INTO ap_following (slug, actor_uri, handle, name, icon, url, inbox, follow_id, status, auto_boost, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delFw = db.prepare('DELETE FROM ap_following WHERE slug = ? AND actor_uri = ?');
    _listFw = db.prepare('SELECT * FROM ap_following WHERE slug = ? ORDER BY created_at DESC');
    _accFw = db.prepare("UPDATE ap_following SET status = 'accepted' WHERE follow_id = ?");
    _oneFw = db.prepare('SELECT * FROM ap_following WHERE slug = ? AND actor_uri = ?');
    _setAB = db.prepare('UPDATE ap_following SET auto_boost = ? WHERE slug = ? AND actor_uri = ?');
  }
  return { ins: _insFw, del: _delFw, list: _listFw, acc: _accFw, one: _oneFw, setAB: _setAB };
}
export function listFollowing(slug) { return fwStmts().list.all(slug); }

// Toggle auto-boost ("feature") on an account we already follow.
export function setAutoBoost(slug, actorUri, on) {
  try { fwStmts().setAB.run(on ? 1 : 0, slug, actorUri); } catch { /* ignore */ }
  return { ok: true };
}

let _insTl, _listTl, _delTl;
function tlStmts() {
  if (!_insTl) {
    _insTl = db.prepare('INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, author_handle, author_icon, author_url, content, url, published, media_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listTl = db.prepare('SELECT * FROM ap_timeline WHERE slug = ? ORDER BY COALESCE(published, created_at) DESC LIMIT ?');
    _delTl = db.prepare('DELETE FROM ap_timeline WHERE id = ?');
  }
  return { ins: _insTl, list: _listTl, del: _delTl };
}
export function getTimeline(slug, limit) { return tlStmts().list.all(slug, limit || 50); }

// ── Cirkel = posts from the accounts you auto-boost ("feature an artist") ──
let _abCount, _cirkelPosts, _cirkelMembers;
export function autoBoostCount(slug) {
  try { if (!_abCount) _abCount = db.prepare('SELECT COUNT(*) AS n FROM ap_following WHERE slug = ? AND auto_boost = 1'); return _abCount.get(slug).n; } catch { return 0; }
}
export function getCirkelPosts(slug, limit) {
  try {
    if (!_cirkelPosts) _cirkelPosts = db.prepare(`
      SELECT t.id, t.author_uri, t.author_name, t.author_handle, t.author_icon, t.author_url,
             t.content, t.url, t.published, t.media_json
      FROM ap_timeline t
      JOIN ap_following f ON f.slug = t.slug AND f.actor_uri = t.author_uri AND f.auto_boost = 1
      WHERE t.slug = ?
      ORDER BY COALESCE(t.published, t.created_at) DESC, t.rowid DESC
      LIMIT ?`);
    return _cirkelPosts.all(slug, limit || 60);
  } catch { return []; }
}
export function getCirkelMembers(slug) {
  try { if (!_cirkelMembers) _cirkelMembers = db.prepare('SELECT name, url, icon FROM ap_following WHERE slug = ? AND auto_boost = 1 ORDER BY name'); return _cirkelMembers.all(slug); } catch { return []; }
}

// One-time, best-effort migration of the old Cirkels (pull-protocol circle_links)
// into ActivityPub follows with auto-boost. Runs once per instance at boot so a
// site that updates past the old protocol keeps its cirkel without a manual step.
async function resolveApActor(siteUrl) {
  try {
    const r = await fetch(siteUrl, { headers: { Accept: 'application/activity+json' }, redirect: 'manual' });
    // A Klonkt site's root 302s to /ap/users/<slug> (Location may be relative).
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (loc) return new URL(loc, siteUrl).href; }
    if (r.ok) return siteUrl;
  } catch { /* unreachable */ }
  return null;
}
let _circlesMigrating = false;
export async function autoMigrateCircles() {
  if (_circlesMigrating) return; _circlesMigrating = true;
  try {
    let done; try { done = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('circles_migrated_v1'); } catch { return; }
    if (done && done.value === '1') return;
    let links = [];
    try { links = db.prepare("SELECT cl.remote_url AS url, s.id AS sid, s.slug AS slug FROM circle_links cl JOIN sites s ON s.id = cl.local_site_id WHERE cl.status = 'active'").all(); } catch { /* no legacy table */ }
    let ok = 0;
    for (const l of links) {
      try {
        const actor = await resolveApActor(l.url);
        if (actor) { const r = await followActor({ id: l.sid, slug: l.slug }, actor, true); if (!(r && r.error)) ok++; }
      } catch { /* best-effort per link */ }
    }
    try { db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('circles_migrated_v1', '1'); } catch { /* ignore */ }
    if (links.length) console.log(`[AP] circle migration: ${ok}/${links.length} legacy link(s) -> auto-boost`);
  } catch { /* never block boot */ } finally { _circlesMigrating = false; }
}

// Follow a fediverse account by @handle (WebFinger → actor → signed Follow).
export async function followActor(site, handle, autoBoost = false) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  // Accept either an @user@host handle (WebFinger) or a profile/actor URL directly
  // (the authorize_interaction Follow flow passes a URL).
  const s = String(handle || '').trim();
  const actorUrl = /^https?:\/\//i.test(s) ? (safeUrl(s) || null) : await webfingerResolve(s);
  if (!actorUrl) return { error: 'not_found' };
  const actor = await fetchActor(actorUrl).catch(() => null);
  if (!actor || !actor.id || !actor.inbox) return { error: 'unreachable' };
  const ai = actorInfo(actor, actor.id);
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const followId = `${me}#follow-${Date.now()}-${rid()}`;
  fwStmts().ins.run(site.slug, actor.id, ai.handle, ai.name, ai.icon, ai.url, actor.inbox, followId, 'pending', autoBoost ? 1 : 0);
  const follow = { '@context': 'https://www.w3.org/ns/activitystreams', id: followId, type: 'Follow', actor: me, object: actor.id };
  try { await deliver(actor.inbox, follow, `${me}#main-key`, keys.private_pem); }
  catch (e) { console.warn('[AP] follow deliver failed:', e.message); }
  console.log('[AP] follow', site.slug, '→', actor.id);
  return { ok: true, name: ai.name, handle: ai.handle };
}

// Resolve a profile URL or @handle to a followable remote actor (for the
// authorize_interaction "Follow" flow). Returns display fields + inbox, or null
// when it isn't a reachable actor (e.g. the input was a post, not a profile).
export async function resolveRemoteActor(input) {
  const s = String(input || '').trim();
  const actorUrl = /^https?:\/\//i.test(s) ? (safeUrl(s) || null) : await webfingerResolve(s);
  if (!actorUrl) return null;
  const actor = await fetchActor(actorUrl).catch(() => null);
  if (!actor || !actor.id || !actor.inbox) return null;
  const ai = actorInfo(actor, actor.id);
  return { actor_uri: actor.id, actor_name: ai.name, actor_handle: ai.handle, actor_url: ai.url, actor_icon: ai.icon, inbox: actor.inbox };
}

export async function unfollowActor(site, actorUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const row = fwStmts().one.get(site.slug, actorUri);
  if (row && row.inbox) {
    const undo = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${me}#unfollow-${Date.now()}-${rid()}`, type: 'Undo', actor: me, object: { id: row.follow_id || `${me}#follow`, type: 'Follow', actor: me, object: actorUri } };
    try { await deliver(row.inbox, undo, `${me}#main-key`, keys.private_pem); } catch { /* best-effort */ }
  }
  fwStmts().del.run(site.slug, actorUri);
  return { ok: true };
}

// Send a Like or Announce (boost) on a remote note FROM this site.
export async function sendInteraction(site, kind, targetNoteId, authorUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !targetNoteId) return { error: 'config' };
  const type = kind === 'boost' ? 'Announce' : 'Like';
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const act = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${me}#${type.toLowerCase()}-${Date.now()}-${rid()}`,
    type, actor: me, object: targetNoteId,
  };
  if (type === 'Announce') { act.to = [PUBLIC]; act.cc = [`${me}/followers`]; }
  const inboxes = new Set();
  if (authorUri) { const a = await fetchActor(authorUri).catch(() => null); if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox); }
  // A boost is public → also deliver to our own followers so it shows for them.
  if (type === 'Announce') { for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox); }
  let delivered = 0;
  for (const inbox of [...inboxes].filter(Boolean)) { try { const st = await deliver(inbox, act, `${me}#main-key`, keys.private_pem); if (st >= 200 && st < 300) delivered++; } catch { /* best-effort */ } }
  console.log('[AP]', type, site.slug, '→', targetNoteId, 'delivered', delivered);
  return { ok: true, delivered };
}

// Notifications inbox: new followers + replies/likes/boosts on this site's posts.
export function getNotifications(slug, limit) {
  const out = [];
  try {
    for (const f of db.prepare('SELECT actor_uri, created_at FROM ap_followers WHERE slug = ? ORDER BY created_at DESC LIMIT 50').all(slug)) {
      out.push({ type: 'follow', handle: deriveHandle(f.actor_uri), url: f.actor_uri, created_at: f.created_at });
    }
  } catch { /* ignore */ }
  try {
    const rows = db.prepare(`
      SELECT i.kind, i.actor_name, i.actor_handle, i.actor_url, i.content, i.created_at,
             p.slug AS post_slug, p.title AS post_title
      FROM ap_interactions i LEFT JOIN posts p ON p.id = i.post_id
      WHERE p.site_id = (SELECT id FROM sites WHERE slug = ?)
      ORDER BY i.created_at DESC LIMIT 80
    `).all(slug);
    for (const r of rows) out.push({
      type: r.kind, name: r.actor_name, handle: r.actor_handle, url: r.actor_url,
      content: r.content, post_slug: r.post_slug, post_title: r.post_title, created_at: r.created_at,
    });
  } catch { /* ignore */ }
  out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return out.slice(0, limit || 60);
}

// ── Blocking / defederation ───────────────────────────────────────
let _insBl, _delBl, _listBl;
function blStmts() {
  if (!_insBl) {
    _insBl = db.prepare('INSERT OR IGNORE INTO ap_blocks (slug, target, kind, label, created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)');
    _delBl = db.prepare('DELETE FROM ap_blocks WHERE slug = ? AND target = ?');
    _listBl = db.prepare('SELECT * FROM ap_blocks WHERE slug = ? ORDER BY created_at DESC');
  }
  return { ins: _insBl, del: _delBl, list: _listBl };
}
export function listBlocks(slug) { return blStmts().list.all(slug); }

// True if an actor (or its whole domain) is blocked anywhere on this instance.
export function isBlockedAny(actorUri) {
  if (!actorUri) return false;
  let domain = ''; try { domain = new URL(actorUri).host; } catch { /* ignore */ }
  try { return !!db.prepare("SELECT 1 FROM ap_blocks WHERE (kind='actor' AND target=?) OR (kind='domain' AND target=?) LIMIT 1").get(actorUri, domain); }
  catch { return false; }
}

function purgeBlocked(kind, target) {
  try {
    if (kind === 'domain') {
      const like = `%//${target}/%`;
      db.prepare('DELETE FROM ap_interactions WHERE actor_uri LIKE ?').run(like);
      db.prepare('DELETE FROM ap_timeline WHERE author_uri LIKE ?').run(like);
      db.prepare('DELETE FROM ap_followers WHERE actor_uri LIKE ?').run(like);
    } else {
      db.prepare('DELETE FROM ap_interactions WHERE actor_uri = ?').run(target);
      db.prepare('DELETE FROM ap_timeline WHERE author_uri = ?').run(target);
      db.prepare('DELETE FROM ap_followers WHERE actor_uri = ?').run(target);
    }
  } catch { /* best-effort */ }
}

// Block an actor (@handle or actor URL) or a whole domain; purges their content.
export async function blockTarget(site, input) {
  const raw = String(input || '').trim();
  if (!site || !site.slug || !raw) return { error: 'empty' };
  let kind, target, label;
  if (/^https?:\/\//i.test(raw)) { kind = 'actor'; target = raw; label = raw; }
  else if (raw.includes('@')) {
    const actorUrl = await webfingerResolve(raw);
    if (!actorUrl) return { error: 'not_found' };
    kind = 'actor'; target = actorUrl; label = raw.startsWith('@') ? raw : ('@' + raw);
  } else { kind = 'domain'; target = raw.toLowerCase(); label = raw.toLowerCase(); }
  blStmts().ins.run(site.slug, target, kind, label);
  purgeBlocked(kind, target);
  console.log('[AP] block', site.slug, kind, target);
  return { ok: true, label };
}

export function unblock(site, target) { blStmts().del.run(site.slug, target); return { ok: true }; }

export default {
  getOrCreateKeys, apWants, sendAP, actorId, noteId,
  buildActor, buildNote, buildCreate, buildOutbox, buildFollowers, buildFeatured,
  followerCount, deliver, fetchActor, verifyRequest, handleInbox, deliverCreate, deliverDelete, deliverUpdate, deliverActorUpdate, resyncFeaturedPins,
  getInteractions, getInteractionById, buildReplyNote, getOutboxNote, deliverReply, resolveRemoteNote,
  listOutbox, deliverOutboxDelete,
  webfingerResolve, followActor, resolveRemoteActor, unfollowActor, listFollowing, setAutoBoost, getTimeline, sendInteraction,
  autoBoostCount, getCirkelPosts, getCirkelMembers, autoMigrateCircles,
  getNotifications, listBlocks, isBlockedAny, blockTarget, unblock,
  deliverWithRetry, enqueueDelivery, processDeliveryQueue, startDeliveryWorker,
  getReplyUris, markNotificationsSeen, countUnseenNotifications, hasPlayableAudio,
};
