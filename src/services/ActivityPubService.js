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
import AudioEmbedService from './AudioEmbedService.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
// Full JSON-LD context for every AP object we emit: AS2 core + security (publicKey) + the
// extension terms we actually use (Mastodon/toot + schema.org), each with a term definition
// so a strict JSON-LD processor resolves them instead of dropping them → valid AS2/JSON-LD.
// This is the same context shape Mastodon publishes, so Mastodon sees no change.
const AP_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    toot: 'http://joinmastodon.org/ns#',
    schema: 'http://schema.org#',
    sensitive: 'as:sensitive',
    Hashtag: 'as:Hashtag',
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
    discoverable: 'toot:discoverable',
    featured: { '@id': 'toot:featured', '@type': '@id' },
    PropertyValue: 'schema:PropertyValue',
    value: 'schema:value',
    embedUrl: { '@id': 'schema:embedUrl', '@type': '@id' },
    // Poll (Question) extension: Question/oneOf/anyOf/endTime/closed are AS2 core, but the
    // per-poll unique-voter count is a Mastodon (toot) term — declare it so the emitted
    // Question stays valid JSON-LD (a strict processor would otherwise drop votersCount).
    votersCount: 'toot:votersCount',
    // FEP-633c (Guardians): the shaer namespace. helpRequest marks a direct
    // note as a ward's call for help (spec 5.2.1); ignorable by everyone else.
    shaer: 'https://ns.klonkt.com/shaer#',
  },
];

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
export async function safeFetch(url, opts = {}, maxRedirects = 3) {
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
    '@context': AP_CONTEXT,
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
    following: `${id}/following`,
    featured: `${id}/featured`,
    // C2S clients (Shaer apps) discover auth + upload here — no hardcoded paths.
    // All four are ActivityPub-spec `endpoints` terms. Dynamic client registration
    // (RFC 7591) is discovered via /.well-known/oauth-authorization-server, not here.
    endpoints: {
      sharedInbox: `${base}/ap/inbox`,
      oauthAuthorizationEndpoint: `${base}/oauth/authorize`,
      oauthTokenEndpoint: `${base}/oauth/token`,
      uploadMedia: `${id}/uploadMedia`,
    },
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
  // Account creation date — shown by Mastodon + read by indexers (additive, standard AS2).
  if (site.created_at) { try { actor.published = new Date(site.created_at).toISOString(); } catch { /* skip bad date */ } }
  // Profile links → PropertyValue rows: Mastodon/PeerTube/WordPress-ActivityPub render these as
  // profile metadata (rel=me enables link-back verification). Additive; ignored by simpler receivers.
  try {
    const links = JSON.parse(site.profile_links || '[]');
    if (Array.isArray(links) && links.length) {
      const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      const rows = links
        .filter((l) => l && l.url && /^https?:/i.test(l.url))
        .map((l) => ({
          type: 'PropertyValue',
          name: esc(l.platform || 'Link'),
          value: `<a href="${esc(l.url).replace(/"/g, '&quot;')}" rel="me nofollow noopener" target="_blank">${esc(String(l.url).replace(/^https?:\/\//, ''))}</a>`,
        }));
      if (rows.length) actor.attachment = rows;
    }
  } catch { /* skip malformed profile_links */ }
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
export function buildNote(base, site, post, opts = {}) {
  // Replies are Notes too. buildNote is the single entry point for ALL Notes; a reply is
  // (for now) the simple flavor: pre-baked content, no title/cover/image/audio/embed
  // machinery, addressed to the parent actor + thread. This early branch keeps that output
  // byte-identical to the old buildReplyNote. When rich replies land (images/audio/embeds),
  // this branch collapses and replies flow through the full post pipeline below. `post` here
  // is the ap_outbox reply row (id, in_reply_to, content, post_slug, created_at, to_actor).
  if (opts.isReply) {
    const meR = actorId(base, site.slug);
    // Rich replies: attachments column (JSON [{url, mediaType, name}]) → AS2
    // attachment array with absolute URLs and the matching object type.
    let replyAtt;
    try {
      const list = post.attachments ? JSON.parse(post.attachments) : [];
      if (Array.isArray(list) && list.length) {
        replyAtt = list.map((a) => ({
          type: a.mediaType.startsWith('image/') ? 'Image' : a.mediaType.startsWith('audio/') ? 'Audio' : 'Video',
          mediaType: a.mediaType,
          url: /^https?:/i.test(a.url) ? a.url : `${base}${a.url}`,
          name: a.name || undefined,
        }));
      }
    } catch { /* malformed attachments never block the Note */ }
    return {
      id: noteId(base, post.id),
      type: 'Note',
      attributedTo: meR,
      inReplyTo: post.in_reply_to || undefined,
      content: post.content,
      // Reply language (rich replies): the AS2 language map next to `content`.
      contentMap: post.language ? { [post.language]: post.content } : undefined,
      attachment: replyAtt,
      url: post.post_slug ? `${base}/${encodeURIComponent(post.post_slug)}` : undefined,
      published: toISO(post.created_at),
      // A direct note (private mention, shaer-tqc) addresses ONLY its
      // recipients: no Public anywhere, so it cannot be boosted and never
      // shows in public timelines (the Mastodon DM model).
      to: post.visibility === 'direct'
        ? (JSON.parse(post.to_actors || '[]'))
        : (post.to_actor ? [post.to_actor] : [PUBLIC]),
      cc: post.visibility === 'direct' ? [] : [PUBLIC, `${meR}/followers`],
      // FEP-633c 5.2.1: a ward's call for help. Only ever on direct notes.
      'shaer:helpRequest': (post.visibility === 'direct' && post.help_request) ? true : undefined,
      tag: [
        ...mentionTags(post.content),
        ...hashtagTags(base, post.content),
      ],
    };
  }
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
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' })[(e || '').toLowerCase()] || 'image/jpeg';
  };
  const hadAudio = /\[\[(track|album|playlist):/i.test(post.content || '');
  const playable = hasPlayableAudio(post.content || '', site && site.id);
  // A post with an external embed (Spotify/YouTube/SoundCloud/Vimeo/Bandcamp/Apple) should let
  // Mastodon render the embed's player CARD. Mastodon shows EITHER media attachments OR a link
  // card, never both — so when the post has an embed link we skip the image attachments so the
  // card wins. (On Klonkt nothing changes: the cover + the embed player still render.)
  const hasEmbed = (() => {
    const c = post.content || '';
    if (/\[\[embed:/i.test(c)) return true;
    for (const m of c.matchAll(/https?:\/\/[^\s"'<>]+/gi)) if (AudioEmbedService.detectProvider(m[0])) return true;
    return false;
  })();
  // Link-only tracks (external Spotify/YouTube/SoundCloud, no hosted file): collect their links
  // so we federate them — Mastodon cards the first (its player), the rest show as clickable links
  // — instead of a bare "listen on site" link, and we suppress the cover so the card can show.
  const trackEmbedLinks = (() => {
    if (playable) return [];
    const out = [];
    try {
      for (const m of (post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) {
        const r = db.prepare('SELECT media_id, link_spotify, link_youtube, link_soundcloud FROM audio_tracks WHERE id = ?').get(m[1]);
        if (r && !r.media_id) for (const u of [r.link_spotify, r.link_youtube, r.link_soundcloud]) if (u && /^https?:\/\//i.test(u)) out.push(u);
      }
    } catch { /* non-fatal */ }
    return [...new Set(out)].slice(0, 6);
  })();
  const noImages = playable || hasEmbed || trackEmbedLinks.length > 0; // suppress images → let the player/embed card show
  const urls = [];
  // Posts with PLAYABLE hosted audio suppress image attachments so Mastodon renders
  // the player CARD (twitter:player) instead of the cover — media attachment and
  // link/player card are mutually exclusive on Mastodon. Link-only audio (external)
  // keeps its cover (no player card to show).
  // An animated cover federates as the muted loop MP4 (→ a Video attachment): animated WebP is
  // unreliable on Mastodon and its iOS apps; the MP4 plays everywhere. Else the still cover image.
  // Each entry carries the media URL + its alt text (federated as the AS2 attachment `name`, for a11y).
  if (post.cover_video_url && !noImages) urls.push({ url: abs(post.cover_video_url), name: post.cover_alt || '' });
  else if (post.cover_image_url && !noImages) urls.push({ url: abs(post.cover_image_url), name: post.cover_alt || '' });
  let body = post.content || '';
  // Only federate inline images we can actually serve: absolute http(s) URLs, or our own
  // /media/ uploads. A relative path we don't host (e.g. a stale /images/... ref) would 404
  // and show up as a black tile in Mastodon's attachment grid. Carry the <img alt="…"> through
  // as the attachment description.
  if (!noImages) for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\bsrc="([^"]+)"/i) || [])[1];
    if (!src || !(/^https?:\/\//i.test(src) || src.startsWith('/media/'))) continue;
    const alt = (tag.match(/\balt="([^"]*)"/i) || [])[1] || '';
    urls.push({ url: abs(src), name: alt });
  }
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
  // fedi_open tracks → real AS2 Audio attachments (the actual file URL, served ungated) so
  // EVERY client incl. the Mastodon apps plays them inline natively. Gated tracks (default)
  // stay link/card-only — the file is never exposed for them. Resolve from post.content so a
  // later body mutation can't affect it.
  const openAudio = [];
  if (hadAudio) {
    const seenA = new Set();
    const addRow = (r) => {
      const fn = r.filename || (r.storage_path || '').split('/').pop();
      if (!fn || seenA.has(fn)) return; seenA.add(fn);
      const a = { type: 'Audio', mediaType: r.mime_type || 'audio/mpeg', url: `${base}/audio/stream/${encodeURIComponent(fn)}`, name: r.title || 'Audio' };
      // Cover art on the Audio attachment (AS2 `icon`): track cover, else the post cover.
      // Mastodon renders it as the artwork thumbnail on its native audio player.
      const art = abs(r.cover_url || post.cover_image_url || null);
      if (art) a.icon = { type: 'Image', mediaType: mediaType(art), url: art };
      openAudio.push(a);
    };
    const SEL = 'SELECT t.title, t.cover_url, m.filename, m.storage_path, m.mime_type FROM audio_tracks t JOIN media m ON m.id = t.media_id WHERE t.fedi_open = 1 AND ';
    try {
      for (const mm of (post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) { const r = db.prepare(SEL + 't.id = ?').get(mm[1]); if (r) addRow(r); }
      for (const mm of (post.content || '').matchAll(/\[\[album:([^\]]+)\]\]/g)) for (const r of db.prepare(SEL + 't.site_id = ? AND t.album = ? ORDER BY t.rowid').all(site.id, mm[1].trim())) addRow(r);
      for (const mm of (post.content || '').matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) for (const r of db.prepare('SELECT t.title, t.cover_url, m.filename, m.storage_path, m.mime_type FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id JOIN media m ON m.id = t.media_id WHERE t.fedi_open = 1 AND pt.playlist_id = ? ORDER BY pt.position').all(mm[1])) addRow(r);
    } catch { /* non-fatal */ }
  }
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
    if (trackEmbedLinks.length) {
      // Link-only track(s): emit the external link(s). Mastodon cards the first (Spotify → its
      // player), the rest render as clickable links — the fediverse-native "embed + links".
      body += `<p>🎵 ${lbl ? `<strong>${lbl}</strong>` : ''}</p>`;
      for (const u of trackEmbedLinks) { const eu = esc(u); body += `<p><a href="${eu}">${eu}</a></p>`; }
    } else {
      // For playable posts, append a version param to the listen-link so Mastodon
      // sees a NEW card URL and re-crawls it (fresh SQUARE player card) instead of
      // reusing the cached landscape one. Invisible: the link TEXT stays clean, the
      // page ignores the param. Bump FEDI_CARD_VER when the card dimensions change.
      const listenHref = playable ? `${human}?fc=${FEDI_CARD_VER}` : human;
      body += `<p>🎵 ${lbl ? `<strong>${lbl}</strong> — ` : ''}<a href="${listenHref}">listen on ${esc(site.title || 'the site')}</a></p>`;
    }
  }
  // Klonkt renders post content with white-space:pre-wrap, so raw newlines ARE line
  // breaks on the site. Mastodon (plain HTML) collapses whitespace and would drop them,
  // so convert newlines to <br> for the federated copy (content already made with
  // shift+enter uses <br> and has no \n → this is a no-op there).
  body = body.replace(/\r?\n/g, '<br>');
  body = linkHashtags(base, body); // link inline #hashtags in the post body too
  body = linkUrls(body);           // bare URLs → clickable links on the federated copy
  // Append the tags-field hashtags to the content so Mastodon renders them as clickable
  // hashtags (a Hashtag that's only in the `tag` array isn't shown inline). CamelCase
  // multi-word tags; skip any already present inline in the body.
  {
    const inlineTags = new Set(hashtagTags(base, body).map((h) => h.name.slice(1).toLowerCase()));
    const addSeen = new Set();
    const tagLinks = normalizeTags(post.tags).map(tagParts).filter(Boolean)
      .filter((p) => !inlineTags.has(p.slug) && !addSeen.has(p.slug) && addSeen.add(p.slug))
      .map((p) => `<a href="${base}/tag/${encodeURIComponent(p.slug)}" class="mention hashtag" rel="tag">#${p.label}</a>`);
    if (tagLinks.length) body += `<p>${tagLinks.join(' ')}</p>`;
  }
  const seen = new Set();
  const attachment = urls.filter((x) => x && x.url)
    .filter((x) => { if (seen.has(x.url)) return false; seen.add(x.url); return true; })
    .map((x) => { const mt = mediaType(x.url); // specific AS2 subtype (Image/Audio/Video) over generic Document
      const ty = /^image\//i.test(mt) ? 'Image' : /^video\//i.test(mt) ? 'Video' : /^audio\//i.test(mt) ? 'Audio' : 'Document';
      const a = { type: ty, mediaType: mt, url: x.url };
      if (x.name) a.name = String(x.name).slice(0, 1500); // alt text / description (AS2 `name`)
      return a; });
  for (const a of openAudio) attachment.push(a); // fedi_open tracks → native Audio players

  // Inline @user@host mentions: the Mention tag objects + the mentioned actor URIs. Only
  // present when the content was already mention-linked (deliverCreate/Update resolve them
  // at send time); a plain buildNote (outbox/notes) yields none.
  const _mentionTags = mentionTags(body);
  const _mentionCc = _mentionTags.map((t) => t.href);

  const note = {
    id,
    type: 'Note',
    attributedTo: aId,
    content: titleHtml + body,
    url: human,
    published: new Date(post.published_at || post.created_at || Date.now()).toISOString(),
    // fan_only = "fans only" → followers-only visibility (delivered to your followers
    // but not addressed to Public, so Mastodon shows it only to them and can't boost it).
    to: (post.fan_only || post.ap_visibility === 'quiet') ? [`${aId}/followers`] : [PUBLIC],
    // Mentioned actors (from inline @user@host links the caller resolved) are addressed in cc
    // so Mastodon notifies them; empty unless the content was mention-linked (delivery time).
    cc: [...new Set([
      ...(post.ap_visibility === 'quiet' ? [PUBLIC] : []),          // quiet public: Public in cc, not to
      ...((post.fan_only || post.ap_visibility === 'quiet') ? [] : [`${aId}/followers`]),
      ..._mentionCc])],
    tag: [...buildHashtagList(base, post.tags, body), ..._mentionTags],
    replies: `${id}/replies`,
    // NSFW → Mastodon-style content warning: sensitive (blurs media) + a summary/spoiler
    // (hides the whole post behind a "Gevoelige inhoud" button until the reader opens it).
    sensitive: !!post.nsfw,
  };
  if (post.nsfw) note.summary = post.content_warning || 'Gevoelige inhoud';
  if (attachment.length) note.attachment = attachment;
  // When the cover attachment is suppressed (hosted audio OR an external embed/link-only track →
  // so Mastodon shows the player/link card, not media), still expose the cover via AS2 `image` so
  // card/grid consumers (the Klonkt Cirkel/News feed) can show it. Mastodon ignores a Note's
  // `image`, so its card is unaffected — but a Klonkt receiver reads it (handleInbox o.image).
  if (post.cover_image_url && noImages) {
    const cov = abs(post.cover_image_url);
    if (cov) { note.image = { type: 'Image', mediaType: mediaType(cov), url: cov }; if (post.cover_alt) note.image.name = String(post.cover_alt).slice(0, 1500); }
  }
  // Experiment (mirrors PeerTube / schema.org `embedUrl`): point at the GATED player page
  // (/embed) so a client that honours embedUrl can show an inline player WITHOUT ever
  // getting the audio file — the anti-steal posture is untouched. `embedUrl` is a real
  // standard field name (not a Klonkt invention); if Mastodon's apps honour it on a Note we
  // make it JSON-LD-clean with a context term, otherwise it degrades to the player card.
  if (playable) note.embedUrl = `${base}/embed?post=${encodeURIComponent(post.slug)}`;
  // Content language → AS2 contentMap (a BCP-47-keyed copy of the content). Mastodon reads the
  // language from its key for the timeline language filter + the translate button. Emitted
  // alongside `content` (Mastodon sends both); a plain receiver just uses `content`.
  if (post.language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(post.language)) note.contentMap = { [post.language]: note.content };
  // A hosted poll → federate as an AS2 Question (options + live tally). Do this last so it
  // reuses the note's content/addressing/tags, then swaps the type and strips media.
  const ownPoll = parseOwnPoll(post.poll_json);
  if (ownPoll) applyPollToNote(note, post.id, ownPoll);
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
// The seen-watermark itself (ms epoch, 0 = never marked) — the Messages page reads it
// BEFORE marking seen, so it can render unread dots on the items newer than last visit.
export function notificationsSeenAt(slug) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`fedi_notif_seen:${slug}`);
    return row ? (Date.parse(row.value) || 0) : 0;
  } catch { return 0; }
}

// Messages = the unified inbox (Reacties + Meldingen merged, decision Robin+Bart 2026-07-16):
// every notification PLUS your own outbound replies ('sent', with edit/delete via their
// outboxId), sorted as one stream. Consecutive likes/boosts on the same post collapse into
// one grouped item (actors list + count) so activity doesn't drown out conversations.
export function getMessages(slug, limit, offset) {
  const off = Math.max(0, offset || 0);
  const lim = limit || 60;
  // The stream is grouped (consecutive likes/boosts collapse), so paging is done by
  // recomputing the whole stream top-down and slicing [off, off+lim] — stable across
  // pages. Fetch a buffer past off+lim so grouping-shrinkage can't hide a full page.
  const need = off + lim + 100;
  const items = getNotifications(slug, need);
  try {
    for (const m of listOutbox(slug).slice(0, need)) {
      items.push({
        type: 'sent', outboxId: m.id, to_handle: m.to_handle, in_reply_to: m.in_reply_to,
        content: m.content, editable: m.editable, language: m.language, created_at: m.created_at,
      });
    }
  } catch { /* ignore */ }
  items.sort((a, b) => _msgTs(b) - _msgTs(a)); // NaN-safe (zie getNotifications)
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if ((it.type === 'like' || it.type === 'announce') && prev && prev.type === it.type
        && prev.post_slug === it.post_slug) {
      prev.actors = prev.actors || [prev.name || prev.handle || '?'];
      prev.actors.push(it.name || it.handle || '?');
      prev.count = (prev.count || 1) + 1;
      continue;
    }
    out.push(it);
  }
  return out.slice(off, off + lim);
}

export function buildCreate(base, site, post) {
  const note = buildNote(base, site, post);
  return {
    '@context': AP_CONTEXT,
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
    '@context': AP_CONTEXT,
    id,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  };
}

// Public callers get a count-only collection (privacy). The authenticated
// account owner (a C2S bearer scoped to this site) gets the real actor URIs via
// `items`, so their own client can build a friends list.
export function buildFollowers(base, site, count, items = null) {
  const id = `${actorId(base, site.slug)}/followers`;
  return {
    '@context': AP_CONTEXT,
    id,
    type: 'OrderedCollection',
    totalItems: items ? items.length : (count || 0),
    orderedItems: items || [], // count-only for the public; full for the owner
  };
}

// The accounts this site follows — count only, mirroring buildFollowers. The spec lists
// `following` as a standard actor property; Hubzilla/Friendica + crawlers expect it.
export function buildFollowing(base, site, count, items = null) {
  const id = `${actorId(base, site.slug)}/following`;
  return {
    '@context': AP_CONTEXT,
    id,
    type: 'OrderedCollection',
    totalItems: items ? items.length : (count || 0),
    orderedItems: items || [], // count-only for the public; full for the owner
  };
}

// Pinned posts → the actor's `featured` collection. Mastodon reads this and shows
// these as the "Featured" tab (pinned to the profile). Posts come ordered by pin
// rank; embedded as full Notes so a remote server doesn't need extra fetches.
export function buildFeatured(base, site, posts) {
  const id = `${actorId(base, site.slug)}/featured`;
  const items = (posts || []).map((p) => buildNote(base, site, p));
  return {
    '@context': AP_CONTEXT,
    id,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  };
}

// ── followers store (lazy stmts) ──────────────────────────────────
let _insF, _updFDisp, _delF, _listF, _cntF;
function fStmts() {
  if (!_insF) {
    _insF = db.prepare('INSERT OR IGNORE INTO ap_followers (slug, actor_uri, inbox, shared_inbox, name, handle, icon, created_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _updFDisp = db.prepare('UPDATE ap_followers SET name = COALESCE(?, name), handle = COALESCE(?, handle), icon = COALESCE(?, icon) WHERE slug = ? AND actor_uri = ?');
    _delF = db.prepare('DELETE FROM ap_followers WHERE slug = ? AND actor_uri = ?');
    _listF = db.prepare('SELECT inbox, shared_inbox FROM ap_followers WHERE slug = ?');
    _cntF = db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ?');
  }
  return { ins: _insF, del: _delF, list: _listF, cnt: _cntF };
}
export function followerCount(slug) { return fStmts().cnt.get(slug).n; }

// Followers with delivery health, for the management list. Never-delivered accounts
// first, then oldest successful delivery first — i.e. the cleanup candidates on top.
export function listFollowers(slug) {
  return db.prepare(
    `SELECT id, actor_uri, inbox, shared_inbox, created_at, last_delivery_at, last_error_at
     FROM ap_followers WHERE slug = ?
     ORDER BY (last_delivery_at IS NULL) DESC, last_delivery_at ASC, created_at ASC`
  ).all(slug);
}
// Manually drop a follower after a check (a still-live account would have to re-follow).
export function removeFollower(slug, id) {
  const info = db.prepare('DELETE FROM ap_followers WHERE slug = ? AND id = ?').run(slug, id);
  return info.changes > 0;
}

// Best cached display for an actor URI, across the caches Klonkt already fills:
// followers (now with name/icon), following, interactions, timeline, mentions.
// Falls back to a handle derived from the URI. Display info is not sensitive.
export function actorDisplay(slug, uri) {
  const ok = (r) => r && (r.name || r.icon);
  try {
    let r = db.prepare('SELECT name, handle, icon FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(slug, uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT name, handle, icon FROM ap_following WHERE slug = ? AND actor_uri = ?').get(slug, uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT actor_name AS name, actor_handle AS handle, actor_icon AS icon FROM ap_interactions WHERE actor_uri = ? AND (actor_name IS NOT NULL OR actor_icon IS NOT NULL) ORDER BY created_at DESC LIMIT 1').get(uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT author_name AS name, author_handle AS handle, author_icon AS icon FROM ap_timeline WHERE author_uri = ? AND (author_name IS NOT NULL OR author_icon IS NOT NULL) LIMIT 1').get(uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT actor_name AS name, actor_handle AS handle, actor_icon AS icon FROM ap_mentions WHERE actor_uri = ? AND (actor_name IS NOT NULL OR actor_icon IS NOT NULL) ORDER BY created_at DESC LIMIT 1').get(uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
  } catch { /* ignore */ }
  return { name: null, handle: deriveHandle(uri), icon: null };
}

// FEP-9876: does this `Prefer` header ask for enriched (embedded) members?
// Pure and testable; the route sets the response headers around it.
export function prefersEnriched(preferHeader) {
  return /(^|[,;\s])return=representation($|[,;\s])/i.test(String(preferHeader || ''));
}

// AS2 actor reference with display, for the owner C2S followers/following view.
// preferredUsername = the local part of the handle; name = the set display name.
export function buildActorRef(slug, uri) {
  const d = actorDisplay(slug, uri);
  const user = d.handle && d.handle[0] === '@' ? d.handle.slice(1).split('@')[0] : null;
  const out = { id: uri, type: 'Person' };
  if (d.name) out.name = d.name;
  if (user) out.preferredUsername = user;
  if (d.icon) out.icon = { type: 'Image', url: d.icon };
  return out;
}

// Merge who-you-follow (ap_following, rich display) with who-follows-you (ap_followers,
// delivery health) into ONE connections list, keyed by actor_uri. Each entry gets a
// direction (following →, follower ←, mutual ↔) and, for accounts we deliver to, an
// `unreachable` flag (never delivered, or last attempt failed after the last success) so
// the view can split dead connections into their own section. Powers the Connect page.
export function listConnections(slug) {
  const byUri = new Map();
  for (const f of listFollowing(slug)) {
    byUri.set(f.actor_uri, {
      actor_uri: f.actor_uri, name: f.name || null, handle: f.handle || null,
      icon: f.icon || null, url: f.url || null, auto_boost: f.auto_boost ? 1 : 0,
      status: f.status || null, following: true, follower: false,
      last_delivery_at: null, last_error_at: null, follower_id: null,
    });
  }
  for (const fo of listFollowers(slug)) {
    const e = byUri.get(fo.actor_uri);
    if (e) { e.follower = true; e.last_delivery_at = fo.last_delivery_at; e.last_error_at = fo.last_error_at; e.follower_id = fo.id; }
    else byUri.set(fo.actor_uri, {
      actor_uri: fo.actor_uri, name: null, handle: null, icon: null, url: null,
      auto_boost: 0, status: null, following: false, follower: true,
      last_delivery_at: fo.last_delivery_at, last_error_at: fo.last_error_at, follower_id: fo.id,
    });
  }
  return [...byUri.values()].map((e) => {
    e.direction = (e.following && e.follower) ? 'mutual' : (e.following ? 'following' : 'follower');
    e.unreachable = e.follower && (!e.last_delivery_at || (!!e.last_error_at && (!e.last_delivery_at || e.last_error_at > e.last_delivery_at)));
    return e;
  });
}

// ── inbound interactions store (replies / likes / boosts) + our outbound replies ──
let _insI, _delLA, _delReply, _listI, _getI, _insO, _listO, _getO;
// ── moderation tombstones (ap_rejected_objects) ───────────────────
// A reply the owner removed stays removed: its object URI is tombstoned and
// checked at ingest AND by the thread-crawler (else thread-filling would
// re-fetch it). Owner moderation acts on the LOCAL copy, so it also works for
// private notes that authorize_interaction can't fetch (401/404).
let _insRj, _hasRj;
function rjStmts() {
  if (!_insRj) {
    _insRj = db.prepare('INSERT OR IGNORE INTO ap_rejected_objects (object_uri, post_id, reason) VALUES (?,?,?)');
    _hasRj = db.prepare('SELECT 1 FROM ap_rejected_objects WHERE object_uri = ?');
  }
  return { ins: _insRj, has: _hasRj };
}
export function isRejectedObject(uri) {
  if (!uri) return false;
  try { return !!rjStmts().has.get(String(uri)); } catch { return false; }
}
// Owner removes an incoming reply: tombstone + delete. Tenancy-scoped: the
// interaction's post must belong to the caller's site.
export function rejectInteraction(site, interactionId, reason) {
  if (!site || !site.slug) return { error: 'forbidden' };
  const row = iStmts().getI.get(interactionId);
  if (!row) return { error: 'not_found' };
  const owns = db.prepare('SELECT 1 FROM posts WHERE id = ? AND site_id = (SELECT id FROM sites WHERE slug = ?)')
    .get(row.post_id, site.slug);
  if (!owns) return { error: 'forbidden' };
  if (row.object_uri) { try { rjStmts().ins.run(row.object_uri, row.post_id, reason || 'removed by site owner'); } catch { /* non-fatal */ } }
  db.prepare('DELETE FROM ap_interactions WHERE id = ?').run(interactionId);
  console.log('[AP] interaction removed by owner', site.slug, row.object_uri || row.actor_uri);
  return { ok: true, object_uri: row.object_uri || null, actor_uri: row.actor_uri || null };
}
// Stored URIs of an interaction (tenancy-scoped) → feed sendReport for flagging
// from the local copy (works for private notes; no remote fetch needed to target).
export function interactionReportTarget(site, interactionId) {
  if (!site || !site.slug) return null;
  const row = iStmts().getI.get(interactionId);
  if (!row) return null;
  const owns = db.prepare('SELECT 1 FROM posts WHERE id = ? AND site_id = (SELECT id FROM sites WHERE slug = ?)')
    .get(row.post_id, site.slug);
  if (!owns) return null;
  return { objectUri: row.object_uri || null, actorUri: row.actor_uri || null };
}

// AP addressing → visibility: 'public' | 'unlisted' | 'followers' | 'direct'.
// Mastodon-conventie: Public in `to` = public, Public in `cc` = unlisted, een
// followers-collectie zonder Public = followers-only, anders direct (DM). Public
// kan als volledige URI, 'as:Public' of 'Public' voorkomen (JSON-LD shorthands).
export function noteVisibility(o) {
  const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  const isPub = (u) => u === PUBLIC || u === 'as:Public' || u === 'Public';
  const to = arr(o && o.to).map(String);
  const cc = arr(o && o.cc).map(String);
  if (to.some(isPub)) return 'public';
  if (cc.some(isPub)) return 'unlisted';
  if ([...to, ...cc].some((u) => /\/followers\/?$/.test(u))) return 'followers';
  return 'direct';
}

function iStmts() {
  if (!_insI) {
    _insI = db.prepare('INSERT OR IGNORE INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, parent_uri, visibility, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delLA = db.prepare('DELETE FROM ap_interactions WHERE kind = ? AND post_id = ? AND actor_uri = ?');
    _delReply = db.prepare("DELETE FROM ap_interactions WHERE kind = 'reply' AND object_uri = ?");
    _listI = db.prepare('SELECT id, kind, object_uri, parent_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, created_at, acted_boost, acted_like, visibility FROM ap_interactions WHERE post_id = ? ORDER BY created_at ASC');
    _getI = db.prepare('SELECT * FROM ap_interactions WHERE id = ?');
    _insO = db.prepare('INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, language, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listO = db.prepare('SELECT * FROM ap_outbox WHERE post_id = ? ORDER BY created_at ASC');
    _getO = db.prepare('SELECT * FROM ap_outbox WHERE id = ?');
  }
  return { ins: _insI, delLA: _delLA, delReply: _delReply, list: _listI, getI: _getI, insO: _insO, listO: _listO, getO: _getO };
}

export function getInteractionById(id) { return iStmts().getI.get(id); }
export function setInteractionBoosted(id, on) {
  db.prepare('UPDATE ap_interactions SET acted_boost = ? WHERE id = ?').run(on ? 1 : 0, id);
}
export function setInteractionLiked(id, on) {
  db.prepare('UPDATE ap_interactions SET acted_like = ? WHERE id = ?').run(on ? 1 : 0, id);
}
// Your like/boost state on a REMOTE post (interact page toggles).
export function setMyReaction(slug, uri, kind, on) {
  if (on) db.prepare('INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind) VALUES (?,?,?)').run(slug, uri, kind);
  else db.prepare('DELETE FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ? AND kind = ?').run(slug, uri, kind);
}
export function getMyReactions(slug, uri) {
  const rows = (slug && uri) ? db.prepare('SELECT kind FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ?').all(slug, uri) : [];
  return { liked: rows.some((r) => r.kind === 'like'), boosted: rows.some((r) => r.kind === 'boost') };
}

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

// Drop the leading @mention(s) a federated reply carries (the person being replied to),
// so a comment reads "dope tekening ouwe" instead of "@jason@jasonhacky.nl dope …".
// Keeps a leading <p> wrapper; handles mention <a> links and plain-text @user@domain.
export function stripLeadingMentions(html) {
  if (!html) return html;
  let s = String(html);
  s = s.replace(/^(\s*<p[^>]*>)?\s*(?:<a\b[^>]*>\s*@[^<]+<\/a>[  ]*)+/i, (m, p) => p || '');
  s = s.replace(/^(\s*<p[^>]*>)?\s*(?:@[\w.-]+(?:@[\w.-]+)?[  ]+)+/i, (m, p) => p || '');
  return s;
}

// View-ready threaded view of a post's fediverse activity (inbound replies +
// our outbound replies, nested), plus like/boost counts.
export function getInteractions(postId, base, site) {
  const s = iStmts();
  // Privacy: a followers-only or direct (DM) reply is addressed to people, not to the
  // public web, so it must NOT render in the public thread. It still reaches the owner
  // via notifications (post context + reference included there). Legacy rows without a
  // visibility value are treated as public. Likes/boosts stay counted (count-only).
  const rows = s.list.all(postId).filter((r) =>
    r.kind !== 'reply' || !(r.visibility === 'followers' || r.visibility === 'direct'));
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
      actor_uri: r.actor_uri,
      actor_name: r.actor_name, actor_handle: r.actor_handle, actor_url: r.actor_url,
      actor_icon: r.actor_icon, content: stripLeadingMentions(r.content), created_at: r.published || r.created_at,
      acted_boost: !!r.acted_boost, acted_like: !!r.acted_like,
      children: [],
    });
  }
  for (const o of s.listO.all(postId)) {
    nodes.push({
      noteId: baseClean ? `${baseClean}/ap/notes/${o.id}` : o.id, parent: o.in_reply_to || null,
      mine: true, outboxId: o.id, content: stripLeadingMentions(o.content), created_at: o.created_at,
      media: (() => { try { return o.attachments ? JSON.parse(o.attachments) : []; } catch { return []; } })(),
      actor_name: siteName, actor_handle: siteHandle, actor_url: siteUrl, actor_icon: siteIcon,
      children: [],
    });
  }

  const byId = new Map(nodes.map((n) => [n.noteId, n]));
  // Conversation partners per node (u02, the reply editor's mentions bar): the
  // node's author plus the ancestor authors up the chain. Our own nodes are
  // skipped (we do not mention ourselves), deduped by actor, capped at 8.
  for (const n of nodes) {
    const seen = new Set();
    const list = [];
    let cur = n, guard = 0;
    while (cur && guard++ < 12 && list.length < 8) {
      if (!cur.mine && cur.actor_uri && !seen.has(cur.actor_uri)) {
        seen.add(cur.actor_uri);
        list.push({
          uri: cur.actor_uri,
          url: cur.actor_url || cur.actor_uri,
          handle: cur.actor_handle || deriveHandle(cur.actor_uri),
        });
      }
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    n.participants = list;
  }
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
// Which of OUR sites are named in a note's Mention tags? Only hrefs on our own base count
// (an /ap/users/<slug> path on a remote host is someone else's actor), and the slug must be
// an existing site. Deduped.
export function localMentionSlugs(tags, base) {
  if (!base) return [];
  const out = [], seen = new Set();
  for (const t of (Array.isArray(tags) ? tags : (tags ? [tags] : []))) {
    if (!t || t.type !== 'Mention' || typeof t.href !== 'string') continue;
    if (!t.href.startsWith(base + '/ap/users/')) continue;
    const slug = slugFromActorUrl(t.href);
    if (!slug || seen.has(slug)) continue; seen.add(slug);
    try { if (db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(slug)) out.push(slug); } catch { /* ignore */ }
  }
  return out;
}

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
// Record delivery health per follower so the followers list can flag dead accounts.
// Keyed by inbox: a shared-inbox POST reaches every follower behind it, so all of them
// are marked. A non-follower inbox (inline @mention) simply matches 0 rows.
let _fDelivOk, _fDelivErr;
function markFollowerDelivery(slug, inbox, ok) {
  if (!slug || !inbox) return;
  try {
    if (!_fDelivOk) {
      _fDelivOk = db.prepare('UPDATE ap_followers SET last_delivery_at = CURRENT_TIMESTAMP WHERE slug = ? AND (inbox = ? OR shared_inbox = ?)');
      _fDelivErr = db.prepare('UPDATE ap_followers SET last_error_at = CURRENT_TIMESTAMP WHERE slug = ? AND (inbox = ? OR shared_inbox = ?)');
    }
    (ok ? _fDelivOk : _fDelivErr).run(slug, inbox, inbox);
  } catch { /* health tracking is non-fatal */ }
}
// Deliver now; queue for retry if it fails.
export async function deliverWithRetry(slug, inbox, activity, keyId, privPem) {
  if (!inbox) return;
  try { const st = await deliver(inbox, activity, keyId, privPem); if (st >= 200 && st < 300) { markFollowerDelivery(slug, inbox, true); return; } } catch { /* queue below */ }
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
      if (ok) { markFollowerDelivery(row.slug, row.inbox, true); deliveryStmts().del.run(row.id); continue; }
      const attempts = row.attempts + 1;
      if (attempts >= DELIVERY_MAX_ATTEMPTS) { markFollowerDelivery(row.slug, row.inbox, false); deliveryStmts().del.run(row.id); console.warn('[AP] delivery gave up after', attempts, 'tries →', row.inbox); continue; }
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
// Max clock skew for the signed Date header (replay window). Generous default to tolerate
// federating servers with drifting clocks; an operator can widen it via env.
const SIG_MAX_SKEW_MS = (Number(process.env.AP_SIG_MAX_SKEW_MIN) || 60) * 60 * 1000;
export async function verifyRequest(req) {
  const sigH = req.headers['signature'];
  if (!sigH) return null;
  const p = Object.fromEntries([...sigH.matchAll(/([a-zA-Z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!p.keyId || !p.signature) return null;
  const actor = await fetchActor(p.keyId.split('#')[0]);
  const pem = actor && actor.publicKey && actor.publicKey.publicKeyPem;
  if (!pem) return null;
  const hs = (p.headers || '(request-target) host date').split(/\s+/);
  // Behind a reverse proxy the raw Host header is the backend bind (e.g. localhost:3000, when
  // the proxy doesn't preserve it — Apache .htaccess [P] proxying), but the sender signed the
  // HTTP-Signature over the PUBLIC host. Try each candidate host (the configured PUBLIC_BASE_URL
  // host, the proxy's X-Forwarded-Host, and the raw Host) and accept if the signature verifies
  // against any. An attacker can't forge a match (no private key), so this only rescues the
  // legitimate proxied case. Also normalise a leading double-slash in the request-target.
  let _pubHost = null;
  if (process.env.PUBLIC_BASE_URL) { try { _pubHost = new URL(process.env.PUBLIC_BASE_URL).host; } catch { /* ignore */ } }
  const _hosts = [...new Set([_pubHost, req.headers['x-forwarded-host'], req.headers['host']].filter(Boolean))];
  const _target = `${req.method.toLowerCase()} ${String(req.originalUrl || '').replace(/^\/{2,}/, '/')}`;
  const _sig = Buffer.from(p.signature, 'base64');
  let ok = false;
  for (const _h of _hosts) {
    const line = hs.map((x) => x === '(request-target)'
      ? `(request-target): ${_target}`
      : x === 'host' ? `host: ${_h}`
      : `${x}: ${req.headers[x] || ''}`).join('\n');
    try { if (crypto.verify('sha256', Buffer.from(line), pem, _sig)) { ok = true; break; } } catch { /* try next host */ }
  }
  // Replay defence: the Date header must be signed and recent. A captured signed request
  // replayed later (or with a swapped body) is rejected.
  if (ok) {
    if (!hs.includes('date')) ok = false;
    else {
      const t = Date.parse(req.headers['date'] || '');
      if (isNaN(t) || Math.abs(Date.now() - t) > SIG_MAX_SKEW_MS) ok = false;
    }
  }
  // Digest is MANDATORY when the request carries a body: without a signed digest the body
  // isn't covered by the signature and could be swapped on a replay.
  if (ok && req.rawBody && req.rawBody.length) {
    if (!hs.includes('digest')) ok = false;
    else {
      const exp = 'SHA-256=' + crypto.createHash('sha256').update(req.rawBody).digest('base64');
      if (req.headers['digest'] !== exp) ok = false;
    }
  }
  return ok ? actor : null;
}

// Parse a fediverse poll (an ActivityStreams `Question` — the Mastodon-standard poll form)
// into our compact shape. `oneOf` = single choice, `anyOf` = multiple; each option is a Note
// with a `name` and a `replies` collection whose `totalItems` is that option's vote count.
function parsePoll(o) {
  if (!o || o.type !== 'Question') return null;
  const raw = Array.isArray(o.oneOf) ? o.oneOf : (Array.isArray(o.anyOf) ? o.anyOf : null);
  if (!raw || !raw.length) return null;
  const options = raw.slice(0, 12).map((opt) => ({
    name: String((opt && opt.name) || '').slice(0, 300),
    count: Math.max(0, Number(opt && opt.replies && opt.replies.totalItems) || 0),
  })).filter((x) => x.name);
  if (!options.length) return null;
  const endTime = o.endTime || (typeof o.closed === 'string' ? o.closed : null);
  const closed = !!o.closed || (endTime ? Date.parse(endTime) <= Date.now() : false);
  return { multiple: Array.isArray(o.anyOf), options, endTime, closed, voters: Number(o.votersCount) || null, voted: null };
}

// ── Polls WE host (a local post with a poll) ──────────────────────
// Parse the poll definition stored on our own post (posts.poll_json). Counts are
// NOT stored here — they're derived from the poll_votes ballots so a re-render always
// reflects the authoritative tally.
export function parseOwnPoll(pollJson) {
  if (!pollJson) return null;
  let d; try { d = typeof pollJson === 'string' ? JSON.parse(pollJson) : pollJson; } catch { return null; }
  if (!d || !Array.isArray(d.options)) return null;
  const options = d.options.map((o) => ({ name: String((o && o.name != null ? o.name : o) || '').slice(0, 300) })).filter((o) => o.name);
  if (options.length < 2) return null;
  const endTime = d.endTime || null;
  const closed = !!d.closed || (endTime ? Date.parse(endTime) <= Date.now() : false);
  return { multiple: !!d.multiple, options, endTime, closed };
}

// Live tally of a hosted poll from its ballots: per-option counts + unique voters.
export function pollTally(postId) {
  const counts = {}; let voters = 0;
  try {
    for (const r of db.prepare('SELECT choice, COUNT(*) AS n FROM poll_votes WHERE post_id = ? GROUP BY choice').all(postId)) counts[r.choice] = r.n;
    voters = db.prepare('SELECT COUNT(DISTINCT actor_uri) AS n FROM poll_votes WHERE post_id = ?').get(postId).n || 0;
  } catch { /* table may not exist yet */ }
  return { counts, voters };
}

// Render-ready view of a hosted poll (options with counts + percentages, totals, state).
// Voting is fediverse-only, so this is display-only on the site.
export function ownPollView(post) {
  const poll = parseOwnPoll(post && post.poll_json);
  if (!poll) return null;
  const { counts, voters } = pollTally(post.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const denom = poll.multiple ? voters : total; // multiple-choice %: share of voters (can sum >100%)
  const options = poll.options.map((o) => {
    const count = counts[o.name] || 0;
    return { name: o.name, count, pct: denom ? Math.round((count / denom) * 100) : 0 };
  });
  return { multiple: poll.multiple, options, total, voters, endTime: poll.endTime, closed: poll.closed };
}

// Attach the AS2 Question shape to a note built for a hosted poll. Mastodon renders a
// status with either media OR a poll (never both), so a poll federates as content +
// options with no media attachment. oneOf = single choice, anyOf = multiple.
function applyPollToNote(note, postId, poll) {
  const { counts, voters } = pollTally(postId);
  const opts = poll.options.map((o) => ({
    type: 'Note',
    name: o.name,
    replies: { type: 'Collection', totalItems: counts[o.name] || 0 },
  }));
  note.type = 'Question';
  note[poll.multiple ? 'anyOf' : 'oneOf'] = opts;
  if (poll.endTime) note.endTime = new Date(poll.endTime).toISOString();
  // Once closed, Mastodon expects a `closed` timestamp (the effective end).
  if (poll.closed) note.closed = poll.endTime ? new Date(poll.endTime).toISOString() : new Date().toISOString();
  note.votersCount = voters;
  delete note.attachment;   // media ATTACHMENTS + a poll are mutually exclusive on Mastodon
  // Keep note.image: it's the cover, which Mastodon ignores on a Question anyway
  // (same as on any Note) but Klonkt reads to show the cover in feeds/the Cirkel.
  // Deleting it stripped the cover off every boosted poll.
  return note;
}

// Record an inbound ballot on one of OUR polls. A vote arrives as a Create(Note) whose
// `name` is the chosen option and `inReplyTo` is our poll note — the Mastodon-standard
// vote form. Returns { handled } — handled=true means it was addressed to a poll (so the
// caller must NOT also store it as a reply), false means "not a poll, fall through".
function recordPollBallot(postId, actorUri, rawChoice) {
  const choice = String(rawChoice == null ? '' : rawChoice).slice(0, 300);
  if (!choice) return { handled: false };
  let post; try { post = db.prepare('SELECT poll_json FROM posts WHERE id = ?').get(postId); } catch { return { handled: false }; }
  const poll = post && parseOwnPoll(post.poll_json);
  if (!poll) return { handled: false };               // not a poll → let the reply logic handle it
  if (poll.closed) return { handled: true };          // voting closed → drop
  if (!poll.options.some((o) => o.name === choice)) return { handled: true }; // unknown option → drop
  try {
    // Single choice = one ballot per actor: ignore a later/different vote. Multiple choice
    // allows one ballot per distinct option (the UNIQUE(post,actor,choice) dedupes repeats).
    if (!poll.multiple && db.prepare('SELECT 1 FROM poll_votes WHERE post_id = ? AND actor_uri = ? LIMIT 1').get(postId, actorUri)) return { handled: true };
    db.prepare('INSERT OR IGNORE INTO poll_votes (post_id, actor_uri, choice) VALUES (?, ?, ?)').run(postId, actorUri, choice);
  } catch { return { handled: true }; }
  schedulePollUpdate(postId);
  return { handled: true };
}

// Coalesce a burst of votes into ONE Update(Question) per poll: the first vote schedules a
// refresh ~15s out; further votes in that window ride the same pending update (which carries
// the accumulated tally). Non-follower voters re-fetch the Question (live tally) themselves.
const _pollUpdTimers = new Map();
function schedulePollUpdate(postId) {
  if (_pollUpdTimers.has(postId)) return;
  const t = setTimeout(() => { _pollUpdTimers.delete(postId); deliverPollUpdate(postId).catch(() => { /* best-effort */ }); }, 15000);
  if (t.unref) t.unref();
  _pollUpdTimers.set(postId, t);
}

// Push the fresh poll tally (or closed state) to followers as Update(Question).
export async function deliverPollUpdate(postId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !postId) return;
  let post, site;
  try {
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post || !post.poll_json) return;
    site = db.prepare('SELECT * FROM sites WHERE id = ?').get(post.site_id);
  } catch { return; }
  if (site) await deliverUpdate(site, post);
}

// Handle an incoming inbox POST. slugParam = null for the shared /ap/inbox.
export async function handleInbox(req, slugParam) {
  const act = req.body || {};
  const type = act.type;
  // Real client IP (behind the proxy via `trust proxy`) — logged on dropped/rejected/
  // ignored inbox hits so an operator can see who is probing their fediverse inbox.
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '?';
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const verified = await verifyRequest(req).catch(() => null);

  // ENFORCE HTTP signatures: a data-affecting activity must be signed by the very
  // actor it claims to be. No valid signature, or signer ≠ actor → reject (no
  // forged replies/likes/follows/timeline posts). GET/discovery stays open.
  const claimedActor = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  // Blocked actor/domain → silently drop (202, don't reveal the block).
  if (claimedActor && isBlockedAny(claimedActor)) { console.log('[AP] inbox dropped (blocked)', claimedActor, 'from', ip); return 202; }
  const GATED = ['Create', 'Like', 'Announce', 'Follow', 'Delete', 'Undo', 'Accept', 'Reject', 'Add', 'Remove', 'Update', 'Flag'];
  if (GATED.includes(type)) {
    if (!verified || !claimedActor || verified.id !== claimedActor) {
      console.warn('[AP] inbox REJECTED (signature)', type, claimedActor || '?', 'from', ip, verified ? '(signer mismatch)' : '(unsigned/invalid)');
      return 401;
    }
  }

  // A moderation report (Flag) about our content — store it for the targeted site's owner
  // (each Klonkt site is moderated by its own owner). Signature is enforced (GATED).
  if (type === 'Flag') {
    const objs = Array.isArray(act.object) ? act.object : (act.object ? [act.object] : []);
    const objectUris = objs.map((o) => (typeof o === 'string' ? o : (o && o.id))).filter(Boolean);
    let targetSlug = null;
    const noteIds = [];
    for (const u of objectUris) {
      const s = slugFromActorUrl(u);        // one of our actors?
      if (s) { targetSlug = targetSlug || s; continue; }
      const pid = postIdFromNoteUrl(u, base); // one of our notes?
      if (pid) noteIds.push(pid);
    }
    if (!targetSlug && noteIds.length) {
      try { const r = db.prepare('SELECT s.slug FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ? LIMIT 1').get(noteIds[0]); if (r) targetSlug = r.slug; } catch { /* ignore */ }
    }
    if (!targetSlug) return 202; // not about us / can't tell → drop
    // Flag is GATED, so `verified` is the signer's (reporter's) actor doc already.
    const ai = actorInfo(verified || null, claimedActor);
    try {
      db.prepare('INSERT INTO ap_reports (slug, actor_uri, actor_name, actor_handle, actor_icon, content, objects, created_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .run(targetSlug, claimedActor || null, ai.name, ai.handle, ai.icon, HtmlSanitizerService.toPlainText(act.content || '').slice(0, 3000), JSON.stringify(objectUris.slice(0, 20)));
      console.log('[AP] report received for', targetSlug, 'from', claimedActor);
    } catch { /* ignore */ }
    return 202;
  }

  if (type === 'Follow') {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    const slug = slugParam || slugFromActorUrl(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (!who || !slug) return 400;
    const remote = await fetchActor(who);
    if (!remote || !remote.inbox) return 202; // can't reach them → drop quietly
    const sharedInbox = (remote.endpoints && remote.endpoints.sharedInbox) || null;
    const fi = actorInfo(remote, who);   // cache display for the friends list (shaer-aa3)
    fStmts().ins.run(slug, who, remote.inbox, sharedInbox, fi.name, fi.handle, fi.icon);
    try { _updFDisp.run(fi.name, fi.handle, fi.icon, slug, who); } catch { /* best effort */ }
    const me = actorId(base, slug);
    const keys = getOrCreateKeys(slug);
    const accept = { '@context': AP_CONTEXT, id: `${me}#accept-${Date.now()}-${rid()}`, type: 'Accept', actor: me, object: act };
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
  if (type === 'Create' && act.object && (act.object.type === 'Note' || act.object.type === 'Article' || act.object.type === 'Question')) {
    const o = act.object;
    // A poll ballot: a Note carrying a `name` (the chosen option) inReplyTo one of OUR poll
    // posts. Record it (deduped per actor) BEFORE the reply logic so a vote is never stored
    // as a comment. recordPollBallot returns handled=false only if the target isn't a poll.
    if (o.name && o.inReplyTo && actorUri && !isLocalActor) {
      const seg = postIdFromNoteUrl(o.inReplyTo, base);
      if (seg && localPostExists(seg)) {
        const rec = recordPollBallot(seg, actorUri, o.name);
        if (rec.handled) { console.log('[AP] poll vote', actorUri, '→', seg); return 202; }
      }
    }
    const tgt = findThreadTarget(o.inReplyTo, base);
    if (tgt && actorUri && !isLocalActor) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      const html = HtmlSanitizerService.sanitize(o.content || '');
      if (isRejectedObject(o.id)) { console.log('[AP] reply skipped (tombstoned)', o.id); return 202; }
      iStmts().ins.run('reply', tgt.post_id, o.id || '', actorUri, ai.name, ai.handle, ai.url, ai.icon, html, o.published || null, tgt.parent_uri, noteVisibility(o));
      console.log('[AP] reply', actorUri, '→', tgt.post_id);
      return 202;
    }
    // Home timeline (client): a top-level post from an account we follow.
    if (actorUri && !isLocalActor && !o.inReplyTo && o.id) {
      let subs = []; try { subs = db.prepare('SELECT slug, auto_boost FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist yet */ }
      if (subs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const html = HtmlSanitizerService.sanitize(o.content || '');
        const _atts = (Array.isArray(o.attachment) ? o.attachment : []).map((a) => ({ url: safeUrl(a && a.url), type: (a && a.mediaType) || '' })).filter((m) => m.url);
        // Fallback cover: a Note's `image` (set when the attachment was suppressed
        // for a player-card post, e.g. hosted-audio posts).
        if (!_atts.some((m) => !m.type || /image/i.test(m.type)) && o.image) {
          const _im = Array.isArray(o.image) ? o.image[0] : o.image;
          const _iu = safeUrl(typeof _im === 'string' ? _im : (_im && _im.url));
          if (_iu) _atts.push({ url: _iu, type: (_im && _im.mediaType) || 'image/jpeg' });
        }
        const media = JSON.stringify(_atts);
        const poll = parsePoll(o); // a Question (fediverse poll) → cache its options/counts
        // "Feature" = show in the Cirkel (local only). We do NOT auto-Announce
        // incoming posts to the fediverse — that flooded followers. Boosting to the
        // fediverse is only ever a deliberate, manual per-post action (the 🔁 on
        // the timeline).
        for (const s of subs) {
          tlStmts().ins.run(o.id, s.slug, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.url || null, o.published || null, media, o.sensitive ? 1 : 0, o.summary || null);
          if (poll) { try { db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(poll), o.id, s.slug); } catch { /* ignore */ } }
        }
        console.log('[AP] timeline +', actorUri, 'x' + subs.length);
      }
    }
    // Mentioned in a post that is NOT a reply to our content (a reply to us already returned
    // above): store a mention notification for each of our actors named in the Mention tags.
    // Requires our own base prefix on the tag href — /ap/users/<slug> on a REMOTE host is
    // someone else's actor, not ours.
    if (actorUri && !isLocalActor && o.id) {
      const slugs = localMentionSlugs(o.tag, base);
      if (slugs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const html = HtmlSanitizerService.sanitize(o.content || '');
        for (const slug of slugs) {
          try {
            const r = db.prepare('INSERT OR IGNORE INTO ap_mentions (slug, object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, actor_url, content, published, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
              .run(slug, o.id, safeUrl(o.url) || null, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.published || null);
            if (r.changes) console.log('[AP] mention', actorUri, '→', slug);
          } catch { /* ignore */ }
        }
      }
    }
    return 202;
  }
  // A remote post we cached was edited upstream → refresh our cached copy. This is the
  // push-based edit-sync that keeps the Cirkel/timeline fresh without polling (selfHeal
  // does it on a version bump; this does it live). Scope to the SIGNING actor so B can't
  // edit A's note (the signature gate guarantees claimedActor == the verified signer).
  if (type === 'Update' && act.object && (act.object.type === 'Note' || act.object.type === 'Article' || act.object.type === 'Question')) {
    const o = act.object;
    if (o.id && claimedActor) {
      const html = HtmlSanitizerService.sanitize(o.content || '');
      const media = mediaFromNote(o);
      try {
        // Refresh url too (COALESCE keeps the old one if the Update omits it): a remote slug
        // rename keeps the same AP id but changes the human url, so without this the cached
        // post would keep linking to the old, now-dead URL.
        const r = db.prepare('UPDATE ap_timeline SET content = ?, media_json = ?, nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE id = ? AND author_uri = ?')
          .run(html, media, o.sensitive ? 1 : 0, o.summary || null, o.url || null, o.id, claimedActor);
        if (r.changes) console.log('[AP] timeline update', claimedActor, '→', o.id);
        // A poll's Update carries the fresh vote counts / closed state. Refresh per-row so each
        // site keeps its own `voted` state while the counts/closed update to the new totals.
        const poll = parsePoll(o);
        if (poll) {
          const rows = db.prepare('SELECT rowid AS rid, poll_json FROM ap_timeline WHERE id = ? AND author_uri = ?').all(o.id, claimedActor);
          const upd = db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE rowid = ?');
          for (const rw of rows) {
            let voted = null; try { voted = rw.poll_json ? (JSON.parse(rw.poll_json).voted || null) : null; } catch { /* ignore */ }
            upd.run(JSON.stringify({ ...poll, voted }), rw.rid);
          }
        }
      } catch { /* ignore */ }
      // If this note is a cached fediverse reply on one of our posts, refresh its text too.
      try { db.prepare('UPDATE ap_interactions SET content = ? WHERE object_uri = ? AND actor_uri = ?').run(html, o.id, claimedActor); } catch { /* ignore */ }
    }
    return 202;
  }
  if (type === 'Like' || type === 'Announce') {
    const tgt = act.object;
    const objUrl = typeof tgt === 'string' ? tgt : (tgt && tgt.id);
    const pid = postIdFromNoteUrl(objUrl, base);
    if (pid && actorUri && !isLocalActor && localPostExists(pid)) {
      // A boost/like of a non-public post is dropped, not stored: nobody
      // outside the audience should even hold it (shaer-tqc hardening).
      const vp = db.prepare('SELECT fan_only, ap_visibility FROM posts WHERE id = ?').get(pid);
      if (vp && (vp.fan_only || vp.ap_visibility === 'direct' || vp.ap_visibility === 'friends')) {
        console.log('[AP] dropped', type, 'on non-public post', pid);
        return;
      }
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      iStmts().ins.run(type.toLowerCase(), pid, '', actorUri, ai.name, ai.handle, ai.url, ai.icon, null, null, null, noteVisibility(act));
      console.log('[AP]', type === 'Like' ? 'like' : 'boost', actorUri, '→', pid);
    } else if (type === 'Announce' && objUrl && actorUri && !isLocalActor) {
      // A boost FROM an account we follow, of a REMOTE post → show it in the News feed.
      // We only STORE it for display; we NEVER auto-Announce it onward (anti-feedback-loop:
      // re-announcing an incoming Announce would cascade boosts across the network).
      let subs = []; try { subs = db.prepare('SELECT slug FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist */ }
      if (subs.length) {
        const bn = await fetchNoteAP(objUrl);
        if (bn && bn !== 404 && (bn.type === 'Note' || bn.type === 'Article') && bn.id) {
          const origUri = actorUriOf(bn.attributedTo);
          // Block completeness: even if you follow the booster, drop a boost whose ORIGINAL
          // author is blocked — otherwise a block is bypassed via someone else's boost.
          if (origUri && isBlockedAny(origUri)) { console.log('[AP] timeline boost dropped (blocked origin)', origUri, 'via', actorUri); return 202; }
          const oai = actorInfo(await resolveActor(origUri), origUri);
          const html = HtmlSanitizerService.sanitize(bn.content || '');
          const media = mediaFromNote(bn);
          const booster = actorInfo(await resolveActor(actorUri), actorUri);
          for (const s of subs) {
            // published = now → the boost shows as fresh activity at the top (Mastodon shows
            // reblogs at reblog-time, not the original's date). INSERT OR IGNORE: if we already
            // have the note (e.g. we also follow the author), keep it and DON'T relabel it.
            let inserted = false;
            try { const r = tlStmts().ins.run(bn.id, s.slug, origUri || '', oai.name, oai.handle, oai.icon, oai.url, html, bn.url || null, new Date().toISOString(), media, bn.sensitive ? 1 : 0, bn.summary || null); inserted = r.changes > 0; } catch { /* ignore */ }
            if (inserted) { try { db.prepare('UPDATE ap_timeline SET reblog_name = ?, reblog_handle = ?, reblog_icon = ? WHERE slug = ? AND id = ?').run(booster.name, booster.handle, booster.icon, s.slug, bn.id); } catch { /* ignore */ } }
          }
          console.log('[AP] timeline boost +', actorUri, 'x' + subs.length);
        }
      }
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
      // Also clear a boost/like YOU made of this now-deleted remote post (the interact-page
      // ap_my_reactions state), so it can't stay stuck as "boosted" on a post that's gone.
      // Guard: only when the deleter owns the note's domain (B mustn't clear your reactions
      // to A's posts).
      try {
        let sameHost = false;
        try { sameHost = new URL(oid).host === new URL(claimedActor).host; } catch { sameHost = false; }
        if (sameHost) db.prepare('DELETE FROM ap_my_reactions WHERE target_uri = ?').run(oid);
      } catch { /* ignore */ }
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

  console.log('[AP] inbox', type || 'unknown', '→', slugParam || 'shared', 'from', ip, '(ignored)');
  return 202;
}

// Deliver a new post as Create(Note) to all followers' inboxes (fire-and-forget).
// Needs PUBLIC_BASE_URL (absolute URLs); no-op without followers or base.
export async function deliverCreate(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  // Resolve inline @user@host mentions → link them in the note + collect their inboxes, so a
  // mentioned person is notified even if they don't follow us (Mastodon-standard mention).
  const mres = await resolveMentionsInText(base, post.content || '');
  const post2 = mres.inboxes.length ? { ...post, content: mres.html } : post;
  const followers = fStmts().list.all(site.slug);
  const inboxes = [...new Set([...followers.map((f) => f.shared_inbox || f.inbox), ...mres.inboxes].filter(Boolean))];
  if (!inboxes.length) return; // no followers and no one mentioned
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${actorId(base, site.slug)}#main-key`;
  const create = buildCreate(base, site, post2);
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
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, published_at, created_at
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
    '@context': AP_CONTEXT,
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
  const mres = await resolveMentionsInText(base, post.content || ''); // link mentions + collect inboxes
  const post2 = mres.inboxes.length ? { ...post, content: mres.html } : post;
  const followers = fStmts().list.all(site.slug);
  const inboxes = [...new Set([...followers.map((f) => f.shared_inbox || f.inbox), ...mres.inboxes].filter(Boolean))];
  if (!inboxes.length) return;
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const note = buildNote(base, site, post2);
  note.updated = new Date().toISOString();
  const update = {
    '@context': AP_CONTEXT,
    id: `${noteId(base, post.id)}#update-${Date.now()}-${rid()}`,
    type: 'Update', actor: me, to: [PUBLIC], cc: note.cc,
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
    '@context': AP_CONTEXT,
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
// Serialize pin-resyncs per site: two concurrent /save calls would otherwise interleave
// their Remove -> wait -> Add sequences and scramble the StatusPin order on Mastodon. A
// resync already in flight for a site coalesces later requests into ONE rerun after it
// finishes (accumulating their extra unpins), so rapid saves don't pile up N full resyncs.
const _pinResync = new Map(); // slug -> { promise, pending, pendingRemove:Set, site }
export function resyncFeaturedPins(site, alsoRemove = []) {
  if (!site || !site.slug) return Promise.resolve();
  const slug = site.slug;
  const running = _pinResync.get(slug);
  if (running) {
    running.pending = true;
    running.site = site; // use the latest site object on the rerun
    for (const id of alsoRemove) running.pendingRemove.add(id);
    return running.promise;
  }
  const state = { promise: null, pending: false, pendingRemove: new Set(), site };
  state.promise = (async () => {
    let extra = alsoRemove;
    for (;;) {
      try { await doResyncFeaturedPins(state.site, extra); }
      catch (e) { console.warn('[AP] pin resync failed:', e.message); }
      if (!state.pending) break;
      state.pending = false;
      extra = [...state.pendingRemove];
      state.pendingRemove = new Set();
    }
    _pinResync.delete(slug);
  })();
  _pinResync.set(slug, state);
  return state.promise;
}

// The actual resync work — do NOT call directly; go through resyncFeaturedPins() above so
// it stays serialized per site.
async function doResyncFeaturedPins(site, alsoRemove = []) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const keyId = `${me}#main-key`;
  const featured = `${me}/featured`;
  const note = (id) => noteId(base, id);
  const pinned = db.prepare(
    `SELECT id FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
       AND pinned IS NOT NULL AND pinned > 0
     ORDER BY pinned DESC, COALESCE(published_at, created_at) ASC LIMIT 20`
  ).all(site.id);
  const removeIds = [...new Set([...pinned.map((p) => p.id), ...alsoRemove])];
  // 1. Remove every current pin so Mastodon can recreate them in order.
  for (const id of removeIds) {
    const rm = { '@context': AP_CONTEXT, id: `${me}#rm-${id}-${Date.now()}-${rid()}`, type: 'Remove', actor: me, object: note(id), target: featured, to: [PUBLIC] };
    for (const inbox of inboxes) deliver(inbox, rm, keyId, keys.private_pem).catch(() => { /* best-effort */ });
  }
  if (!pinned.length) { console.log('[AP] unpinned all featured for', site.slug); return; }
  await new Promise((r) => setTimeout(r, 5000)); // let the Removes land first
  // 2. Add in rank-DESC order, gaps so each StatusPin gets an increasing created_at.
  for (const p of pinned) {
    const add = { '@context': AP_CONTEXT, id: `${me}#add-${p.id}-${Date.now()}-${rid()}`, type: 'Add', actor: me, object: note(p.id), target: featured, to: [PUBLIC], cc: [`${me}/followers`] };
    for (const inbox of inboxes) deliver(inbox, add, keyId, keys.private_pem).catch(() => { /* best-effort */ });
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('[AP] resynced', pinned.length, 'featured pins for', site.slug);
}

// ── outbound replies (Klonkt → fediverse) ─────────────────────────
const escHtml = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const toISO = (v) => { if (!v) return new Date().toISOString(); const s = String(v); const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };

// Build one of OUR outbound reply Notes from an ap_outbox row.
// Turn #hashtags in reply text into Mastodon-style hashtag links (clickable + federated).
function linkHashtags(base, html) {
  // Prefix: start / whitespace / '>' / opening bracket — "(#tag" is a tag too. NO quote
  // chars in this class: a quote precedes attribute values (alt="#…"), which must not match.
  return String(html || '').replace(/(^|[\s>([{])#([\p{L}\p{M}\p{N}_]+)/gu, (m, pre, tag) =>
    `${pre}<a href="${base}/tag/${encodeURIComponent(tag.toLowerCase())}" class="mention hashtag" rel="tag">#${tag}</a>`);
}
// Auto-link bare http(s) URLs in already-safe HTML (federated copies). Splits on existing
// <a>…</a> so a linked URL is never wrapped twice; requires start/whitespace/'>' before the
// URL so attribute values (src="https://…") never match. Trailing sentence punctuation stays
// outside the link (Mastodon-style).
function linkUrls(html) {
  const parts = String(html || '').split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (/^<a\b/i.test(parts[i])) continue; // already a link → leave as-is
    parts[i] = parts[i].replace(/(^|[\s>([{])(https?:\/\/[^\s<]+?)([.,;:!?)\]»]*)(?=$|[\s<])/g,
      (m, pre, url, trail) => `${pre}<a href="${url.replace(/"/g, '%22')}" rel="nofollow noopener" target="_blank">${url}</a>${trail}`);
  }
  return parts.join('');
}
// Linkify inline #hashtags and bare URLs in BODY html for on-site DISPLAY, using the
// EXACT same rules as the federated copy (linkHashtags/linkUrls), so the website and the
// Mastodon copy agree instead of the website showing raw text. Idempotent: existing
// <a>…</a> (editor links, embeds, shortcode buttons) are split out and left untouched, so
// nothing is double-wrapped. Pass base='' → root-relative /tag/<slug> links.
export function linkifyBody(base, html) {
  const withTags = String(html || '')
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi)
    .map((seg) => (/^<a\b/i.test(seg) ? seg : linkHashtags(base, seg)))
    .join('');
  return linkUrls(withTags);
}

// Bake a post's raw source into its display HTML (the ActivityPub `source` model): done ONCE
// at save and cached in posts.content_rendered, so page views serve it statically instead of
// re-linkifying every render. Step 1 = #hashtags + bare URLs (cheap, no network). Step 2 will
// resolve @mentions here too (webfinger once at save instead of per page view).
export function bakePostContent(source) {
  return linkifyBody('', source || '');
}

// Step 2: the full bake, incl. @mention links. Resolves @user@host via webfinger ONCE (the
// same resolver the federated copy uses) and bakes the profile links into content_rendered,
// so page views never do a per-view lookup. Unresolvable handles stay plain text; on any
// failure it degrades to the sync #hashtag/URL bake. Async (webfinger) → callers run it off
// the save response so the request never blocks on a slow/dead remote server.
export async function bakePostContentWithMentions(source) {
  const withHashUrls = bakePostContent(source);
  try { const m = await resolveMentionsInText('', withHashUrls); return m.html; }
  catch { return withHashUrls; }
}

// Extract the AP Hashtag tag objects from already-linked reply content.
function hashtagTags(base, content) {
  const tags = [], seen = new Set();
  const re = /class="[^"]*\bhashtag\b[^"]*"[^>]*>#([\p{L}\p{M}\p{N}_]+)</giu;
  let m;
  while ((m = re.exec(content || ''))) {
    const k = m[1].toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    tags.push({ type: 'Hashtag', href: `${base}/tag/${encodeURIComponent(k)}`, name: '#' + m[1] });
  }
  return tags;
}

// Normalise a post's tags field (array, JSON-string, or comma-string) to an array.
function normalizeTags(t) {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string') {
    const s = t.trim(); if (!s) return [];
    if (s[0] === '[') { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { /* fall through */ } }
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}
// A tag → { label, slug }. Multi-word tags become CamelCase (#LiveMusic) for the display
// name (Mastodon hashtags can't contain spaces; CamelCase is the accessibility norm); the
// slug/href stays lowercase ("livemusic").
function tagParts(raw) {
  const words = String(raw || '').trim().split(/[\s_]+/).map((w) => w.replace(/[^\p{L}\p{M}\p{N}]/gu, '')).filter(Boolean);
  if (!words.length) return null;
  const slug = words.join('').toLowerCase();
  if (!slug) return null;
  const label = words.length > 1 ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join('') : words[0];
  return { label, slug };
}
// Merge a post's tags field + the #hashtags linked inline in its body into one deduped
// Hashtag tag list (with hrefs to our /tag page).
function buildHashtagList(base, tagsField, content) {
  const out = [], seen = new Set();
  for (const t of normalizeTags(tagsField)) {
    const p = tagParts(t); if (!p || seen.has(p.slug)) continue; seen.add(p.slug);
    out.push({ type: 'Hashtag', href: `${base}/tag/${encodeURIComponent(p.slug)}`, name: '#' + p.label });
  }
  for (const h of hashtagTags(base, content)) {
    const k = h.name.slice(1).toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    out.push(h);
  }
  return out;
}

// Extract Mention tag objects from already-linked content (class="u-url mention").
function mentionTags(content) {
  const tags = [], seen = new Set();
  // The link href is the human profile URL; the actor URI (for the Mention tag) is in data-actor.
  const re = /<a href="[^"]*" class="u-url mention" data-actor="([^"]+)">@([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(content || ''))) {
    const href = m[1];
    if (seen.has(href)) continue; seen.add(href);
    tags.push({ type: 'Mention', href, name: '@' + m[2] });
  }
  return tags;
}
// Resolve inline @user@domain mentions in reply/post text → link them (href = actor URI)
// and collect the mentioned actors' inboxes so they get notified. Best-effort per mention.
async function resolveMentionsInText(base, html) {
  const inboxes = [];
  const handles = new Set();
  // Prefix also allows opening brackets — "(@user@host + me)" is a mention too (real-world
  // miss: a bracketed mention federated as plain text and its target was never notified).
  const re = /(^|[\s>([{])@([\p{L}\p{M}\p{N}_.-]+@[\p{L}\p{M}\p{N}.-]+)/gu;
  let m;
  while ((m = re.exec(html || ''))) handles.add(m[2]);
  let out = String(html || '');
  for (const h of handles) {
    let actorUri = null;
    try { actorUri = await webfingerResolve('@' + h); } catch { actorUri = null; }
    if (!actorUri) continue;
    const actor = await fetchActor(actorUri).catch(() => null);
    const inbox = actor && ((actor.endpoints && actor.endpoints.sharedInbox) || actor.inbox);
    if (inbox) inboxes.push(inbox);
    const profileUrl = actorInfo(actor, actorUri).url || actorUri; // human profile page → the link href
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(^|[\\s>([{])@' + esc + '(?![\\p{L}\\p{M}\\p{N}_.-])', 'gu'),
      (full, pre) => `${pre}<a href="${profileUrl}" class="u-url mention" data-actor="${actorUri}">@${h}</a>`);
  }
  return { html: out, inboxes };
}

export function buildReplyNote(base, site, row) {
  // Thin delegate: replies are built by buildNote (the single Note entry point) in reply mode.
  return buildNote(base, site, row, { isReply: true });
}

// Resolve one of our outbound reply Notes by id (for /ap/notes/:id fallback).
export function getOutboxNote(base, id) {
  const row = iStmts().getO.get(id);
  if (!row) return null;
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(row.site_slug);
  if (!site) return null;
  return buildReplyNote(base, site, row);
}

// ── ActivityPub Client-to-Server: ingest an activity POSTed to the outbox ──
// The C2S counterpart of handleInbox: a native/web client (Shaer) posts an
// activity here and we translate it onto the SAME delivery machinery the web UI
// uses (deliverReply / sendInteraction / followActor / deliverCreate). Returns
// { status, id?, url?, error? }. Auth + site-ownership are checked by the route.
const c2sIdOf = (x) => (typeof x === 'string' ? x : (x && (x.id || x.href))) || null;

export async function ingestOutboxActivity(site, user, activity) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !activity || typeof activity !== 'object') return { status: 400, error: 'invalid_activity' };

  // AP §6: a client MAY POST a bare object; the server wraps it in a Create.
  let type = activity.type;
  let object = activity.object;
  if (type === 'Note' || type === 'Article') { object = activity; type = 'Create'; }
  if (Array.isArray(type)) type = type.find((t) => typeof t === 'string');

  try {
    switch (type) {
      case 'Create': {
        if (!object || typeof object !== 'object') return { status: 400, error: 'missing_object' };
        // Client sends `source` (plain/markdown) + `content` (HTML). deliverReply
        // re-escapes, so it needs plain text; a top-level post keeps sanitized HTML.
        const plain = (object.source && object.source.content) || HtmlSanitizerService.toPlainText(object.content || '');
        if (!plain.trim() && !object.content) return { status: 400, error: 'empty_note' };
        // Direct (private mention, shaer-tqc): NOT a post. Delivered over the
        // outbox machinery to the addressed inboxes only; shows under Messages.
        if (c2sVisibility(object) === 'direct') {
          const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');
          const recipients = [...new Set([...arr(object.to), ...arr(object.cc)])]
            .filter((u) => /^https?:\/\//i.test(u) && !/\/followers\/?$/.test(u) && u !== PUBLIC);
          if (!recipients.length) return { status: 400, error: 'no_recipients' };
          // AS2 attachments (e.g. the help-buoy capture, uploaded via
          // uploadMedia): normalize our own absolute /media/ URLs to relative
          // so the deliverReply-style validation applies unchanged.
          const atts = (Array.isArray(object.attachment) ? object.attachment : [])
            .map((a) => a && typeof a === 'object' ? {
              url: String(a.url || '').replace(new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ''),
              mediaType: String(a.mediaType || ''),
              name: String(a.name || '').slice(0, 120),
            } : null)
            .filter(Boolean);
          const help = object['shaer:helpRequest'] === true || object.helpRequest === true;
          const r = await deliverDirectNote(site, { recipients, text: plain, language: object.language || null, inReplyTo: typeof object.inReplyTo === 'string' ? object.inReplyTo : null, attachments: atts, helpRequest: help });
          if (!r || !r.id) return { status: 502, error: 'direct_failed' };
          return { status: 201, id: r.id, url: `${base}/ap/notes/${r.id}` };
        }
        if (object.inReplyTo) {
          const parent = await resolveRemoteNote(c2sIdOf(object.inReplyTo)).catch(() => null);
          if (!parent) return { status: 502, error: 'cannot_resolve_inReplyTo' };
          const r = await deliverReply(site, { postId: parent.localPostId || '', postSlug: null, parent, text: plain });
          if (!r || !r.id) return { status: 502, error: 'reply_failed' };
          return { status: 201, id: r.id, url: `${base}/ap/notes/${r.id}` };
        }
        return await c2sCreatePost(base, site, user, object);
      }
      case 'Like':
      case 'Announce': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        // A non-public local note cannot be boosted or liked into the open
        // (shaer-tqc hardening; the Mastodon 422 equivalent).
        const localPid = postIdFromNoteUrl(targetUri, base);
        if (localPid) {
          const p = db.prepare('SELECT fan_only, ap_visibility FROM posts WHERE id = ?').get(localPid);
          if (p && (p.fan_only || p.ap_visibility === 'direct' || p.ap_visibility === 'friends')) {
            return { status: 403, error: 'not_public' };
          }
        }
        const note = await resolveRemoteNote(targetUri).catch(() => null);
        const objUri = (note && note.object_uri) || targetUri;
        const authorUri = note && note.actor_uri;
        const kind = type === 'Announce' ? 'boost' : 'like';
        await sendInteraction(site, kind, objUri, authorUri);
        setMyReaction(site.slug, targetUri, kind, true);
        if (type === 'Announce' && note) { try { upsertBoostedNote(site.slug, note); } catch { /* non-fatal */ } }
        return { status: 202, url: objUri };
      }
      case 'Follow': {
        const actorUri = c2sIdOf(object);
        if (!actorUri) return { status: 400, error: 'missing_object' };
        await followActor(site, actorUri);
        return { status: 202, url: actorUri };
      }
      case 'Undo': {
        const inner = object && typeof object === 'object' ? object : null;
        let innerType = inner && inner.type;
        if (Array.isArray(innerType)) innerType = innerType.find((t) => typeof t === 'string');
        const innerTarget = c2sIdOf(inner && inner.object);
        if (innerType === 'Follow') { await unfollowActor(site, innerTarget); return { status: 202, url: innerTarget }; }
        if (innerType === 'Like' || innerType === 'Announce') {
          const kind = innerType === 'Announce' ? 'unboost' : 'unlike';
          const note = await resolveRemoteNote(innerTarget).catch(() => null);
          const objUri = (note && note.object_uri) || innerTarget;
          await sendInteraction(site, kind, objUri, note && note.actor_uri);
          setMyReaction(site.slug, innerTarget, innerType === 'Announce' ? 'boost' : 'like', false);
          if (innerType === 'Announce') { try { unmarkBoosted(site.slug, objUri); } catch { /* non-fatal */ } }
          return { status: 202, url: objUri };
        }
        return { status: 400, error: 'unsupported_undo' };
      }
      // Delete/Update of arbitrary objects need the post-edit pipeline; tracked
      // separately (klonkt-demo-c2s-del). Reject clearly rather than half-doing it.
      default:
        return { status: 400, error: 'unsupported_type', detail: String(type || 'none') };
    }
  } catch (e) {
    console.warn('[AP] C2S ingest failed:', e && e.message);
    return { status: 500, error: 'ingest_error' };
  }
}

// Create a top-level microblog post from a C2S Note and federate it. Minimal
// sibling of the /posts/create route: sanitized HTML content, no title/cover.
async function c2sCreatePost(base, site, user, object) {
  const html = HtmlSanitizerService.sanitize(object.content || (object.source && object.source.content) || '');
  if (!html.trim()) return { status: 400, error: 'empty_note' };
  const postId = crypto.randomUUID();
  const slug = 'n-' + postId.slice(0, 8);
  const now = new Date().toISOString();
  // Visibility from the note's addressing (shaer-60b): Public in `to` = loud
  // public, Public in `cc` = quiet public (unlisted), followers-only = friends
  // (rides the existing fan_only pipeline: followers-only AP delivery + web
  // gating), neither = participants-only (kept local until mention addressing
  // lands; still followers-gated on the web).
  const vis = c2sVisibility(object);
  const fanOnly = (vis === 'friends' || vis === 'direct') ? 1 : 0;
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, excerpt, status, type, language, fan_only, ap_visibility, created_at, updated_at, published_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(postId, site.id, slug, user.id, '', html, '', 'published', 'post', object.language || 'nl', fanOnly, vis, now, now, now);
  try { db.prepare('UPDATE posts SET content_rendered = ? WHERE id = ?').run(bakePostContent(html), postId); } catch { /* render fallback covers it */ }
  bakePostContentWithMentions(html).then((h) => { try { db.prepare('UPDATE posts SET content_rendered = ? WHERE id = ?').run(h, postId); } catch { /* keep sync bake */ } }).catch(() => {});
  try { db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?,?,?,?)').run(HtmlSanitizerService.toPlainText(html), '', user.username || '', postId); } catch { /* FTS non-fatal */ }
  if (vis !== 'direct') {
    deliverCreate(site, { id: postId, slug, title: '', content: html, published_at: now, created_at: now, fan_only: fanOnly, ap_visibility: vis }).catch(() => { /* best-effort */ });
  }
  return { status: 201, id: postId, url: `${base}/ap/notes/${postId}` };
}

// Addressing → visibility. Arrays or bare strings; unknown shapes read as the
// safest bucket they match.
export function c2sVisibility(object) {
  const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');
  const to = arr(object.to), cc = arr(object.cc);
  const isPublic = (x) => x === PUBLIC || x === 'as:Public' || x === 'Public';
  const isFollowers = (x) => /\/followers\/?$/.test(x);
  if (to.some(isPublic)) return 'public';
  if (cc.some(isPublic)) return 'quiet';
  if (to.some(isFollowers) || cc.some(isFollowers)) return 'friends';
  if (!to.length && !cc.length) return 'public';   // no addressing at all: legacy client, keep old behavior
  return 'direct';
}

// A direct note (private mention, shaer-tqc): a NEW conversation (or a direct
// reply) addressed to specific actors only. Stored in ap_outbox with
// visibility 'direct' + the recipient list, delivered to exactly those
// inboxes: no followers fan-out, no Public, so no boosts and no timelines.
// The same S2S leg a Mastodon DM takes, so a guardian on any instance
// receives it as a private mention (the ward call-for-help path).
export async function deliverDirectNote(site, { recipients, text, language, inReplyTo, attachments, helpRequest }) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const list = [...new Set((recipients || []).filter((u) => /^https?:\/\//i.test(String(u || ''))))].slice(0, 8);
  if (!base || !site || !site.slug || !list.length || !String(text || '').trim()) return null;
  const me = actorId(base, site.slug);
  // Resolve every recipient for a mention anchor + a delivery inbox.
  const resolved = [];
  for (const uri of list) {
    const a = await fetchActor(uri).catch(() => null);
    if (!a || !(a.inbox || (a.endpoints && a.endpoints.sharedInbox))) continue;
    resolved.push({ uri, inbox: (a.endpoints && a.endpoints.sharedInbox) || a.inbox, handle: deriveHandle(uri), url: a.url || uri });
  }
  if (!resolved.length) return null;
  const mention = resolved.map((r) => {
    const disp = r.handle && r.handle[0] === '@' ? r.handle : '@' + (r.handle || '');
    return `<a href="${escHtml(r.url)}" class="u-url mention" data-actor="${escHtml(r.uri)}">${escHtml(disp)}</a> `;
  }).join('');
  const body = escHtml(String(text).trim()).replace(/\r?\n/g, '<br>');
  const content = `<p>${mention}${linkUrls(linkHashtags(base, body))}</p>`;
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9-]+)?$/.test(String(language || '')) ? language : null;
  // Attachments: same rules as deliverReply (own /media/ uploads only,
  // image/audio/video, max 4) — the help-buoy capture rides this.
  const media = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && typeof a.url === 'string' && /^\/media\/[\w./-]+$/.test(a.url)
      && /^(image|audio|video)\//.test(String(a.mediaType || '')))
    .slice(0, 4)
    .map((a) => ({ url: a.url, mediaType: String(a.mediaType), name: String(a.name || '').slice(0, 120) }));
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, language, attachments, visibility, to_actors, help_request, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(id, site.slug, '', null, inReplyTo || null, resolved[0].uri, resolved[0].handle, content, lang, media.length ? JSON.stringify(media) : null, 'direct', JSON.stringify(resolved.map((r) => r.uri)), helpRequest ? 1 : 0);
  const row = iStmts().getO.get(id);
  const note = buildReplyNote(base, site, row);
  const create = {
    '@context': AP_CONTEXT,
    id: note.id + '#create', type: 'Create', actor: me,
    published: note.published, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${me}#main-key`;
  let delivered = 0;
  for (const inbox of [...new Set(resolved.map((r) => r.inbox))]) {
    let ok = false;
    try { const st = await deliver(inbox, create, keyId, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, create);
  }
  console.log('[AP] direct note', site.slug, '→', resolved.length, 'recipient(s), delivered', delivered);
  return { id, content, delivered };
}

// Send a reply FROM this site to a remote actor (in reply to their inbound reply).
// `parent` = an ap_interactions row (actor_uri, actor_url, actor_handle, object_uri).
export async function deliverReply(site, { postId, postSlug, parent, text, html, language, attachments, mentions }) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  // Rich replies: `html` is the reply editor's HTML (sanitized here); `text` is
  // the plain-text fallback (no-JS path, C2S `source`). Either may carry the reply.
  const richClean = html ? HtmlSanitizerService.sanitize(String(html)) : '';
  const rich = richClean && HtmlSanitizerService.toPlainText(richClean).trim() ? richClean : '';
  // Attachments: only OUR OWN uploads (/media/... paths, no remote URLs — the
  // upload route is the sole producer), image/audio/video only, max 4.
  const media = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && typeof a.url === 'string' && /^\/media\/[\w./-]+$/.test(a.url)
      && /^(image|audio|video)\//.test(String(a.mediaType || '')))
    .slice(0, 4)
    .map((a) => ({ url: a.url, mediaType: String(a.mediaType), name: String(a.name || '').slice(0, 120) }));
  // A media-only reply (no text) is a valid reply.
  if (!base || !site || !site.slug || !parent || (!String(text || '').trim() && !rich && !media.length)) return null;
  const me = actorId(base, site.slug);
  // u02, the mentions bar: `mentions` undefined = legacy behavior (mention the
  // parent author). An ARRAY (possibly empty) = the kept conversation partners
  // exactly as the bar shows them; the mention prefix, the Mention tags (via
  // mentionTags over the content) and the delivery targets all follow it.
  const kept = Array.isArray(mentions)
    ? mentions
      .filter((m) => m && typeof m.uri === 'string' && /^https?:\/\//i.test(m.uri))
      .slice(0, 8)
      .map((m) => ({
        uri: m.uri,
        url: (typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) ? m.url : m.uri,
        handle: String(m.handle || deriveHandle(m.uri)).slice(0, 120),
      }))
    : null;
  const mentionAnchor = (uri, url, h) => {
    const disp = h && h[0] === '@' ? h : '@' + (h || '');
    return `<a href="${escHtml(url || uri)}" class="u-url mention" data-actor="${escHtml(uri)}">${escHtml(disp)}</a> `;
  };
  const handle = parent.actor_handle || deriveHandle(parent.actor_uri);
  const mention = kept
    ? kept.map((k) => mentionAnchor(k.uri, k.url, k.handle)).join('')
    : (parent.actor_uri ? mentionAnchor(parent.actor_uri, parent.actor_url, handle) : '');
  // Who the stored reply is "to": the parent when kept, else the first kept chip.
  const parentKept = !kept || kept.some((k) => k.uri === parent.actor_uri);
  const toActorUri = parentKept ? (parent.actor_uri || null) : (kept[0] ? kept[0].uri : null);
  const toHandle = parentKept ? handle : (kept[0] ? kept[0].handle : null);
  let content;
  let mres;
  if (rich) {
    // Same enrichment pipeline as the plain path (mentions/hashtags/URLs), on
    // sanitized editor HTML. The parent mention goes inline into the first
    // paragraph (Mastodon convention), or becomes its own leading one.
    mres = await resolveMentionsInText(base, rich);
    const processed = linkUrls(linkHashtags(base, mres.html));
    if (processed.startsWith('<p>')) {
      content = processed.replace('<p>', `<p>${mention}`);            // inline in the first paragraph
    } else if (/^<(blockquote|ul|ol|pre|h[1-6]|div|hr)\b/i.test(processed)) {
      content = `<p>${mention}</p>${processed}`;                      // block content: own leading paragraph
    } else {
      content = `<p>${mention}${processed}</p>`;                      // bare inline text: one paragraph together
    }
  } else {
    const body = escHtml(String(text).trim()).replace(/\r?\n/g, '<br>');
    mres = await resolveMentionsInText(base, body); // link inline @mentions + collect their inboxes
    content = `<p>${mention}${linkUrls(linkHashtags(base, mres.html))}</p>`;
  }
  const replyLang = /^[a-z]{2,3}(-[A-Za-z0-9-]+)?$/.test(String(language || '')) ? language : null;
  // Dedup: skip if the exact same reply was already sent (double-submit guard).
  // Attachments count toward "the same": two media-only replies share content.
  const mediaJson = media.length ? JSON.stringify(media) : null;
  const dup = db.prepare('SELECT 1 FROM ap_outbox WHERE site_slug = ? AND IFNULL(in_reply_to, \'\') = ? AND content = ? AND IFNULL(attachments, \'\') = IFNULL(?, \'\') LIMIT 1')
    .get(site.slug, parent.object_uri || '', content, mediaJson);
  if (dup) { console.log('[AP] outreply skipped (duplicate)'); return { duplicate: true, delivered: 0 }; }
  const id = crypto.randomUUID();
  iStmts().insO.run(id, site.slug, postId, postSlug || null, parent.object_uri || null, toActorUri, toHandle, content, replyLang, mediaJson);
  const row = iStmts().getO.get(id);
  const note = buildReplyNote(base, site, row);
  const create = {
    '@context': AP_CONTEXT,
    id: note.id + '#create', type: 'Create', actor: me,
    published: note.published, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${me}#main-key`;
  const inboxes = new Set();
  // Everyone the mentions bar kept gets pinged; legacy path = the parent only.
  const mentionTargets = kept ? kept.map((k) => k.uri) : (parent.actor_uri ? [parent.actor_uri] : []);
  for (const uri of mentionTargets) {
    const a = await fetchActor(uri).catch(() => null);
    if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox);
  }
  if (parent.threadInbox) inboxes.add(parent.threadInbox); // back-compat (single)
  (parent.threadInboxes || []).forEach((i) => inboxes.add(i)); // whole ancestor chain
  for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
  mres.inboxes.forEach((i) => inboxes.add(i)); // people @mentioned inline in the reply
  inboxes.delete(`${me}/inbox`);       // never deliver to ourselves (already in ap_outbox)
  inboxes.delete(`${base}/ap/inbox`);  // (our own shared inbox) → avoids a self-duplicate
  let delivered = 0;
  for (const inbox of [...inboxes].filter(Boolean)) {
    let ok = false;
    try { const st = await deliver(inbox, create, keyId, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, create); // durable: retry a briefly-offline recipient (was silently dropped)
  }
  console.log('[AP] outreply', site.slug, '→', parent.actor_uri, 'delivered', delivered);
  return { id, content, delivered };
}

// attributedTo may be a string, an object {id}, or an ARRAY — e.g. a PeerTube Video is
// attributed to [Person (account), Group (channel)]. Pick a usable actor URI (prefer Person).
function actorUriOf(att) {
  if (!att) return null;
  if (typeof att === 'string') return att;
  if (Array.isArray(att)) {
    const person = att.find((a) => a && typeof a === 'object' && a.type === 'Person' && a.id);
    if (person) return person.id;
    for (const a of att) { if (typeof a === 'string') return a; if (a && a.id) return a.id; }
    return null;
  }
  return att.id || null;
}

// Resolve a remote post URL (any fediverse/Klonkt post) into a reply target.
// Returns a parent-shaped object usable by deliverReply(), or null.
export async function resolveRemoteNote(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const note = await fetchActor(url).catch(() => null); // AP GET (content-negotiates)
  if (!note || !note.id) return null;
  const att = note.attributedTo;
  const actorUri = actorUriOf(att);
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
    const pa = actorUriOf(pn.attributedTo);
    if (pa && pa !== actorUri) {
      const paDoc = await fetchActor(pa).catch(() => null);
      const inbox = paDoc && ((paDoc.endpoints && paDoc.endpoints.sharedInbox) || paDoc.inbox);
      if (inbox && !seenInbox.has(inbox)) { seenInbox.add(inbox); threadInboxes.push(inbox); }
    }
    cursor = pn.inReplyTo; // climb to the next ancestor
  }
  // For non-Note objects (PeerTube Video, Article, …) the meaningful label is `name` (the
  // title); prepend it so the reply page shows what you're replying to (sanitize cleans it).
  let rawHtml = String(note.content || '').replace(/\[\[(track|album|playlist):[^\]]+\]\]/gi, '');
  if (note.name && note.type && note.type !== 'Note') rawHtml = `<p><strong>${note.name}</strong></p>` + rawHtml;
  const images = (Array.isArray(note.attachment) ? note.attachment : [])
    .filter((a) => a && a.url && (!a.mediaType || /^image\//i.test(a.mediaType)))
    .map((a) => safeUrl(a.url)).filter(Boolean);
  // A Klonkt hosted-audio post strips its cover from `attachment` (so Mastodon
  // shows the player card, not a loose image) and puts it in `image` instead.
  // Same fallback as mediaFromNote() so a boosted music post keeps its cover.
  if (!images.length && note.image) {
    const im = Array.isArray(note.image) ? note.image[0] : note.image;
    const iu = safeUrl(typeof im === 'string' ? im : (im && im.url));
    if (iu) images.push(iu);
  }
  return {
    object_uri: safeUrl(note.id) || note.id,
    actor_uri: actorUri,
    actor_url: ai.url,
    actor_handle: ai.handle,
    actor_name: ai.name,
    actor_icon: ai.icon,
    url: note.url || url,
    content: HtmlSanitizerService.sanitize(rawHtml),       // full, sanitized
    sensitive: !!note.sensitive,                            // remote CW → blur in the Cirkel
    cw: note.summary || '',
    images,
    // Full typed media (incl. video/mp4) for the timeline cache. `images` above is
    // image-only for the interact page preview; a boosted video-only post (Loops)
    // lost its media entirely because upsertBoostedNote only saw `images`.
    media: mediaFromNote(note),
    threadInboxes,                                          // every ancestor author's inbox
    localPostId: localTgt ? localTgt.post_id : '',          // our post this belongs to (if any)
    poll: parsePoll(note),                                  // a Question → its options/counts (else null)
    preview: HtmlSanitizerService.toPlainText(note.content || '').slice(0, 240),
  };
}

// List a site's own outbound fediverse replies (for the manage/delete view).
// The plain editable text of a stored reply (unwrap links → their text, <br> → newline)
// so the manage view can prefill an edit box; the mention is re-added on save.
function outboxEditableText(content) {
  return String(content || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}
export function listOutbox(siteSlug) {
  return db.prepare('SELECT id, content, to_handle, in_reply_to, language, created_at FROM ap_outbox WHERE site_slug = ? ORDER BY created_at DESC')
    .all(siteSlug).map((r) => { const c = stripLeadingMentions(r.content); return { ...r, content: c, editable: outboxEditableText(c) }; });
}

// Delete one of our outbound replies: send Delete(Tombstone) to recipients + remove it.
export async function deliverOutboxDelete(site, outboxId) {
  const row = iStmts().getO.get(outboxId);
  if (!row || row.site_slug !== site.slug) return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base) {
    const me = actorId(base, site.slug);
    const nid = noteId(base, row.id);
    const del = { '@context': AP_CONTEXT, id: `${nid}#delete-${Date.now()}-${rid()}`, type: 'Delete', actor: me, to: [PUBLIC], object: { id: nid, type: 'Tombstone' } };
    const keys = getOrCreateKeys(site.slug);
    const inboxes = new Set();
    if (row.to_actor) { const a = await fetchActor(row.to_actor).catch(() => null); if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox); }
    for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
    for (const inbox of [...inboxes].filter(Boolean)) {
      try { const st = await deliver(inbox, del, `${me}#main-key`, keys.private_pem); if (st >= 200 && st < 300) continue; } catch { /* queue below */ }
      enqueueDelivery(site.slug, inbox, del); // durable: a failed comment-delete now retries (was silently dropped)
    }
  }
  db.prepare('DELETE FROM ap_outbox WHERE id = ?').run(outboxId);
  return true;
}

// Edit one of our outbound replies: rewrite the stored content (mention re-added + #tags
// re-linked) and send an Update(Note) so recipients refresh their cached copy.
export async function deliverOutboxUpdate(site, outboxId, newText, opts = {}) {
  const row = iStmts().getO.get(outboxId);
  if (!row || row.site_slug !== site.slug) return false;
  const text = String(newText || '').trim();
  // Rich edit: same sanitize + enrichment pipeline as deliverReply.
  const richClean = opts.html ? HtmlSanitizerService.sanitize(String(opts.html)) : '';
  const rich = richClean && HtmlSanitizerService.toPlainText(richClean).trim() ? richClean : '';
  if (!text && !rich) return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return false;
  const me = actorId(base, site.slug);
  const toActor = row.to_actor ? await fetchActor(row.to_actor).catch(() => null) : null;
  const toProfile = row.to_actor ? (actorInfo(toActor, row.to_actor).url || row.to_actor) : '';
  const _h = row.to_handle || deriveHandle(row.to_actor);
  const toHandle = _h && _h[0] === '@' ? _h : '@' + (_h || '');
  // An edit must not drop co-mentions (u02): reuse the OLD content's leading
  // mention anchors (the bar's kept list at send time) when present; only fall
  // back to rebuilding the single to_actor mention for legacy rows.
  const oldPrefix = (String(row.content || '')
    .match(/^\s*(?:<p[^>]*>)?\s*((?:<a\b[^>]*class="u-url mention"[^>]*>\s*@[^<]+<\/a>[\s ]*)+)/i) || [])[1] || '';
  const mention = oldPrefix || (row.to_actor
    ? `<a href="${escHtml(toProfile)}" class="u-url mention" data-actor="${escHtml(row.to_actor)}">${escHtml(toHandle)}</a> ` : '');
  let content;
  let mres;
  if (rich) {
    mres = await resolveMentionsInText(base, rich);
    const processed = linkUrls(linkHashtags(base, mres.html));
    if (processed.startsWith('<p>')) content = processed.replace('<p>', `<p>${mention}`);
    else if (/^<(blockquote|ul|ol|pre|h[1-6]|div|hr)\b/i.test(processed)) content = `<p>${mention}</p>${processed}`;
    else content = `<p>${mention}${processed}</p>`;
  } else {
    mres = await resolveMentionsInText(base, escHtml(text).replace(/\r?\n/g, '<br>'));
    content = `<p>${mention}${linkUrls(linkHashtags(base, mres.html))}</p>`;
  }
  // Language may be updated with the edit; attachments always survive untouched.
  const newLang = /^[a-z]{2,3}(-[A-Za-z0-9-]+)?$/.test(String(opts.language || '')) ? opts.language : null;
  db.prepare('UPDATE ap_outbox SET content = ?, language = COALESCE(?, language) WHERE id = ?').run(content, newLang, outboxId);
  const note = buildReplyNote(base, site, iStmts().getO.get(outboxId));
  note.updated = new Date().toISOString();
  const update = {
    '@context': AP_CONTEXT,
    id: `${note.id}#update-${Date.now()}-${rid()}`, type: 'Update', actor: me,
    published: note.published, updated: note.updated, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const inboxes = new Set();
  if (toActor) inboxes.add((toActor.endpoints && toActor.endpoints.sharedInbox) || toActor.inbox);
  for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
  mres.inboxes.forEach((i) => inboxes.add(i)); // people @mentioned inline in the edit
  inboxes.delete(`${me}/inbox`); inboxes.delete(`${base}/ap/inbox`);
  let delivered = 0;
  for (const inbox of [...inboxes].filter(Boolean)) {
    let ok = false;
    try { const st = await deliver(inbox, update, `${me}#main-key`, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, update); // durable: retry the edit later (was silently dropped)
  }
  console.log('[AP] outreply edit', site.slug, 'delivered', delivered);
  return { ok: true, content, delivered };
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
  // Featuring an account → AP-native catch-up so the Cirkel isn't empty until they next
  // post (push doesn't backfill history-before-follow). Fire-and-forget pull, sends nothing.
  if (on) backfillFromOutbox(slug, actorUri).catch(() => {});
  return { ok: true };
}

let _insTl, _listTl, _delTl;
function tlStmts() {
  if (!_insTl) {
    _insTl = db.prepare('INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, author_handle, author_icon, author_url, content, url, published, media_json, nsfw, cw, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listTl = db.prepare('SELECT * FROM ap_timeline WHERE slug = ? ORDER BY COALESCE(published, created_at) DESC LIMIT ? OFFSET ?');
    _delTl = db.prepare('DELETE FROM ap_timeline WHERE id = ?');
  }
  return { ins: _insTl, list: _listTl, del: _delTl };
}
export function getTimeline(slug, limit, offset) { return tlStmts().list.all(slug, limit || 50, offset || 0); }

// ── Cirkel = posts from the accounts you auto-boost ("feature an artist") ──
let _abCount, _cirkelPosts, _cirkelMembers;
export function autoBoostCount(slug) {
  try { if (!_abCount) _abCount = db.prepare('SELECT COUNT(*) AS n FROM ap_following WHERE slug = ? AND auto_boost = 1'); return _abCount.get(slug).n; } catch { return 0; }
}
export function getCirkelPosts(slug, limit, offset) {
  try {
    // Cirkel = posts from featured (auto_boost) accounts + posts you boosted
    // (t.boosted), mixed by date. One row per note in ap_timeline → no duplicates.
    if (!_cirkelPosts) _cirkelPosts = db.prepare(`
      SELECT t.id, t.author_uri, t.author_name, t.author_handle, t.author_icon, t.author_url,
             t.content, t.url, t.published, t.media_json, t.boosted, t.nsfw, t.cw
      FROM ap_timeline t
      LEFT JOIN ap_following f ON f.slug = t.slug AND f.actor_uri = t.author_uri
      WHERE t.slug = ? AND (f.auto_boost = 1 OR t.boosted = 1)
      ORDER BY COALESCE(t.published, t.created_at) DESC, t.rowid DESC
      LIMIT ? OFFSET ?`);
    return _cirkelPosts.all(slug, limit || 60, offset || 0);
  } catch { return []; }
}
export function getCirkelMembers(slug) {
  try { if (!_cirkelMembers) _cirkelMembers = db.prepare('SELECT name, url, icon FROM ap_following WHERE slug = ? AND auto_boost = 1 ORDER BY name'); return _cirkelMembers.all(slug); } catch { return []; }
}
// Mark a timeline post as boosted so it shows in the Cirkel (mixed by date).
let _markBoost, _unmarkBoost, _boostedCount;
export function markBoosted(slug, noteId) {
  try { if (!_markBoost) _markBoost = db.prepare('UPDATE ap_timeline SET boosted = 1 WHERE slug = ? AND id = ?'); _markBoost.run(slug, noteId); } catch { /* ignore */ }
}
export function unmarkBoosted(slug, noteId) {
  try { if (!_unmarkBoost) _unmarkBoost = db.prepare('UPDATE ap_timeline SET boosted = 0 WHERE slug = ? AND id = ?'); _unmarkBoost.run(slug, noteId); } catch { /* ignore */ }
}
let _markLike, _unmarkLike;
export function markLiked(slug, noteId) {
  try { if (!_markLike) _markLike = db.prepare('UPDATE ap_timeline SET liked = 1 WHERE slug = ? AND id = ?'); _markLike.run(slug, noteId); } catch { /* ignore */ }
}
export function unmarkLiked(slug, noteId) {
  try { if (!_unmarkLike) _unmarkLike = db.prepare('UPDATE ap_timeline SET liked = 0 WHERE slug = ? AND id = ?'); _unmarkLike.run(slug, noteId); } catch { /* ignore */ }
}
export function getTimelineReaction(slug, noteId) {
  try { const r = db.prepare('SELECT liked, boosted FROM ap_timeline WHERE slug = ? AND id = ?').get(slug, noteId); return { liked: !!(r && r.liked), boosted: !!(r && r.boosted) }; } catch { return { liked: false, boosted: false }; }
}
// Boost a REMOTE post that may not be in your timeline (you don't follow the author):
// store it in ap_timeline (INSERT OR IGNORE → no dup for followed posts) so it shows in
// the Cirkel with a Boost badge, then flag it boosted.
export function upsertBoostedNote(slug, note) {
  if (!slug || !note || !note.object_uri) return;
  const id = note.object_uri;
  // Prefer the full typed media (incl. video/mp4 — a Loops boost is video-only and
  // rendered a bare text tile); fall back to the image-only list for older callers.
  const media = (note.media && note.media !== '[]')
    ? note.media
    : JSON.stringify((note.images || []).map((u) => ({ url: u, type: 'image/jpeg' })));
  try {
    const r = tlStmts().ins.run(id, slug, note.actor_uri || '', note.actor_name || '', note.actor_handle || '',
      note.actor_icon || '', note.actor_url || '', note.content || '', note.url || null,
      new Date().toISOString(), media, note.sensitive ? 1 : 0, note.cw || null);
    if (!r.changes) {
      // Row already cached (INSERT OR IGNORE) → refresh it with the freshly
      // resolved note. Without this a row cached without its cover (or with
      // stale content) stayed stale forever — even boosting again didn't heal it.
      // Keep the CACHED media when the resolve yielded none: an empty re-resolve
      // used to clobber a good media_json (the followed copy had the video, the
      // boost wiped it to []).
      db.prepare(`UPDATE ap_timeline SET content = ?, media_json = CASE WHEN ? = '[]' THEN media_json ELSE ? END,
                  nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE slug = ? AND id = ?`)
        .run(note.content || '', media, media, note.sensitive ? 1 : 0, note.cw || null, note.url || null, slug, id);
    }
  } catch { /* ignore */ }
  markBoosted(slug, id);
}
export function boostedCount(slug) {
  try { if (!_boostedCount) _boostedCount = db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE slug = ? AND boosted = 1'); return _boostedCount.get(slug).n; } catch { return 0; }
}

// Resolve a Klonkt/AP actor URL from a site root: a Klonkt site's root 302s to
// /ap/users/<slug> (content negotiation; Location may be relative). Used by
// followActor for bare-domain follows.
// NB: the old auto-migration of legacy Cirkels (circle_links -> AP follows) was
// REMOVED on 2026-06-26 — it auto-sent Follows on boot, which violates "the code
// never throws anything into the fediverse automatically" (would surprise-Follow
// for some operators at scale). The dead circle_links table stays as harmless dead
// data; an operator restores an old cirkel by re-following in /following (their click).
async function resolveApActor(siteUrl) {
  try {
    const r = await fetch(siteUrl, { headers: { Accept: 'application/activity+json' }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (loc) return new URL(loc, siteUrl).href; }
    if (r.ok) return siteUrl;
  } catch { /* unreachable */ }
  return null;
}

// ── Self-heal: re-sync the fediverse cache (ap_timeline) after a DRASTIC update ──
// Runs ONCE per SELFHEAL_VERSION bump — NOT on every boot. Re-fetches each cached
// note and refreshes content + media (recovers covers/edits that were delivered
// during a flux window, e.g. a fleet-wide update), and drops notes that are gone
// (404/410). Bump SELFHEAL_VERSION only on a release that warrants a re-sync.
const SELFHEAL_VERSION = 7; // v7: rerun v6 with retry-until-clean semantics (origins briefly offline no longer stay stale forever)
async function fetchNoteAP(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/activity+json' } });
    if (r.status === 404 || r.status === 410) return 404;
    if (r.ok) return await r.json();
  } catch { /* unreachable */ }
  return null;
}
function mediaFromNote(note) {
  const atts = (Array.isArray(note.attachment) ? note.attachment : []).map((a) => ({ url: safeUrl(a && a.url), type: (a && a.mediaType) || '' })).filter((m) => m.url);
  if (!atts.some((m) => !m.type || /image/i.test(m.type)) && note.image) {
    const im = Array.isArray(note.image) ? note.image[0] : note.image;
    const iu = safeUrl(typeof im === 'string' ? im : (im && im.url));
    if (iu) atts.push({ url: iu, type: (im && im.mediaType) || 'image/jpeg' });
  }
  return JSON.stringify(atts);
}
// A generic SSRF-safe AP GET (collections / pages).
async function apGetJson(url) {
  try {
    const r = await safeFetch(url, { headers: { Accept: 'application/activity+json' } });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 3_000_000) return null;
    return await r.json();
  } catch { return null; }
}
// AP-native catch-up: pull an actor's standard `outbox` collection and merge their recent
// top-level posts into the timeline for `slug`. Push (Create delivery) cannot backfill
// history-from-before-you-followed or a delivery that was missed while you were down;
// reading the outbox is the spec-conform way to catch up. PULL ONLY — sends nothing.
export async function backfillFromOutbox(slug, actorUri, limit = 20) {
  try {
    if (!slug || !actorUri) return 0;
    const actor = await fetchActor(actorUri);
    if (!actor || !actor.outbox) return 0;
    let page = await apGetJson(typeof actor.outbox === 'string' ? actor.outbox : actor.outbox.id);
    let items = (page && (page.orderedItems || page.items)) || [];
    if (!items.length && page && page.first) {
      page = await apGetJson(typeof page.first === 'string' ? page.first : page.first.id);
      items = (page && (page.orderedItems || page.items)) || [];
    }
    if (!Array.isArray(items) || !items.length) return 0;
    const ai = actorInfo(actor, actorUri);
    let added = 0;
    for (const it of items.slice(0, limit)) {
      // Each item is usually a Create wrapping a Note, or sometimes the Note itself.
      const o = (it && typeof it.object === 'object' && it.object) ? it.object : it;
      if (!o || !o.id) continue;
      if (o.type && o.type !== 'Note' && o.type !== 'Article' && o.type !== 'Question') continue; // skip boosts/other
      if (o.inReplyTo) continue;                                          // top-level only
      const auth = actorUriOf(o.attributedTo);
      if (auth && auth !== actorUri) continue;                            // their OWN posts only
      const html = HtmlSanitizerService.sanitize(o.content || '');
      const poll = parsePoll(o); // a Question (poll) → carry its options/counts on backfill too
      try {
        const r = tlStmts().ins.run(o.id, slug, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.url || null, o.published || null, mediaFromNote(o), o.sensitive ? 1 : 0, o.summary || null);
        if (r && r.changes > 0) added++;
        // Set poll_json if this is a poll and we don't already have it (COALESCE preserves a vote).
        if (poll) { try { db.prepare('UPDATE ap_timeline SET poll_json = COALESCE(poll_json, ?) WHERE id = ? AND slug = ?').run(JSON.stringify(poll), o.id, slug); } catch { /* ignore */ } }
      } catch { /* ignore */ }
    }
    if (added) console.log('[AP] outbox backfill', actorUri, '→', slug, '+' + added);
    return added;
  } catch { return 0; }
}

// ── Remote thread crawl (fill the gaps in a local post's conversation) ────────────
// Most replies reach us by delivery, but replies-to-replies that live on other servers and
// aren't addressed to us are missed. This pulls the AS2 `replies` collections of the replies
// we DO have, caching any newly-found ones in ap_interactions.
//
// Matches Mastodon's behaviour: ONE level per crawl (like its FetchRepliesService), not a deep
// recursive walk. Deeper levels fill in incrementally across crawls — once a fetched reply is
// cached it becomes a seed itself, so its own replies are pulled on a later view (Mastodon's
// per-status cascade). Bounded + polite (serial), PULL only, and stale-while-revalidate: it
// never runs in a page request — the view renders from cache; a stale post kicks off a
// background refresh for the NEXT view.
const THREAD_TTL_MS = 15 * 60 * 1000;   // don't re-crawl a post more than ~4×/hour
const THREAD_MAX_DEPTH = 1;             // one hop per crawl (like Mastodon); deeper fills in over crawls
const THREAD_MAX_FETCHES = 30;          // hard cap on remote GETs per crawl (be a good peer)
const _crawlingThreads = new Set();     // per-post in-flight lock (no stampede across views)

function threadCrawlTs(postId) {
  try { const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('thread_crawl:' + postId); return r ? (Number(r.value) || 0) : 0; }
  catch { return 0; }
}
function setThreadCrawlTs(postId, ts) {
  try { db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('thread_crawl:' + postId, String(ts)); }
  catch { /* ignore */ }
}

// Read a note's `replies` (string ref / Collection with `first` / paged CollectionPages) →
// child note URIs. Every remote GET goes through `budget` so the whole crawl stays capped.
async function collectReplyItems(repliesRef, maxPages, budget) {
  const uris = [];
  let node = typeof repliesRef === 'string' ? await budget.get(repliesRef) : repliesRef;
  if (node && node.first) node = typeof node.first === 'string' ? await budget.get(node.first) : node.first;
  let pages = 0;
  while (node && pages++ < maxPages) {
    for (const it of (node.items || node.orderedItems || [])) {
      const u = typeof it === 'string' ? it : (it && it.id);
      if (u && /^https?:\/\//i.test(u)) uris.push(u);
    }
    if (!node.next) break;
    node = typeof node.next === 'string' ? await budget.get(node.next) : node.next;
  }
  return uris;
}

async function crawlThread(postId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return;
  // Seed frontier = the remote reply note URIs we already have; also the dedup set.
  let known;
  try { known = new Set(db.prepare("SELECT object_uri FROM ap_interactions WHERE post_id = ? AND kind = 'reply' AND object_uri != ''").all(postId).map((r) => r.object_uri)); }
  catch { return; }
  const seeds = [...known].filter((u) => /^https?:\/\//i.test(u));
  if (!seeds.length) return; // nothing remote to expand
  // Owner-removed replies (tombstones) join the dedup set AFTER seeding, so the
  // crawler never re-adds them via thread-filling (they're gone from the seeds
  // already because rejectInteraction deleted their ap_interactions row).
  try { for (const r of db.prepare('SELECT object_uri FROM ap_rejected_objects WHERE post_id = ?').all(postId)) known.add(r.object_uri); }
  catch { /* table always exists after boot migration */ }

  let fetches = 0;
  const budget = { get: async (u) => { if (fetches >= THREAD_MAX_FETCHES) return null; fetches++; return apGetJson(u); } };
  const visited = new Set(); // notes whose replies collection we've already expanded
  let frontier = seeds.slice();
  let added = 0;

  for (let depth = 0; depth < THREAD_MAX_DEPTH && frontier.length && fetches < THREAD_MAX_FETCHES; depth++) {
    const nextFrontier = [];
    for (const noteUri of frontier) {
      if (visited.has(noteUri) || fetches >= THREAD_MAX_FETCHES) continue;
      visited.add(noteUri);
      const note = await budget.get(noteUri);
      if (!note || !note.replies) continue;
      const childUris = await collectReplyItems(note.replies, 2, budget);
      for (const cu of childUris) {
        if (known.has(cu) || fetches >= THREAD_MAX_FETCHES) continue;
        known.add(cu);
        const child = await budget.get(cu);
        if (!child || !child.id || (child.type !== 'Note' && child.type !== 'Article')) continue;
        if (isRejectedObject(child.id)) continue; // note id can differ from the collection URI (redirects)
        const actorUri = actorUriOf(child.attributedTo);
        if (!actorUri || isBlockedAny(actorUri)) continue; // skip blocked authors
        const actor = await budget.get(actorUri); // may be null if budget spent → fallback handle
        const ai = actorInfo(actor, actorUri);
        const html = HtmlSanitizerService.sanitize(child.content || '');
        // The child replies to `note` by construction (it's in note's replies collection).
        try { iStmts().ins.run('reply', postId, child.id, actorUri, ai.name, ai.handle, ai.url, ai.icon, html, child.published || null, note.id || noteUri, noteVisibility(child)); added++; } catch { /* ignore */ }
        nextFrontier.push(child.id); // expand this reply's own replies next depth
      }
    }
    frontier = nextFrontier;
  }
  if (added) console.log('[AP] thread crawl', postId, '+' + added, 'remote replies (' + fetches + ' fetches)');
}

// Stale-while-revalidate entry point: call from the post view. Renders nothing, blocks nothing —
// fires a background crawl only if this post hasn't been crawled within the TTL.
export function maybeCrawlThread(postId) {
  if (!postId || _crawlingThreads.has(postId)) return;
  if (Date.now() - threadCrawlTs(postId) < THREAD_TTL_MS) return;
  _crawlingThreads.add(postId);
  setThreadCrawlTs(postId, Date.now()); // optimistic mark so concurrent/next views don't re-fire
  crawlThread(postId).catch((e) => console.warn('[AP] thread crawl failed:', e && e.message)).finally(() => _crawlingThreads.delete(postId));
}

let _selfHealing = false;
export async function selfHealTimeline() {
  if (_selfHealing) return; _selfHealing = true;
  try {
    let cur = 0;
    try { const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('selfheal_version'); cur = r ? (parseInt(r.value, 10) || 0) : 0; } catch { return; }
    if (cur >= SELFHEAL_VERSION) return; // already healed for this version — skip on normal boots
    let rows = [];
    try { rows = db.prepare('SELECT id, content, media_json, nsfw, cw, url FROM ap_timeline ORDER BY rowid DESC LIMIT 200').all(); } catch { /* no table */ }
    let healed = 0, failed = 0;
    for (const r of rows) {
      try {
        const note = await fetchNoteAP(r.id);
        if (note === 404) { db.prepare('DELETE FROM ap_timeline WHERE id = ?').run(r.id); healed++; continue; }
        if (!note || typeof note !== 'object') { failed++; continue; } // origin unreachable right now
        const html = HtmlSanitizerService.sanitize(note.content || '');
        const media = mediaFromNote(note);
        const nsfw = note.sensitive ? 1 : 0;   // re-sync NSFW/sensitive + CW onto already-cached posts
        const cw = note.summary || null;
        const url = note.url || null;          // re-sync the human url (catches a remote slug rename)
        if ((html && html !== r.content) || media !== (r.media_json || '[]') || nsfw !== (r.nsfw || 0) || (cw || '') !== (r.cw || '') || (url && url !== r.url)) {
          db.prepare('UPDATE ap_timeline SET content = ?, media_json = ?, nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE id = ?').run(html || r.content, media, nsfw, cw, url, r.id);
          healed++;
        }
      } catch { failed++; /* per-note best-effort */ }
    }
    // Only mark this version DONE after a clean pass. Some origins are briefly
    // offline exactly when we heal (phone-hosted instances!): skipping them and
    // consuming the version would leave those rows stale forever. Instead retry
    // on the next boots, giving up after a few attempts (permanently-dead
    // origins answer 404/410 and are deleted above, so they don't loop).
    const setSetting = (k, v) => { try { db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(k, String(v)); } catch { /* ignore */ } };
    let attempts = 0;
    try { const a = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('selfheal_attempts'); attempts = a ? (parseInt(a.value, 10) || 0) : 0; } catch { /* ignore */ }
    if (failed === 0 || attempts >= 4) {
      setSetting('selfheal_version', SELFHEAL_VERSION);
      setSetting('selfheal_attempts', 0);
    } else {
      setSetting('selfheal_attempts', attempts + 1);
    }
    if (rows.length) console.log(`[AP] self-heal v${SELFHEAL_VERSION}: ${healed}/${rows.length} timeline notes${failed ? ` (${failed} unreachable — will retry next boot)` : ''}`);
  } catch { /* never block boot */ } finally { _selfHealing = false; }
}

// Follow a fediverse account by @handle (WebFinger → actor → signed Follow).
export async function followActor(site, handle, autoBoost = false) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  // Accept any of: a profile/actor URL, an @user@host handle (WebFinger), or a
  // bare site domain (site.com) — for a single-actor site (Klonkt etc.) the root
  // resolves to its AP actor, so you can follow a site by just its domain.
  const s = String(handle || '').trim();
  let actorUrl;
  if (/^https?:\/\//i.test(s)) actorUrl = safeUrl(s) || null;
  else if (s.includes('@')) actorUrl = await webfingerResolve(s);
  else if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) actorUrl = await resolveApActor('https://' + s.replace(/^\/+|\/+$/g, ''));
  else actorUrl = null;
  if (!actorUrl) return { error: 'not_found' };
  const actor = await fetchActor(actorUrl).catch(() => null);
  if (!actor || !actor.id || !actor.inbox) return { error: 'unreachable' };
  const ai = actorInfo(actor, actor.id);
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const followId = `${me}#follow-${Date.now()}-${rid()}`;
  fwStmts().ins.run(site.slug, actor.id, ai.handle, ai.name, ai.icon, ai.url, actor.inbox, followId, 'pending', autoBoost ? 1 : 0);
  const follow = { '@context': AP_CONTEXT, id: followId, type: 'Follow', actor: me, object: actor.id };
  // Deliver via the retry queue: a Follow that fails the first attempt (peer down,
  // timeout, transient 5xx) is retried with backoff instead of staying stuck on
  // 'pending' forever — the Accept can only come back once the Follow lands.
  await deliverWithRetry(site.slug, actor.inbox, follow, `${me}#main-key`, keys.private_pem);
  console.log('[AP] follow', site.slug, '→', actor.id);
  // Follow + feature in one step → backfill their recent posts into the Cirkel right away.
  if (autoBoost) backfillFromOutbox(site.slug, actor.id).catch(() => {});
  return { ok: true, name: ai.name, handle: ai.handle, actor: actor.id };
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
  // Undo(Follow) MUST reference the original Follow's real id so the remote can correlate it
  // and drop the follow. The old `${me}#follow` fallback never matched anything → the unfollow
  // silently failed on the remote. With no stored follow id (legacy row), skip the network Undo
  // rather than send an unmatchable one. Deliver durably via the retry queue.
  if (row && row.inbox && row.follow_id) {
    const undo = { '@context': AP_CONTEXT, id: `${me}/undo/${Date.now()}-${rid()}`, type: 'Undo', actor: me, object: { id: row.follow_id, type: 'Follow', actor: me, object: actorUri } };
    deliverWithRetry(site.slug, row.inbox, undo, `${me}#main-key`, keys.private_pem);
  } else if (row && row.inbox) {
    console.warn('[AP] unfollow', site.slug, '→', actorUri, '— no stored follow id; removed locally only (legacy follow, remote may keep it)');
  }
  fwStmts().del.run(site.slug, actorUri);
  return { ok: true };
}

// Send a Like or Announce (boost) on a remote note FROM this site.
export async function sendInteraction(site, kind, targetNoteId, authorUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !targetNoteId) return { error: 'config' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  // 'unboost' = Undo(Announce): retracts a boost so followers' servers remove the
  // reblog (matched on actor+object — no record of the original Announce needed).
  const fanout = (kind === 'boost' || kind === 'unboost'); // also goes to our followers
  const followersCol = `${me}/followers`;
  // Address the original author in cc so their server (Mastodon, WordPress/ActivityPub, …)
  // attributes the boost to their post and notifies them — without this, a shared-inbox
  // receiver has nothing to route the Announce to. Non-fragment activity ids + a `published`
  // stamp keep us aligned with what Mastodon emits.
  const audience = authorUri ? [followersCol, authorUri] : [followersCol];
  let act;
  if (kind === 'unboost' || kind === 'unlike') {
    // Undo(Announce) retracts a boost; Undo(Like) un-favourites (matched on actor+object,
    // no record of the original activity needed — Mastodon honours both).
    const inner = kind === 'unboost' ? 'Announce' : 'Like';
    act = {
      '@context': AP_CONTEXT,
      id: `${me}/undo/${Date.now()}-${rid()}`, type: 'Undo', actor: me,
      object: { id: `${me}/${inner.toLowerCase()}/${Date.now()}-${rid()}`, type: inner, actor: me, object: targetNoteId },
    };
    if (kind === 'unboost') { act.to = [PUBLIC]; act.cc = audience; }
  } else {
    const type = kind === 'boost' ? 'Announce' : 'Like';
    act = {
      '@context': AP_CONTEXT,
      id: `${me}/${type.toLowerCase()}/${Date.now()}-${rid()}`,
      type, actor: me, object: targetNoteId,
    };
    if (type === 'Announce') { act.published = new Date().toISOString(); act.to = [PUBLIC]; act.cc = audience; }
  }
  const inboxes = new Set();
  // Author first, via their PERSONAL inbox (not the shared one) so a multi-user receiver
  // routes the Announce/Like to the right post unambiguously.
  if (authorUri) { const a = await fetchActor(authorUri).catch(() => null); if (a) inboxes.add(a.inbox || (a.endpoints && a.endpoints.sharedInbox)); }
  if (fanout) { for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox); }
  // Queue each delivery (immediate attempt + backoff retries on failure via ap_delivery)
  // instead of a single fire-and-forget POST, so a transient hiccup at the receiver doesn't
  // silently lose the boost — same durability a new post (deliverCreate) already gets.
  let queued = 0;
  for (const inbox of [...inboxes].filter(Boolean)) { deliverWithRetry(site.slug, inbox, act, `${me}#main-key`, keys.private_pem); queued++; }
  console.log('[AP]', kind, site.slug, '→', targetNoteId, 'queued', queued, 'inbox(es)');
  return { ok: true, delivered: queued };
}

// Notifications inbox: new followers + replies/likes/boosts on this site's posts.
export function getNotifications(slug, limit) {
  // Per-source cap scales with the requested limit so Messages can page deep
  // (Load more). Bounded so a huge offset can't ask for unbounded rows.
  const L = Math.min(1000, Math.max(80, limit || 60));
  const out = [];
  try {
    for (const f of db.prepare('SELECT actor_uri, created_at FROM ap_followers WHERE slug = ? ORDER BY created_at DESC LIMIT ?').all(slug, L)) {
      out.push({ type: 'follow', handle: deriveHandle(f.actor_uri), url: f.actor_uri, created_at: f.created_at });
    }
  } catch { /* ignore */ }
  try {
    const rows = db.prepare(`
      SELECT i.kind, i.actor_name, i.actor_handle, i.actor_url, i.actor_icon, i.content, i.created_at, i.visibility,
             p.slug AS post_slug, p.title AS post_title
      FROM ap_interactions i LEFT JOIN posts p ON p.id = i.post_id
      WHERE p.site_id = (SELECT id FROM sites WHERE slug = ?)
      ORDER BY i.created_at DESC LIMIT ?
    `).all(slug, L);
    for (const r of rows) out.push({
      type: r.kind, name: r.actor_name, handle: r.actor_handle, url: r.actor_url, icon: r.actor_icon,
      content: stripLeadingMentions(r.content), post_slug: r.post_slug, post_title: r.post_title, created_at: r.created_at,
      // followers/direct = a private message to the owner (not on the public thread) → 🔒 in Messages
      visibility: r.visibility || 'public',
    });
  } catch { /* ignore */ }
  try {
    for (const r of db.prepare('SELECT actor_uri, actor_name, actor_handle, actor_icon, content, created_at FROM ap_reports WHERE slug = ? ORDER BY created_at DESC LIMIT ?').all(slug, L)) {
      out.push({ type: 'report', name: r.actor_name, handle: r.actor_handle, url: r.actor_uri, icon: r.actor_icon, content: r.content, created_at: r.created_at });
    }
  } catch { /* ignore */ }
  try {
    for (const r of db.prepare('SELECT object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, actor_url, content, created_at FROM ap_mentions WHERE slug = ? ORDER BY created_at DESC LIMIT ?').all(slug, L)) {
      out.push({ type: 'mention', name: r.actor_name, handle: r.actor_handle, url: r.actor_url || r.actor_uri, icon: r.actor_icon, content: stripLeadingMentions(r.content), note_url: r.note_url || r.object_uri, created_at: r.created_at });
    }
  } catch { /* ignore */ }
  // Your own polls that have closed → a "results are in" item, derived read-time
  // from poll_json (Scheduler marks closed=1) with the tally via ownPollView.
  try {
    const site = db.prepare('SELECT id FROM sites WHERE slug = ?').get(slug);
    if (site) {
      const polls = db.prepare(`
        SELECT id, slug, title, poll_json FROM posts
        WHERE site_id = ? AND poll_json IS NOT NULL
          AND json_extract(poll_json, '$.closed') = 1
          AND json_extract(poll_json, '$.endTime') IS NOT NULL
        ORDER BY json_extract(poll_json, '$.endTime') DESC LIMIT 20`).all(site.id);
      for (const p of polls) {
        const view = ownPollView(p);
        if (!view) continue;
        let endTime = null; try { endTime = JSON.parse(p.poll_json).endTime; } catch { /* keep null */ }
        out.push({ type: 'poll_done', post_slug: p.slug, post_title: p.title, poll: view, created_at: endTime || null });
      }
    }
  } catch { /* ignore */ }
  // NaN-safe sort: one row with a missing/garbled created_at would otherwise make the
  // comparator return NaN and scramble the WHOLE ordering (seen live: follow rows landing
  // between likes, which also broke Messages' like-grouping).
  out.sort((a, b) => _msgTs(b) - _msgTs(a));
  return out.slice(0, limit || 60);
}
function _msgTs(x) { const t = Date.parse((x && x.created_at) || ''); return Number.isFinite(t) ? t : 0; }

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
// Vote on a remote fediverse poll (a cached Question). A ballot = a Create(Note) carrying only a
// `name` (the chosen option) + inReplyTo the Question, addressed to the poll's author — the
// Mastodon-standard vote. Records our choice locally + optimistically bumps the counts; the
// author's Update(Question) refreshes the authoritative totals when it arrives.
export async function voteOnPoll(site, questionId, choices) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !questionId) return { error: 'config' };
  let row; try { row = db.prepare('SELECT author_uri, poll_json FROM ap_timeline WHERE id = ? AND slug = ? LIMIT 1').get(questionId, site.slug); } catch { /* ignore */ }
  if (!row || !row.poll_json) return { error: 'not_found' };
  let poll; try { poll = JSON.parse(row.poll_json); } catch { return { error: 'not_found' }; }
  if (poll.closed) return { error: 'closed' };
  if (poll.voted) return { error: 'already' };
  const valid = new Set(poll.options.map((o) => o.name));
  const picks = (Array.isArray(choices) ? choices : [choices]).map(String).filter((c) => valid.has(c));
  if (!picks.length) return { error: 'invalid' };
  const chosen = poll.multiple ? [...new Set(picks)] : [picks[0]];
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const authorUri = row.author_uri || null;
  const author = authorUri ? await fetchActor(authorUri).catch(() => null) : null;
  const inbox = author && (author.inbox || (author.endpoints && author.endpoints.sharedInbox));
  if (!inbox) return { error: 'unreachable' };
  for (const name of chosen) {
    const nid = `${me}/votes/${Date.now()}-${rid()}`;
    const note = { id: nid, type: 'Note', attributedTo: me, to: authorUri ? [authorUri] : [], name, inReplyTo: questionId, published: new Date().toISOString() };
    const create = { '@context': AP_CONTEXT, id: `${nid}/activity`, type: 'Create', actor: me, to: note.to, object: note };
    deliverWithRetry(site.slug, inbox, create, `${me}#main-key`, keys.private_pem);
  }
  // Local optimistic update (authoritative counts arrive via the author's Update(Question)).
  poll.voted = poll.multiple ? chosen : chosen[0];
  for (const o of poll.options) if (chosen.includes(o.name)) o.count = (o.count || 0) + 1;
  if (poll.voters != null) poll.voters += 1;
  try { db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(poll), questionId, site.slug); } catch { /* ignore */ }
  return { ok: true };
}

// Vote on ANY fediverse poll by URL (the interact page) — no timeline cache needed. Fetches
// the Question fresh, validates the choice(s), and casts the Mastodon-standard ballot (a
// Create(Note) with `name` + inReplyTo) straight to the poll's author. Used for polls you find
// by URL, not just ones from accounts you follow (which go through voteOnPoll via /news).
export async function voteOnRemotePoll(site, questionUrl, choices) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !/^https?:\/\//i.test(String(questionUrl || ''))) return { error: 'config' };
  const q = await fetchActor(questionUrl).catch(() => null); // AP GET (SSRF-guarded)
  if (!q || q.type !== 'Question' || !q.id) return { error: 'not_found' };
  const poll = parsePoll(q);
  if (!poll) return { error: 'not_found' };
  if (poll.closed) return { error: 'closed' };
  const valid = new Set(poll.options.map((o) => o.name));
  const picks = (Array.isArray(choices) ? choices : [choices]).map(String).filter((c) => valid.has(c));
  if (!picks.length) return { error: 'invalid' };
  const chosen = poll.multiple ? [...new Set(picks)] : [picks[0]];
  const authorUri = actorUriOf(q.attributedTo);
  const author = authorUri ? await fetchActor(authorUri).catch(() => null) : null;
  const inbox = author && (author.inbox || (author.endpoints && author.endpoints.sharedInbox));
  if (!inbox) return { error: 'unreachable' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  for (const name of chosen) {
    const nid = `${me}/votes/${Date.now()}-${rid()}`;
    const note = { id: nid, type: 'Note', attributedTo: me, to: [authorUri], name, inReplyTo: q.id, published: new Date().toISOString() };
    const create = { '@context': AP_CONTEXT, id: `${nid}/activity`, type: 'Create', actor: me, to: note.to, object: note };
    deliverWithRetry(site.slug, inbox, create, `${me}#main-key`, keys.private_pem);
  }
  return { ok: true };
}

// Report a remote post or account to its home instance (moderation). Sends the Mastodon-standard
// AS2 `Flag`: object = [reported account, reported status?], content = the reason, delivered to the
// reported account's inbox so their instance's moderators receive it. objectUri = a post URL (its
// author is resolved + included) OR pass actorUri to report an account directly.
export async function sendReport(site, { objectUri, actorUri, reason }) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  let targetActor = actorUri || null;
  let noteUri = null;
  if (objectUri && /^https?:\/\//i.test(objectUri)) {
    const note = await apGetJson(objectUri).catch(() => null);
    if (note && note.id) { noteUri = note.id; if (!targetActor) targetActor = actorUriOf(note.attributedTo); }
    else if (!targetActor) return { error: 'not_found' };
  }
  if (!targetActor || !/^https?:\/\//i.test(targetActor)) return { error: 'not_found' };
  const actor = await fetchActor(targetActor).catch(() => null);
  const inbox = actor && (actor.inbox || (actor.endpoints && actor.endpoints.sharedInbox)); // personal inbox → their moderators
  if (!inbox) return { error: 'unreachable' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const object = [targetActor];
  if (noteUri && noteUri !== targetActor) object.push(noteUri);
  const flag = {
    '@context': AP_CONTEXT,
    id: `${me}#report-${Date.now()}-${rid()}`,
    type: 'Flag',
    actor: me,
    content: String(reason == null ? '' : reason).slice(0, 3000),
    object, // [account, status?] — Mastodon's Flag shape
    to: [targetActor],
  };
  deliverWithRetry(site.slug, inbox, flag, `${me}#main-key`, keys.private_pem);
  return { ok: true };
}

export function isBlockedAny(actorUri) {
  if (!actorUri) return false;
  let domain = ''; try { domain = new URL(actorUri).host; } catch { /* ignore */ }
  try { return !!db.prepare("SELECT 1 FROM ap_blocks WHERE (kind='actor' AND target=?) OR (kind='domain' AND target=?) LIMIT 1").get(actorUri, domain); }
  catch { return false; }
}

function purgeBlocked(kind, target) {
  try {
    if (kind === 'domain') {
      // Exact host match (a URL LIKE over-/under-matches: it misses bare-domain or :port
      // actor URIs and can catch look-alikes). Filter by parsed host, same as isBlockedAny.
      const purge = (table, col) => {
        let rows = [];
        try { rows = db.prepare(`SELECT DISTINCT ${col} AS u FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`).all(); } catch { return; }
        const del = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`);
        for (const r of rows) { let h = ''; try { h = new URL(r.u).host; } catch { /* skip */ } if (h === target) { try { del.run(r.u); } catch { /* ignore */ } } }
      };
      purge('ap_interactions', 'actor_uri');
      purge('ap_timeline', 'author_uri');
      purge('ap_followers', 'actor_uri');
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
  AP_CONTEXT, getOrCreateKeys, apWants, sendAP, actorId, noteId,
  buildActor, buildNote, buildCreate, buildOutbox, buildFollowers, buildFollowing, buildFeatured,
  followerCount, deliver, fetchActor, verifyRequest, handleInbox, deliverCreate, deliverDelete, deliverUpdate, deliverActorUpdate, resyncFeaturedPins,
  getInteractions, getInteractionById, setInteractionBoosted, setInteractionLiked, setMyReaction, getMyReactions, buildReplyNote, getOutboxNote, deliverReply, resolveRemoteNote,
  listOutbox, deliverOutboxDelete, deliverOutboxUpdate, deliverDirectNote,
  webfingerResolve, followActor, resolveRemoteActor, unfollowActor, listFollowing, setAutoBoost, backfillFromOutbox, getTimeline, sendInteraction, voteOnPoll, voteOnRemotePoll,
  parseOwnPoll, pollTally, ownPollView, deliverPollUpdate, maybeCrawlThread, sendReport, localMentionSlugs,
  autoBoostCount, boostedCount, markBoosted, unmarkBoosted, markLiked, unmarkLiked, getTimelineReaction, upsertBoostedNote, getCirkelPosts, getCirkelMembers, selfHealTimeline,
  getNotifications, listBlocks, isBlockedAny, blockTarget, unblock,
  deliverWithRetry, enqueueDelivery, processDeliveryQueue, startDeliveryWorker,
  getReplyUris, markNotificationsSeen, countUnseenNotifications, hasPlayableAudio,
  linkifyBody, bakePostContent, bakePostContentWithMentions, listFollowers, removeFollower, listConnections,
  noteVisibility, isRejectedObject, rejectInteraction, interactionReportTarget,
  getMessages, notificationsSeenAt, ingestOutboxActivity, c2sVisibility, actorDisplay, buildActorRef, prefersEnriched,
};
