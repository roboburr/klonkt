import express from 'express';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import ejs from 'ejs';
import db from '../config/database.js';
import { requireAuth, requireSiteManager, isViewer } from '../middleware/auth.js';
import { renderPage } from '../middleware/render.js';
import { recordPageview, recordPostView } from '../services/StatsService.js';
import PermissionsService from '../services/PermissionsService.js';
import MarkdownService from '../services/MarkdownService.js';
import HtmlSanitizerService from '../services/HtmlSanitizerService.js';
import AudioEmbedService from '../services/AudioEmbedService.js';
import PlaylistService from '../services/PlaylistService.js';
import { audioEnabled } from '../config/features.js';
import { audioUrl } from '../services/AudioStreamService.js';
import { toWebp } from '../services/ImageWebpService.js';
import VideoCoverService from '../services/VideoCoverService.js';
import ActivityPubService from '../services/ActivityPubService.js';
import MusicMeta from '../services/MusicMeta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POST_IMAGES_DIR = path.resolve(
  process.env.POST_IMAGES_PATH ||
  path.join(__dirname, '..', '..', 'storage', 'media', 'post-images')
);
fs.mkdirSync(POST_IMAGES_DIR, { recursive: true });

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, POST_IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});
const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE_EXT.has(ext)) {
      return cb(new Error('Image must be jpg/png/webp/gif'));
    }
    cb(null, true);
  },
});

// Generates a unique slug within the site: 'title', 'title-2', 'title-3', …
// A second post with the same title is NOT rejected ("already exists"),
// but automatically gets a free suffix. exceptId = the post being updated
// (allowed to keep its own slug).
function uniqueSlug(siteId, base, exceptId = null) {
  let candidate = base;
  let n = 2;
  for (;;) {
    const row = exceptId
      ? db.prepare('SELECT id FROM posts WHERE site_id = ? AND slug = ? AND id != ?').get(siteId, candidate, exceptId)
      : db.prepare('SELECT id FROM posts WHERE site_id = ? AND slug = ?').get(siteId, candidate);
    if (!row) return candidate;
    candidate = `${base}-${n++}`;
  }
}

const router = express.Router();

// ==================== UPLOAD IMAGE (cover or content) ====================
// Returns JSON {url} so the editor can stick it into the cover field or
// insert a markdown ![](url) into content.
router.post('/posts/upload-image', requireAuth, (req, res) => {
  imageUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const name = toWebp(req.file);
    const url = '/media/post-images/' + name;
    // An animated WebP cover → also make a muted loop MP4 (Safari plays it smoothly where the
    // animated WebP is janky on iOS). Best-effort; on failure we just return the still image.
    // The editor stores `video` in the hidden cover_video_url field for the cover.
    let video = null;
    try {
      const src = path.join(POST_IMAGES_DIR, name);
      if (VideoCoverService.isAnimatedWebp(src)) {
        const r = await VideoCoverService.animatedWebpToVideo(src, POST_IMAGES_DIR, path.basename(name, path.extname(name)) + '-v');
        if (r) video = '/media/post-images/' + path.basename(r.videoPath);
      }
    } catch { /* keep the still image */ }
    res.json({ url, video, size: req.file.size, mime: req.file.mimetype });
  });
});

const RESERVED_SLUGS = new Set([
  'auth', 'admin', 'login', 'register', 'logout',
  'archive', 'search', 'account', 'sites', 'comments',
  'posts', 'media', 'audio', 'forum',
  'tag', 'type', 'user', 'users', 'artiesten', 'leden', 'favorieten', 'feed.xml', 'atom.xml', 'sitemap.xml',
  'manifest.webmanifest', 'sw.js', 'favicon.ico', 'favicon.svg', 'assets',
  'authorize_interaction', 'fediverse', 'news', 'following', 'notifications', 'blocking',
]);

/**
 * Parse the form's `pinned` field into a non-negative integer rank.
 * Empty / undefined / NaN / negative → 0 (= not pinned).
 * Otherwise: integer rank (1 = top of pinned stack, 2 = below, ...).
 *
 * Multiple posts CAN share the same rank — UI shows them tiebroken by
 * published_at DESC. Saying #2 twice doesn't error, it just duplicates.
 * (We don't enforce uniqueness at this layer because race conditions and
 * "swap two ranks" workflows are easier without a UNIQUE constraint.)
 */
function parsePinnedRank(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// ==================== HOME (Posts list) ====================
router.get('/', (req, res) => {
  const site = res.locals.site;

  if (!site) {
    return renderPage(req, res, 'pages/welcome', {
      pageTitle: 'Welcome',
      bodyClass: 'on-special',
    });
  }

  // Pinned first — ordered by their rank (1 = top, 2 = below, etc).
  // pinned column is now an integer rank: 0 = not pinned, 1+ = pinned at
  // that position. Older boolean usage where pinned was always 1 still
  // works because integer ranks 1, 2, 3 sort the same as a flat 1.
  const pinnedPosts = db.prepare(`
    SELECT p.*, u.username as author_username
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.site_id = ? AND p.status = 'published' AND p.pinned > 0
    ORDER BY p.pinned ASC, p.published_at DESC
  `).all(site.id);

  // Regular posts: anything with pinned = 0
  const posts = db.prepare(`
    SELECT p.*, u.username as author_username
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.site_id = ? AND p.status = 'published' AND p.pinned = 0
    ORDER BY p.published_at DESC
    LIMIT 30
  `).all(site.id);

  recordPageview(site.id, req);

  renderPage(req, res, 'pages/home', {
    pinnedPosts,
    posts,
    pageTitle: site.title,
    socialDescr: site.description || site.tagline || '',
    bodyClass: 'on-home',
  });
});

// ==================== NEW POST FORM ====================
router.get('/posts/new', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  if (!PermissionsService.canCreatePost(req.session.user, site)) {
    return res.status(403).send('No permission');
  }

  renderPage(req, res, 'pages/post-edit', {
    post: {
      id: uuid(),
      title: '', slug: '', content: '', excerpt: '',
      status: 'draft', pinned: 0, tags: [],
      cover_image_url: '',
    },
    isNew: true,
    pageTitle: 'New post',
    bodyClass: 'on-special',
  });
});

// ==================== CREATE POST ====================
// ── Per-post audio federation ──────────────────────────────────────────────
// "Share audio on the fediverse" is a per-post choice in the editor, but the underlying
// flag is per track (audio_tracks.fedi_open — it gates the file + drives the AS2 Audio
// attachment). NB: the file gate is per file, so opening a track in one post makes its file
// fetchable for every post that reuses it.
function setAudioFediOpen(siteId, content, open) {
  const val = open ? 1 : 0;
  const c = content || '';
  try {
    for (const m of c.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) db.prepare('UPDATE audio_tracks SET fedi_open = ? WHERE id = ? AND site_id = ?').run(val, m[1], siteId);
    for (const m of c.matchAll(/\[\[album:([^\]]+)\]\]/g)) db.prepare('UPDATE audio_tracks SET fedi_open = ? WHERE site_id = ? AND album = ?').run(val, siteId, m[1].trim());
    for (const m of c.matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) db.prepare('UPDATE audio_tracks SET fedi_open = ? WHERE id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id = ?)').run(val, m[1]);
  } catch { /* non-fatal */ }
}
// True when the post references hosted audio AND all of it is currently fedi_open (drives the
// editor checkbox's initial state).
function postAudioFediOpen(siteId, content) {
  const c = content || '';
  if (!/\[\[(track|album|playlist):/i.test(c)) return false;
  let total = 0, open = 0;
  const tally = (r) => { if (r && r.media_id) { total++; if (r.fedi_open) open++; } };
  try {
    for (const m of c.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) tally(db.prepare('SELECT fedi_open, media_id FROM audio_tracks WHERE id = ? AND site_id = ?').get(m[1], siteId));
    for (const m of c.matchAll(/\[\[album:([^\]]+)\]\]/g)) for (const r of db.prepare('SELECT fedi_open, media_id FROM audio_tracks WHERE site_id = ? AND album = ? AND media_id IS NOT NULL').all(siteId, m[1].trim())) tally(r);
    for (const m of c.matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) for (const r of db.prepare('SELECT t.fedi_open, t.media_id FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? AND t.media_id IS NOT NULL').all(m[1])) tally(r);
  } catch { /* non-fatal */ }
  return total > 0 && open === total;
}

router.post('/posts/create', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site || !PermissionsService.canCreatePost(req.session.user, site)) {
    return res.status(403).send('No permission');
  }

  const { title, slug, content, excerpt, status, pinned, cover_image_url, tags, noindex, type } = req.body;
  const fanOnly = req.body.fan_only ? 1 : 0;
  const nsfw = req.body.nsfw ? 1 : 0;
  const cw = (req.body.content_warning || '').trim().slice(0, 200);

  // Content arrives as user-authored HTML from the WYSIWYG editor — sanitize
  // before storage. Shortcode text tokens like [[track:UUID]] live in text
  // nodes and pass through untouched.
  const cleanContent = HtmlSanitizerService.sanitize(content || '');

  // Generate slug from title if empty
  let finalSlug = (slug || title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!finalSlug) return res.status(400).send('Title or slug required');
  if (RESERVED_SLUGS.has(finalSlug)) finalSlug = `${finalSlug}-post`;

  // Duplicate title/slug? Make it unique automatically (title-2, title-3, …) instead of rejecting.
  finalSlug = uniqueSlug(site.id, finalSlug);

  const validTypes = new Set(['post', 'foto', 'video', 'audio']);
  const finalType = validTypes.has(type) ? type : 'post';
  const postId = uuid();
  const now = new Date().toISOString();
  let finalStatus = status || 'draft';
  let publishedAt = finalStatus === 'published' ? now : null;
  // Release planning: published + a future publish_at -> 'scheduled'
  // (the Scheduler makes it live at that moment). Past/empty -> live immediately.
  let publishAt = null;
  const pa = Date.parse(req.body.publish_at || '');
  if (req.body.schedule_enabled && finalStatus === 'published' && Number.isFinite(pa) && pa > Date.now()) {
    finalStatus = 'scheduled';
    publishAt = new Date(pa).toISOString();
    publishedAt = null;
  }

  db.prepare(`
    INSERT INTO posts (
      id, site_id, slug, author_id, title, content, excerpt,
      status, cover_image_url, cover_video_url, pinned, tags, type, noindex, fan_only, nsfw, content_warning, publish_at,
      created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    postId, site.id, finalSlug, req.session.user.id,
    title || finalSlug, cleanContent, excerpt || '',
    finalStatus, cover_image_url || null, (req.body.cover_video_url || null), parsePinnedRank(pinned),
    JSON.stringify((tags || '').split(',').map(t => t.trim()).filter(Boolean)),
    finalType, noindex ? 1 : 0, fanOnly, nsfw, cw, publishAt,
    now, now, publishedAt
  );

  // Per-post "share audio on the fediverse" → set fedi_open on this post's hosted tracks
  // BEFORE federating, so the Create note carries the right Audio attachments.
  setAudioFediOpen(site.id, cleanContent, req.body.fedi_open_audio);

  if (finalStatus === 'published') {
    try {
      db.prepare(
        'INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)'
      ).run(HtmlSanitizerService.toPlainText(cleanContent), title || '', req.session.user.username, postId);
    } catch (e) { /* FTS index issues are non-fatal */ }

    // ActivityPub: federate a freshly published post to followers. fan_only → delivered
    // to followers but addressed followers-only (option A: "fans" = your fedi followers).
    if (status === 'published') {
      ActivityPubService.deliverCreate(site, {
        id: postId, slug: finalSlug, title: title || finalSlug,
        content: cleanContent, cover_image_url: cover_image_url || null,
        published_at: publishedAt, created_at: now, fan_only: fanOnly, nsfw, content_warning: cw,
      }).catch(() => { /* best-effort */ });
    }
  }

  // HTMX request -> return redirect header
  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', `${res.locals.siteUrlBase || ''}/${finalSlug}`);
    return res.send('OK');
  }

  res.redirect(`${res.locals.siteUrlBase || ''}/${finalSlug}`);
});

// ==================== EDIT POST FORM ====================
router.get('/posts/:slug/edit', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const post = db.prepare(
    'SELECT * FROM posts WHERE site_id = ? AND slug = ?'
  ).get(site.id, req.params.slug);

  if (!post) return res.status(404).send('Post not found');
  if (!PermissionsService.canEditPost(req.session.user, post, site)) {
    return res.status(403).send('No permission');
  }

  if (post.tags) {
    try { post.tags = JSON.parse(post.tags); } catch { post.tags = []; }
  } else {
    post.tags = [];
  }

  renderPage(req, res, 'pages/post-edit', {
    post,
    isNew: false,
    fediOpenAudio: postAudioFediOpen(site.id, post.content),
    pageTitle: 'Edit: ' + (post.title || 'Untitled'),
    bodyClass: 'on-special',
  });
});

// ==================== SAVE POST ====================
router.post('/posts/:slug/save', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const post = db.prepare(
    'SELECT * FROM posts WHERE site_id = ? AND slug = ?'
  ).get(site.id, req.params.slug);

  if (!post) return res.status(404).send('Post not found');
  if (!PermissionsService.canEditPost(req.session.user, post, site)) {
    return res.status(403).send('No permission');
  }

  const { title, content, excerpt, status, pinned, cover_image_url, tags, noindex, type } = req.body;
  const fanOnly = req.body.fan_only ? 1 : 0;
  const nsfw = req.body.nsfw ? 1 : 0;
  const cw = (req.body.content_warning || '').trim().slice(0, 200);
  const newSlug = req.body.slug;
  const action = req.body.action || 'save';
  const validTypes = new Set(['post', 'foto', 'video', 'audio']);
  const finalType = validTypes.has(type) ? type : (post.type || 'post');

  // Sanitize before storage — same pipeline as create.
  const cleanContent = HtmlSanitizerService.sanitize(content || '');

  let finalSlug = post.slug;
  if (newSlug && newSlug !== post.slug) {
    const cleaned = newSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const safe = RESERVED_SLUGS.has(cleaned) ? `${cleaned}-post` : cleaned;
    // Duplicate slug? Make it unique automatically instead of rejecting (own post may keep its slug).
    finalSlug = uniqueSlug(site.id, safe, post.id);
  }

  const now = new Date().toISOString();
  let finalStatus = status || post.status;
  let publishedAt = post.published_at;

  if (action === 'publish') {
    finalStatus = 'published';
    if (!publishedAt) publishedAt = now;
  }

  // Release planning: published + future publish_at -> 'scheduled'.
  let publishAt = null;
  const pa = Date.parse(req.body.publish_at || '');
  if (req.body.schedule_enabled && finalStatus === 'published' && Number.isFinite(pa) && pa > Date.now()) {
    finalStatus = 'scheduled';
    publishAt = new Date(pa).toISOString();
    publishedAt = null;
  }

  db.prepare(`
    UPDATE posts SET
      title = ?, content = ?, excerpt = ?, status = ?,
      cover_image_url = ?, cover_video_url = ?, pinned = ?, tags = ?,
      type = ?, noindex = ?, fan_only = ?, nsfw = ?, content_warning = ?, publish_at = ?,
      slug = ?, published_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    title, cleanContent, excerpt, finalStatus,
    cover_image_url || null, (req.body.cover_video_url || null), parsePinnedRank(pinned),
    JSON.stringify((tags || '').split(',').map(t => t.trim()).filter(Boolean)),
    finalType, noindex ? 1 : 0, fanOnly, nsfw, cw, publishAt,
    finalSlug, publishedAt, now, post.id
  );

  // Per-post "share audio on the fediverse" → set fedi_open on this post's hosted tracks
  // BEFORE federating, so the Update/Create note carries the right Audio attachments.
  setAudioFediOpen(site.id, cleanContent, req.body.fedi_open_audio);

  // Update FTS
  try {
    db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(post.id);
    if (finalStatus === 'published') {
      db.prepare(
        'INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)'
      ).run(HtmlSanitizerService.toPlainText(cleanContent), title || '', req.session.user.username, post.id);
    }
  } catch (e) { /* FTS issues non-fatal */ }

  // ActivityPub: federate edits to followers. A post that BECOMES published →
  // Create (new post); an already-published post that's edited → Update (so
  // Mastodon refreshes its cached copy). fan_only → followers-only (option A).
  if (finalStatus === 'published') {
    const apPost = {
      id: post.id, slug: finalSlug, title: title || finalSlug,
      content: cleanContent, cover_image_url: cover_image_url || null,
      published_at: publishedAt, created_at: post.created_at, fan_only: fanOnly, nsfw, content_warning: cw,
    };
    if (post.status !== 'published') ActivityPubService.deliverCreate(site, apPost).catch(() => { /* best-effort */ });
    else ActivityPubService.deliverUpdate(site, apPost).catch(() => { /* best-effort */ });
  }

  // Pin/unpin/reorder → push Add/Remove activities so followers' instances update the
  // pinned order immediately (reliable, unlike re-fetching the cached featured collection).
  if ((post.pinned || 0) !== parsePinnedRank(pinned)) {
    const unpinned = (post.pinned || 0) > 0 && parsePinnedRank(pinned) === 0 ? [post.id] : [];
    ActivityPubService.resyncFeaturedPins(site, unpinned).catch(() => { /* best-effort */ });
  }

  res.redirect(`${res.locals.siteUrlBase || ''}/${finalSlug}`);
});

// ==================== DELETE POST ====================
router.post('/posts/:slug/delete', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const post = db.prepare(
    'SELECT * FROM posts WHERE site_id = ? AND slug = ?'
  ).get(site.id, req.params.slug);

  if (!post) return res.status(404).send('Not found');
  if (!PermissionsService.canDeletePost(req.session.user, post, site)) {
    return res.status(403).send('No permission');
  }

  // ActivityPub: tell followers the post is gone (Delete + Tombstone) if it was
  // federated (any published post now federates — fan_only goes followers-only).
  // Fire before the row is removed — we still have post.id (= the Note id).
  if (post.status === 'published') {
    ActivityPubService.deliverDelete(site, post).catch(() => { /* best-effort */ });
  }

  // Cascade: comments + FTS row, THEN the post itself.
  // FK constraints are ON (config/database.js), so a bare DELETE on posts
  // fails when comments still reference it.
  const cascade = db.transaction(() => {
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(post.id);
    try { db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(post.id); } catch {}
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  });
  cascade();

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', res.locals.siteUrlBase || '/');
    return res.send('OK');
  }
  res.redirect(res.locals.siteUrlBase || '/');
});

// ==================== ARCHIVE ====================
router.get('/archive', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const posts = db.prepare(`
    SELECT p.*, u.username as author_username
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.site_id = ? AND p.status = 'published'
    ORDER BY p.published_at DESC
  `).all(site.id);

  // Group by year/month
  const grouped = {};
  for (const post of posts) {
    if (!post.published_at) continue;
    const d = new Date(post.published_at);
    const year = d.getFullYear();
    const month = d.getMonth();
    const monthName = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'][month];

    if (!grouped[year]) grouped[year] = {};
    if (!grouped[year][monthName]) grouped[year][monthName] = [];
    grouped[year][monthName].push(post);
  }

  renderPage(req, res, 'pages/archive', {
    grouped,
    totalPosts: posts.length,
    pageTitle: 'Archive - ' + site.title,
    bodyClass: 'on-archive',
  });
});

// Local likes/favourites are removed — engagement is fediverse-only now
// (the ⭐ on a post likes via the fediverse). No post_likes, no /favorieten.

// Newer/Older neighbours across ALL posts in feed order. Shared by the full
// post render and the fan gate (premium fan_only) so navigation is consistent
// everywhere. Solo: within the site (pinned first, then date). Hub: globally by date.
function postNeighbors(site, post, isHub) {
  const urlBaseFor = (p) => (isHub && p && p.site_slug) ? `/user/${p.site_slug}` : '';
  const ordered = isHub
    ? db.prepare(`
        SELECT p.id, p.slug, p.title, p.pinned, s.slug AS site_slug
        FROM posts p JOIN sites s ON s.id = p.site_id
        WHERE p.status = 'published'
        ORDER BY p.published_at DESC
      `).all()
    : db.prepare(`
        SELECT id, slug, title, pinned FROM posts
        WHERE site_id = ? AND status = 'published'
        ORDER BY (pinned = 0) ASC, pinned ASC, published_at DESC
      `).all(site.id);
  const idx = ordered.findIndex((p) => p.id === post.id);
  const newerPost = idx > 0 ? ordered[idx - 1] : null;
  const olderPost = (idx >= 0 && idx < ordered.length - 1) ? ordered[idx + 1] : null;
  if (newerPost) newerPost._urlBase = urlBaseFor(newerPost);
  if (olderPost) olderPost._urlBase = urlBaseFor(olderPost);
  return { newerPost, olderPost };
}

// ==================== REMOTE INTERACTION (reply to a fediverse post as your site) ====================
// Standard fediverse "reply from your own server" landing endpoint. A post page
// elsewhere bounces the visitor here with ?uri=<remote post>; the site owner
// composes a reply that federates back to that post.
router.get('/authorize_interaction', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  const uri = (req.query.uri || '').toString();
  const sent = !!req.query.sent;
  const followed = !!req.query.followed;
  let target = null, followTarget = null;
  if (!sent && !followed && uri) {
    try { target = await ActivityPubService.resolveRemoteNote(uri); } catch { /* ignore */ }
    // Not a post? Maybe the URI is a profile/actor → offer Follow, not reply.
    if (!target) { try { followTarget = await ActivityPubService.resolveRemoteActor(uri); } catch { /* ignore */ } }
  }
  renderPage(req, res, 'pages/authorize-interaction', {
    pageTitle: 'Interacteer via de fediverse',
    bodyClass: 'on-special',
    uri,
    target,
    followTarget,
    sent,
    followed,
    liked: !!req.query.liked,
    boosted: !!req.query.boosted,
    reacted: (site && uri) ? ActivityPubService.getMyReactions(site.slug, uri) : { liked: false, boosted: false },
    siteTitle: site ? site.title : '',
  });
});

// ⭐ Like / unlike a remote post from your own site (toggle on the interact page).
router.post('/authorize_interaction/like', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const uri = (req.body.uri || '').toString();
  let on = false;
  if (site && uri) {
    on = !ActivityPubService.getMyReactions(site.slug, uri).liked;
    ActivityPubService.resolveRemoteNote(uri)
      .then((note) => note && ActivityPubService.sendInteraction(site, on ? 'like' : 'unlike', note.object_uri || uri, note.actor_uri))
      .catch((e) => console.warn('[AP] remote like failed:', e.message));
    ActivityPubService.setMyReaction(site.slug, uri, 'like', on);
  }
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true, on });
  res.redirect('/authorize_interaction?uri=' + encodeURIComponent(uri));
});

// 🔁 Boost / unboost a remote post from your own site (toggle on the interact page).
// Also flags it for the Cirkel (markBoosted is a no-op if the post isn't in your timeline).
router.post('/authorize_interaction/boost', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const uri = (req.body.uri || '').toString();
  let on = false;
  if (site && uri) {
    on = !ActivityPubService.getMyReactions(site.slug, uri).boosted;
    ActivityPubService.resolveRemoteNote(uri)
      .then((note) => {
        if (!note) return;
        const id = note.object_uri || uri;
        return Promise.resolve(ActivityPubService.sendInteraction(site, on ? 'boost' : 'unboost', id, note.actor_uri))
          // Boost → store the post in the timeline (even if you don't follow the author) so it
          // surfaces in the Cirkel; unboost → just clear the flag.
          .then(() => on ? ActivityPubService.upsertBoostedNote(site.slug, note) : ActivityPubService.unmarkBoosted(site.slug, id));
      })
      .catch((e) => console.warn('[AP] remote boost failed:', e.message));
    ActivityPubService.setMyReaction(site.slug, uri, 'boost', on);
  }
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true, on });
  res.redirect('/authorize_interaction?uri=' + encodeURIComponent(uri));
});

// Follow a remote actor from your own site (when the target is a profile, not a post).
router.post('/authorize_interaction/follow', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const uri = (req.body.uri || '').toString();
  if (site && uri) {
    ActivityPubService.followActor(site, uri)
      .catch((e) => console.warn('[AP] remote follow failed:', e.message));
  }
  res.redirect('/authorize_interaction?followed=1&uri=' + encodeURIComponent(uri));
});

router.post('/authorize_interaction', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const uri = (req.body.uri || '').toString();
  const text = (req.body.text || '').toString();
  if (site && uri && text.trim()) {
    // Resolve + deliver in the background so Send responds instantly.
    ActivityPubService.resolveRemoteNote(uri)
      .then((parent) => parent && ActivityPubService.deliverReply(site, { postId: parent.localPostId || '', postSlug: null, parent, text }))
      .catch((e) => console.warn('[AP] remote reply failed:', e.message));
  }
  res.redirect('/authorize_interaction?sent=1&uri=' + encodeURIComponent(uri));
});

// Manage / delete your own outbound fediverse replies (site owner only).
router.get('/fediverse', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const items = site ? ActivityPubService.listOutbox(site.slug) : [];
  renderPage(req, res, 'pages/authorize-interaction', {
    pageTitle: 'Mijn fediverse-reacties', bodyClass: 'on-special',
    manage: items, uri: '', target: null, sent: false, siteTitle: site ? site.title : '',
  });
});

router.post('/fediverse/:id/delete', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  if (site) {
    try { await ActivityPubService.deliverOutboxDelete(site, req.params.id); }
    catch (e) { console.warn('[AP] outbox delete failed:', e.message); }
  }
  res.redirect(req.get('Referer') || `${res.locals.siteUrlBase || ''}/fediverse`);
});

// Edit one of your own outbound fediverse replies (owner only) → sends an Update(Note).
router.post('/fediverse/:id/edit', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  if (site && String(req.body.text || '').trim()) {
    try { await ActivityPubService.deliverOutboxUpdate(site, req.params.id, req.body.text); }
    catch (e) { console.warn('[AP] outbox edit failed:', e.message); }
  }
  res.redirect(req.get('Referer') || `${res.locals.siteUrlBase || ''}/fediverse`);
});

// ==================== FEDIVERSE CLIENT: home timeline + following ====================
// Build a direct embed iframe for the first embeddable link (YouTube/Spotify/
// SoundCloud/Vimeo) in a remote post's content, so others' media plays inline.
function timelineEmbedHtml(html) {
  if (!html) return null;
  const re = /href=["']([^"']+)["']/gi; let m; const seen = new Set();
  while ((m = re.exec(html))) {
    const u = m[1]; if (seen.has(u)) continue; seen.add(u);
    let p; try { p = AudioEmbedService.detectProvider(u); } catch { p = null; }
    if (!p) continue;
    if (p.provider === 'youtube') return `<iframe class="tl-embed-frame" src="https://www.youtube-nocookie.com/embed/${p.id}" title="YouTube" loading="lazy" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    if (p.provider === 'spotify') return `<iframe class="tl-embed-frame tl-embed-spotify" src="https://open.spotify.com/embed/${p.type}/${p.id}" title="Spotify" loading="lazy" frameborder="0" allow="encrypted-media"></iframe>`;
    if (p.provider === 'soundcloud') return `<iframe class="tl-embed-frame tl-embed-sc" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(p.url)}&color=%23ff5500&visual=false" title="SoundCloud" loading="lazy" frameborder="0" allow="autoplay" scrolling="no"></iframe>`;
    if (p.provider === 'vimeo') return `<iframe class="tl-embed-frame" src="https://player.vimeo.com/video/${p.id}" title="Vimeo" loading="lazy" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
    if (p.provider === 'bandcamp') return `<iframe class="tl-embed-frame tl-embed-bandcamp" src="https://bandcamp.com/EmbeddedPlayer/url=${encodeURIComponent(u)}/size=large/bgcol=faf8f3/linkcol=c2410c/tracklist=false/transparent=true/" title="Bandcamp" loading="lazy" frameborder="0" allow="encrypted-media"></iframe>`;
    if (p.provider === 'applemusic') { const am = u.match(/music\.apple\.com\/([a-z]{2}\/(?:album|playlist|song)\/[^/?#]+\/[0-9]+)/i); if (am) return `<iframe class="tl-embed-frame tl-embed-apple" src="https://embed.music.apple.com/${am[1]}" title="Apple Music" loading="lazy" frameborder="0" allow="autoplay; encrypted-media"></iframe>`; }
  }
  return null;
}

// A federated Klonkt audio post renders as "🎵 … listen on <link>". Embed the remote
// Klonkt player (its /embed?post=<slug>). A single-segment path = a Klonkt post slug
// (skips Mastodon /@user/123). The origin is whitelisted in the response CSP frame-src.
function klonktAudioEmbed(html, url) {
  if (!html || !url || html.indexOf('🎵') < 0) return null;
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const slug = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!slug || slug.indexOf('/') >= 0) return null; // single segment only
  const src = u.origin + '/embed?post=' + encodeURIComponent(slug);
  // Drop the now-redundant "🎵 … listen on <site>" line — the embedded player below shows it.
  const content = html.replace(/<p>🎵[\s\S]*?<\/p>\s*/i, '');
  return { origin: u.origin, embedUrl: src, content, html: `<iframe class="tl-embed-frame tl-embed-klonkt" src="${src}" title="Audio" loading="lazy" frameborder="0" allow="autoplay; encrypted-media"></iframe>` };
}

router.get('/news', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const cspOrigins = new Set();
  const timeline = (site ? ActivityPubService.getTimeline(site.slug, 60) : []).map((p) => {
    let embedHtml = timelineEmbedHtml(p.content);
    let content = p.content;
    let embedUrl = null;
    if (!embedHtml) {
      const k = klonktAudioEmbed(p.content, p.url);
      if (k) { embedHtml = k.html; content = k.content; embedUrl = k.embedUrl; cspOrigins.add(k.origin); }
    }
    // embedUrl = the player's direct /embed?post=… URL. Surfaced so the view can offer a
    // top-level "open the player" link that works even when a browser shield/CSP blocks
    // the cross-site iframe (a full-page navigation is not a cross-site frame).
    return { ...p, content, embedHtml, embedUrl };
  });
  // Option A: allow the followed Klonkt sites' player iframes (you follow them) by
  // extending ONLY this response's CSP frame-src. The global policy stays locked down.
  if (cspOrigins.size) {
    const csp = res.getHeader('Content-Security-Policy');
    if (csp) {
      const extra = [...cspOrigins].join(' ');
      res.setHeader('Content-Security-Policy', String(csp).replace(/frame-src ([^;]*)/i, (m, g) => `frame-src ${g} ${extra}`));
    }
  }
  renderPage(req, res, 'pages/news', {
    pageTitle: 'News', bodyClass: 'on-special',
    timeline,
    success: req.query.success || null, error: req.query.error || null,
  });
});

// Volgend — manage the accounts you follow (+ per-account auto-boost toggles).
router.get('/following', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const following = site ? ActivityPubService.listFollowing(site.slug) : [];
  renderPage(req, res, 'pages/following', {
    pageTitle: 'Volgend', bodyClass: 'on-special',
    following,
    success: req.query.success || null, error: req.query.error || null,
  });
});

router.post('/news/follow', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  const handle = (req.body.handle || '').toString();
  let q = 'success=' + encodeURIComponent('Volgverzoek verstuurd');
  if (site && handle.trim()) {
    try {
      const r = await ActivityPubService.followActor(site, handle, !!req.body.auto_boost);
      if (r && r.error) q = 'error=' + encodeURIComponent(r.error === 'not_found' ? 'Account niet gevonden' : (r.error === 'unreachable' ? 'Server onbereikbaar' : 'Volgen mislukt'));
      else {
        q = 'success=' + encodeURIComponent('Je volgt nu ' + ((r && r.name) || handle));
      }
    } catch (e) { q = 'error=' + encodeURIComponent('Volgen mislukt'); }
  }
  res.redirect('/following?' + q);
});

router.post('/news/unfollow', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  const actorUri = (req.body.actor_uri || '').toString();
  if (site && actorUri) { try { await ActivityPubService.unfollowActor(site, actorUri); } catch (e) { /* ignore */ } }
  res.redirect('/following?success=' + encodeURIComponent('Ontvolgd'));
});

// Toggle "Featured" (show this account's posts in your Cirkel) on an account you follow.
router.post('/news/autoboost', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const actorUri = (req.body.actor_uri || '').toString();
  if (site && actorUri) ActivityPubService.setAutoBoost(site.slug, actorUri, !!req.body.auto_boost);
  res.redirect('/following?success=' + encodeURIComponent(req.body.auto_boost ? 'Uitgelicht ✨' : 'Niet meer uitgelicht'));
});

// Like / unlike a feed post — a toggle. Fetch request → JSON {on} (stay on the page,
// no banner); no-JS → redirect back.
router.post('/news/like', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  const note = (req.body.note || '').toString();
  let on = false;
  if (site && note) {
    on = !ActivityPubService.getTimelineReaction(site.slug, note).liked;
    try { await ActivityPubService.sendInteraction(site, on ? 'like' : 'unlike', note, (req.body.author || '').toString()); } catch (e) { /* ignore */ }
    if (on) ActivityPubService.markLiked(site.slug, note); else ActivityPubService.unmarkLiked(site.slug, note);
  }
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true, on });
  res.redirect('/news');
});

// Boost / unboost a feed post — a toggle. markBoosted also surfaces it in the Cirkel.
router.post('/news/boost', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  const note = (req.body.note || '').toString();
  let on = false;
  if (site && note) {
    on = !ActivityPubService.getTimelineReaction(site.slug, note).boosted;
    try { await ActivityPubService.sendInteraction(site, on ? 'boost' : 'unboost', note, (req.body.author || '').toString()); } catch (e) { /* ignore */ }
    if (on) ActivityPubService.markBoosted(site.slug, note); else ActivityPubService.unmarkBoosted(site.slug, note);
  }
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true, on });
  res.redirect('/news');
});

// Notifications inbox (new followers + replies/likes/boosts on your posts).
router.get('/notifications', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const items = site ? ActivityPubService.getNotifications(site.slug, 80) : [];
  // viewing = seen → clears the bell badge. A viewer (kijker) may look but must not
  // mutate state (the global write-guard only catches non-GET, not this GET-side effect).
  if (site && !isViewer(req.session.user)) ActivityPubService.markNotificationsSeen(site.slug);
  renderPage(req, res, 'pages/fedi-notifications', { pageTitle: 'Meldingen', bodyClass: 'on-special', items });
});

// Blocking / defederation (owner-only).
router.get('/blocking', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  const blocks = site ? ActivityPubService.listBlocks(site.slug) : [];
  renderPage(req, res, 'pages/blocks', { pageTitle: 'Blokkeren', bodyClass: 'on-special', blocks, success: req.query.success || null, error: req.query.error || null });
});

router.post('/blocking/add', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  let q = 'success=' + encodeURIComponent('Geblokkeerd');
  if (site) {
    try {
      const r = await ActivityPubService.blockTarget(site, (req.body.target || '').toString());
      if (r && r.error) q = 'error=' + encodeURIComponent(r.error === 'not_found' ? 'Account niet gevonden' : 'Voer een @handle of domein in');
      else q = 'success=' + encodeURIComponent(((r && r.label) || '') + ' geblokkeerd');
    } catch (e) { q = 'error=' + encodeURIComponent('Blokkeren mislukt'); }
  }
  const ref = req.get('Referer') || '';
  res.redirect((ref.includes('/news') ? '/news?' : '/blocking?') + q);
});

router.post('/blocking/remove', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  if (site) { try { ActivityPubService.unblock(site, (req.body.target || '').toString()); } catch (e) { /* ignore */ } }
  res.redirect('/blocking?success=' + encodeURIComponent('Deblokkeerd'));
});

// ==================== VIEW POST (last route â€” catches /:slug) ====================
router.get('/:slug', (req, res, next) => {
  if (RESERVED_SLUGS.has(req.params.slug)) return next();

  const site = res.locals.site;
  if (!site) return next(); // -> nette 404 catch-all

  const post = db.prepare(`
    SELECT p.*, u.username as author_username, u.avatar_url as author_avatar
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.site_id = ? AND p.slug = ?
  `).get(site.id, req.params.slug);

  if (!post) return next(); // unknown slug -> clean 404 catch-all

  // Permission to view: published OR (logged in + can edit)
  if (post.status !== 'published') {
    const canEdit = req.session?.user && PermissionsService.canEditPost(req.session.user, post, site);
    if (!canEdit) return res.status(403).send('Not published');
  }

  // Fan-only preview (premium #3): full content only for logged-in fans.
  // Anonymous visitors get a clean login gate instead of the content (the title/
  // teaser may still appear elsewhere as a teaser).
  if (post.fan_only && !(req.session && req.session.user)) {
    // Same Newer/Older navigation as on a normal post, so the visitor doesn't get
    // stuck on the fan gate but can keep browsing.
    const { newerPost, olderPost } = postNeighbors(site, post, res.locals.tenancy === 'hub');
    return renderPage(req, res, 'pages/fan-gate', {
      pageTitle: post.title || 'Alleen voor fans',
      bodyClass: 'on-special',
      fgTitle: post.title || '',
      fgNext: (res.locals.siteUrlBase || '') + '/' + post.slug,
      newerPost,
      olderPost,
    });
  }

  // Statistics: count the view (skips admins + unpublished own-preview).
  if (post.status === 'published') recordPostView(post, req);

  // Render content. Content is now user-authored HTML (already sanitized on
  // save). The pipeline still adds autoembed iframes and shortcode embeds:
  //   stored HTML → autoembed → [[track]]/[[album]]/[[playlist]] → response
  let html = post.content || '';
  if (audioEnabled()) {
  if (site.enable_audio_player !== 0) {
    html = AudioEmbedService.autoembed(html);
    html = AudioEmbedService.embedMediaShortcodes(html);
    html = AudioEmbedService.embedExternalLinkShortcodes(html);

    // Fetch any tracks referenced by [[track:id]] in this post.
    // Cheap to do unconditionally — only matches if the post actually has shortcodes.
    const trackIds = [...html.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)].map(m => m[1]);
    if (trackIds.length) {
      const placeholders = trackIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT t.id, t.title, t.artist, t.cover_url, t.credit, t.license,
               t.link_spotify, t.link_youtube, t.link_soundcloud, m.filename
        FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
        WHERE t.site_id = ? AND t.id IN (${placeholders})
      `).all(site.id, ...trackIds);
      const byId = new Map(rows.map(r => [r.id, r]));
      html = AudioEmbedService.embedTrackShortcodes(html, (id) => {
        const r = byId.get(id);
        if (!r) return null;
        return {
          id: r.id,
          title: r.title,
          artist: r.artist,
          cover: r.cover_url,
          credit: r.credit || '',
          license: r.license || '',
          link_spotify: r.link_spotify || '',
          link_youtube: r.link_youtube || '',
          link_soundcloud: r.link_soundcloud || '',
          url: r.filename ? audioUrl(r.filename) : '',  // '' = link-only track
        };
      });
    }

    // Album shortcodes: [[album:Some Album Name]]
    const albumNames = [...html.matchAll(/\[\[album:([^\]]+)\]\]/g)].map(m => m[1].trim());
    if (albumNames.length) {
      const placeholders = albumNames.map(() => '?').join(',');
      const albumRows = db.prepare(`
        SELECT t.id, t.title, t.artist, t.album, t.cover_url, t.position,
               t.link_spotify, t.link_youtube, t.link_soundcloud, m.filename
        FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
        WHERE t.site_id = ? AND t.album IN (${placeholders})
        ORDER BY t.position ASC, t.created_at ASC
      `).all(site.id, ...albumNames);
      const byAlbum = new Map();
      for (const r of albumRows) {
        // Link-only tracks (no file) remain in the album overview (url '').
        if (!byAlbum.has(r.album)) byAlbum.set(r.album, []);
        byAlbum.get(r.album).push({
          id: r.id,
          url: r.filename ? audioUrl(r.filename) : '',
          title: r.title || 'Untitled',
          artist: r.artist || '',
          cover: r.cover_url || '',
          link_spotify: r.link_spotify || '',
          link_youtube: r.link_youtube || '',
          link_soundcloud: r.link_soundcloud || '',
        });
      }
      html = AudioEmbedService.embedAlbumShortcodes(html, (name) => {
        const tracks = byAlbum.get(name);
        if (!tracks || !tracks.length) return null;
        return {
          title: name,
          artist: tracks[0].artist || '',
          cover: tracks[0].cover || '',
          tracks,
        };
      });
    }

    // Playlist shortcodes: [[playlist:some-slug-id]] — first-class entity.
    // Editing the playlist propagates to every post that embeds it.
    const playlistIds = [...html.matchAll(/\[\[playlist:([a-z0-9][a-z0-9-]*)\]\]/gi)]
      .map(m => m[1].toLowerCase());
    if (playlistIds.length) {
      const isAdmin = req.session?.user?.role === 'god';
      html = AudioEmbedService.embedPlaylistShortcodes(html, (id) => {
        return PlaylistService.get(site.id, id, audioUrl);
      }, { isAdmin });
    }
  }
  } else {
    // LITE mode (KLONKT_AUDIO=off): no own audio (no ffmpeg/stream route).
    // External embeds (YouTube/SoundCloud/Spotify) remain; the own-audio
    // shortcodes ([[track]]/[[album]]/[[playlist]]) are cleanly stripped.
    html = AudioEmbedService.autoembed(html);
    html = AudioEmbedService.embedMediaShortcodes(html);
    html = AudioEmbedService.embedExternalLinkShortcodes(html);
    html = html.replace(/\[\[(track|album|playlist):[^\]]+\]\]/gi, '');
  }
  post.content_html = html;

  if (post.tags) {
    try { post.tags = JSON.parse(post.tags); } catch { post.tags = []; }
  } else {
    post.tags = [];
  }

  // Native comments removed: social interaction is fediverse-only (see the
  // "From the fediverse" section below).

  // Prev / next chronological (kept for back-compat — "post-nav" feature
  // below the article still uses these as a simple linear navigation).
  // Hub mode: Related posts + Newer/Older pull from ALL users (all sites),
  // newest first. Solo mode: within the current site (old behaviour).
  const isHub = res.locals.tenancy === 'hub';
  // Per-post URL base: in hub a link points to /user/<site-slug>/<post-slug>.
  const urlBaseFor = (p) => (isHub && p && p.site_slug) ? `/user/${p.site_slug}` : '';

  // Newer/Older across ALL posts (shared helper — also used by the fan gate).
  const { newerPost, olderPost } = postNeighbors(site, post, isHub);

  // ── Related posts: same-tag matching with recency fallback ─────
  // Fetch ~50 candidates, score by tag overlap, take top 3.
  // Excluding self via `id != ?`.
  const candidates = isHub
    ? db.prepare(`
        SELECT p.id, p.slug, p.title, p.cover_image_url, p.published_at, p.tags, p.nsfw, p.content_warning, s.slug AS site_slug
        FROM posts p JOIN sites s ON s.id = p.site_id
        WHERE p.status = 'published' AND p.id != ?
        ORDER BY p.published_at DESC LIMIT 50
      `).all(post.id)
    : db.prepare(`
        SELECT id, slug, title, cover_image_url, published_at, tags, nsfw, content_warning
        FROM posts
        WHERE site_id = ? AND status = 'published' AND id != ?
        ORDER BY published_at DESC LIMIT 50
      `).all(site.id, post.id);

  // Parse tags JSON safely; missing/malformed → empty array.
  const parseTags = (raw) => {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map(String) : [];
    } catch { return []; }
  };

  const myTags = new Set(parseTags(post.tags));
  let relatedPosts;
  if (myTags.size > 0) {
    // Score = number of overlapping tags. Posts with zero overlap are
    // included only if we don't have 3 with-overlap candidates.
    const scored = candidates.map(p => {
      const theirTags = parseTags(p.tags);
      const overlap = theirTags.reduce((n, t) => n + (myTags.has(t) ? 1 : 0), 0);
      return { ...p, _overlap: overlap };
    });
    const withOverlap = scored.filter(p => p._overlap > 0)
      .sort((a, b) => b._overlap - a._overlap || new Date(b.published_at) - new Date(a.published_at));
    if (withOverlap.length >= 3) {
      relatedPosts = withOverlap.slice(0, 3);
    } else {
      // Pad with most-recent non-overlap posts so the section is never empty
      const overlapIds = new Set(withOverlap.map(p => p.id));
      const filler = candidates.filter(p => !overlapIds.has(p.id));
      relatedPosts = [...withOverlap, ...filler].slice(0, 3);
    }
  } else {
    // No tags on current post → just show 3 most-recent
    relatedPosts = candidates.slice(0, 3);
  }
  // Strip the internal _overlap field before sending to view
  relatedPosts = relatedPosts.map(({ _overlap, tags, ...rest }) => ({ ...rest, _urlBase: urlBaseFor(rest) }));

  // Inbound fediverse activity (threaded) for this post.
  let fediverse = { thread: [], likeCount: 0, announceCount: 0, total: 0 };
  try {
    const _apBase = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    fediverse = ActivityPubService.getInteractions(post.id, _apBase, site);
  } catch { /* non-fatal */ }
  // Owner/admin of this site may reply back to a fediverse interaction.
  const canManageSite = !!(req.session?.user && PermissionsService.canAdminSite(req.session.user, site));
  // Avatar for our own (outbound) fediverse replies = the site's profile photo.
  const siteAvatar = (site && site.profile_photo) ? site.profile_photo : null;

  renderPage(req, res, 'pages/post', {
    post,
    newerPost,
    olderPost,
    relatedPosts,
    fediverse,
    canManageSite,
    siteAvatar,
    postHasPlayableAudio: ActivityPubService.hasPlayableAudio(post.content || '', site.id),
    musicLd: MusicMeta.build((process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, ''), site, post),
    pageTitle: post.title + ' - ' + site.title,
    socialDescr: post.excerpt || '',
    socialImage: post.cover_image_url || '',
    bodyClass: 'on-post',
  });
});

// ── Reply back to a fediverse interaction (site owner/admin only) ──
router.post('/posts/:slug/fedi-reply', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  const post = db.prepare('SELECT id, slug FROM posts WHERE site_id = ? AND slug = ?').get(site.id, req.params.slug);
  if (!post) return res.status(404).send('Not found');
  const parent = ActivityPubService.getInteractionById(req.body.interaction_id);
  const text = (req.body.text || '').toString();
  if (parent && parent.post_id === post.id && text.trim()) {
    try {
      await ActivityPubService.deliverReply(site, { postId: post.id, postSlug: post.slug, parent, text });
    } catch (e) { console.warn('[AP] reply send failed:', e.message); }
  }
  res.redirect(`${res.locals.siteUrlBase || ''}/${post.slug}#fediverse`);
});

// Owner likes/boosts a fediverse comment on their own post — directly as the
// site, no "your server" detour (mirrors /fedi-reply).
router.post('/posts/:slug/fedi-react', requireSiteManager, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  const post = db.prepare('SELECT id, slug FROM posts WHERE site_id = ? AND slug = ?').get(site.id, req.params.slug);
  if (!post) return res.status(404).send('Not found');
  const parent = ActivityPubService.getInteractionById(req.body.interaction_id);
  const kind = req.body.kind === 'boost' ? 'boost' : 'like';
  if (parent && parent.post_id === post.id && parent.object_uri) {
    if (kind === 'boost') {
      // Toggle: boost an unboosted comment, or retract it (Undo Announce) if already boosted.
      const on = !parent.acted_boost;
      ActivityPubService.sendInteraction(site, on ? 'boost' : 'unboost', parent.object_uri, parent.actor_uri)
        .catch((e) => console.warn('[AP] reaction failed:', e.message));
      ActivityPubService.setInteractionBoosted(parent.id, on);
    } else {
      // Toggle: like an unliked comment, or un-favourite (Undo Like) if already liked.
      const on = !parent.acted_like;
      ActivityPubService.sendInteraction(site, on ? 'like' : 'unlike', parent.object_uri, parent.actor_uri)
        .catch((e) => console.warn('[AP] reaction failed:', e.message));
      ActivityPubService.setInteractionLiked(parent.id, on);
    }
  }
  res.redirect(`${res.locals.siteUrlBase || ''}/${post.slug}#fediverse`);
});

export default router;
export { postNeighbors };
