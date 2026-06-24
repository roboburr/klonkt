import express from 'express';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import ejs from 'ejs';
import db from '../config/database.js';
import { requireAuth, requireSiteManager } from '../middleware/auth.js';
import { renderPage } from '../middleware/render.js';
import { recordPageview, recordPostView } from '../services/StatsService.js';
import { notify } from '../services/NotificationService.js';
import PermissionsService from '../services/PermissionsService.js';
import MarkdownService from '../services/MarkdownService.js';
import HtmlSanitizerService from '../services/HtmlSanitizerService.js';
import AudioEmbedService from '../services/AudioEmbedService.js';
import PlaylistService from '../services/PlaylistService.js';
import { audioEnabled } from '../config/features.js';
import { audioUrl } from '../services/AudioStreamService.js';
import { toWebp } from '../services/ImageWebpService.js';
import ActivityPubService from '../services/ActivityPubService.js';

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
  imageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = '/media/post-images/' + toWebp(req.file);
    res.json({ url, size: req.file.size, mime: req.file.mimetype });
  });
});

const RESERVED_SLUGS = new Set([
  'auth', 'admin', 'login', 'register', 'logout',
  'archive', 'search', 'account', 'sites', 'comments',
  'posts', 'media', 'audio', 'forum',
  'tag', 'type', 'user', 'users', 'artiesten', 'leden', 'favorieten', 'feed.xml', 'atom.xml', 'sitemap.xml',
  'manifest.webmanifest', 'sw.js', 'favicon.ico', 'favicon.svg', 'assets',
  'authorize_interaction', 'fediverse',
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
router.post('/posts/create', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site || !PermissionsService.canCreatePost(req.session.user, site)) {
    return res.status(403).send('No permission');
  }

  const { title, slug, content, excerpt, status, pinned, cover_image_url, tags, noindex, type } = req.body;
  const fanOnly = req.body.fan_only ? 1 : 0;

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
      status, cover_image_url, pinned, tags, type, noindex, fan_only, publish_at,
      created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    postId, site.id, finalSlug, req.session.user.id,
    title || finalSlug, cleanContent, excerpt || '',
    finalStatus, cover_image_url || null, parsePinnedRank(pinned),
    JSON.stringify((tags || '').split(',').map(t => t.trim()).filter(Boolean)),
    finalType, noindex ? 1 : 0, fanOnly, publishAt,
    now, now, publishedAt
  );

  if (finalStatus === 'published') {
    try {
      db.prepare(
        'INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)'
      ).run(HtmlSanitizerService.toPlainText(cleanContent), title || '', req.session.user.username, postId);
    } catch (e) { /* FTS index issues are non-fatal */ }

    // ActivityPub: federate a freshly published public post to followers.
    if (!fanOnly) {
      ActivityPubService.deliverCreate(site, {
        id: postId, slug: finalSlug, title: title || finalSlug,
        content: cleanContent, cover_image_url: cover_image_url || null,
        published_at: publishedAt, created_at: now,
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
      cover_image_url = ?, pinned = ?, tags = ?,
      type = ?, noindex = ?, fan_only = ?, publish_at = ?,
      slug = ?, published_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    title, cleanContent, excerpt, finalStatus,
    cover_image_url || null, parsePinnedRank(pinned),
    JSON.stringify((tags || '').split(',').map(t => t.trim()).filter(Boolean)),
    finalType, noindex ? 1 : 0, fanOnly, publishAt,
    finalSlug, publishedAt, now, post.id
  );

  // Update FTS
  try {
    db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(post.id);
    if (finalStatus === 'published') {
      db.prepare(
        'INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)'
      ).run(HtmlSanitizerService.toPlainText(cleanContent), title || '', req.session.user.username, post.id);
    }
  } catch (e) { /* FTS issues non-fatal */ }

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

  // ActivityPub: tell followers the post is gone (Delete + Tombstone), but only
  // if it was actually federated (published + not fan-only). Fire before the row
  // is removed — we still have post.id (= the Note id).
  if (post.status === 'published' && !post.fan_only) {
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

// Path to the like button partial (for the htmx toggle re-render).
const LIKE_PARTIAL = path.join(__dirname, '..', 'views', 'partials', 'like-button.ejs');

// ==================== LIKE / FAVOURITE ====================
// A logged-in user (not a viewer — the global guard blocks non-GET for viewers)
// toggles a like on a published post. Returns the re-rendered button (htmx outerHTML swap).
router.post('/posts/:id/like', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const post = db.prepare('SELECT id, status, slug, title, author_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).send('Post niet gevonden');
  if (post.status !== 'published') return res.status(403).send('Niet beschikbaar');

  const exists = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(post.id, userId);
  if (exists) {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(post.id, userId);
  } else {
    db.prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)').run(post.id, userId);
    // Notification for the post author (notify skips self-likes).
    notify({
      userId: post.author_id, actorId: userId, actorName: req.session.user.username, type: 'like',
      postSlug: post.slug, postTitle: post.title, url: (res.locals.siteUrlBase || '') + '/' + post.slug,
    });
  }
  const likeCount = db.prepare('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?').get(post.id).c;

  const html = ejs.render(fs.readFileSync(LIKE_PARTIAL, 'utf8'), {
    post: { id: post.id }, likedByMe: !exists, likeCount, loggedIn: true, loginNext: '/',
  });
  res.send(html);
});

// Favourites = posts the logged-in user has liked. Solo: within the current
// site. Hub: across all sites (with correct /user/<slug> links).
router.get('/favorieten', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const isHub = res.locals.tenancy === 'hub';
  const site = res.locals.site;
  const rows = isHub
    ? db.prepare(`
        SELECT p.id, p.slug, p.title, p.excerpt, p.cover_image_url, p.published_at,
               p.tags, p.type, p.pinned, p.status, s.slug AS site_slug
        FROM post_likes pl JOIN posts p ON p.id = pl.post_id JOIN sites s ON s.id = p.site_id
        WHERE pl.user_id = ? AND p.status = 'published'
        ORDER BY pl.created_at DESC
      `).all(userId)
    : db.prepare(`
        SELECT p.id, p.slug, p.title, p.excerpt, p.cover_image_url, p.published_at,
               p.tags, p.type, p.pinned, p.status
        FROM post_likes pl JOIN posts p ON p.id = pl.post_id
        WHERE pl.user_id = ? AND p.site_id = ? AND p.status = 'published'
        ORDER BY pl.created_at DESC
      `).all(userId, site ? site.id : '');
  const posts = rows.map((p) => ({ ...p, _urlBase: (isHub && p.site_slug) ? `/user/${p.site_slug}` : '' }));
  renderPage(req, res, 'pages/favorites', { posts, pageTitle: 'Favorieten', bodyClass: 'on-favorites' });
});

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
  let target = null;
  if (!sent) { try { target = await ActivityPubService.resolveRemoteNote(uri); } catch { /* ignore */ } }
  renderPage(req, res, 'pages/authorize-interaction', {
    pageTitle: 'Reageer via de fediverse',
    bodyClass: 'on-special',
    uri,
    target,
    sent,
    siteTitle: site ? site.title : '',
  });
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

  // Comments: top-level + replies. Two-pass build: fetch all approved
  // comments for the post, then group replies under their parent.
  const commentRows = db.prepare(`
    SELECT c.id, c.parent_comment_id, c.content, c.status, c.created_at,
           c.author_id, u.username AS author_username,
           COALESCE(u.avatar_url, (SELECT profile_photo FROM sites WHERE owner_id = u.id AND profile_photo IS NOT NULL ORDER BY is_primary DESC, created_at ASC LIMIT 1)) AS author_avatar
    FROM comments c JOIN users u ON u.id = c.author_id
    WHERE c.post_id = ? AND c.status = 'approved'
    ORDER BY c.created_at ASC
  `).all(post.id);
  const topLevel = [];
  const repliesById = new Map();
  for (const c of commentRows) {
    if (c.parent_comment_id) {
      if (!repliesById.has(c.parent_comment_id)) repliesById.set(c.parent_comment_id, []);
      repliesById.get(c.parent_comment_id).push(c);
    } else {
      topLevel.push(c);
    }
  }
  for (const c of topLevel) c.replies = repliesById.get(c.id) || [];
  const totalComments = commentRows.length;

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
        SELECT p.id, p.slug, p.title, p.cover_image_url, p.published_at, p.tags, s.slug AS site_slug
        FROM posts p JOIN sites s ON s.id = p.site_id
        WHERE p.status = 'published' AND p.id != ?
        ORDER BY p.published_at DESC LIMIT 50
      `).all(post.id)
    : db.prepare(`
        SELECT id, slug, title, cover_image_url, published_at, tags
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

  // Likes / favourites: count + whether the logged-in user liked this post.
  const likeCount = db.prepare('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?').get(post.id).c;
  const likedByMe = !!(req.session?.user &&
    db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(post.id, req.session.user.id));

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
    comments: topLevel,
    totalComments,
    fediverse,
    canManageSite,
    siteAvatar,
    likeCount,
    likedByMe,
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

export default router;
export { postNeighbors };
