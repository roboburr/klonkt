import express from 'express';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { renderPage } from '../middleware/render.js';
import { recordPageview, recordPostView } from '../services/StatsService.js';
import PermissionsService from '../services/PermissionsService.js';
import MarkdownService from '../services/MarkdownService.js';
import HtmlSanitizerService from '../services/HtmlSanitizerService.js';
import AudioEmbedService from '../services/AudioEmbedService.js';
import PlaylistService from '../services/PlaylistService.js';
import { audioUrl } from '../services/AudioStreamService.js';

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

const router = express.Router();

// ==================== UPLOAD IMAGE (cover or content) ====================
// Returns JSON {url} so the editor can stick it into the cover field or
// insert a markdown ![](url) into content.
router.post('/posts/upload-image', requireAuth, (req, res) => {
  imageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = '/media/post-images/' + req.file.filename;
    res.json({ url, size: req.file.size, mime: req.file.mimetype });
  });
});

const RESERVED_SLUGS = new Set([
  'auth', 'admin', 'login', 'register', 'logout',
  'archive', 'search', 'account', 'sites', 'comments',
  'posts', 'media', 'audio', 'prutter', 'forum',
  'tag', 'type', 'user', 'users', 'artiesten', 'leden', 'feed.xml', 'atom.xml', 'sitemap.xml',
  'manifest.webmanifest', 'sw.js', 'favicon.ico', 'favicon.svg', 'assets',
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
  const finalSlug = (slug || title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!finalSlug) return res.status(400).send('Title or slug required');
  if (RESERVED_SLUGS.has(finalSlug)) return res.status(400).send('That slug is reserved');

  // Uniqueness check
  const existing = db.prepare('SELECT id FROM posts WHERE site_id = ? AND slug = ?').get(site.id, finalSlug);
  if (existing) return res.status(400).send('A post with that slug already exists');

  const validTypes = new Set(['post', 'foto', 'video', 'audio']);
  const finalType = validTypes.has(type) ? type : 'post';
  const postId = uuid();
  const now = new Date().toISOString();
  let finalStatus = status || 'draft';
  let publishedAt = finalStatus === 'published' ? now : null;
  // Release-planning: gepubliceerd + een toekomstige publish_at -> 'scheduled'
  // (de Scheduler zet 'm live op het moment zelf). Verleden/leeg -> meteen live.
  let publishAt = null;
  const pa = Date.parse(req.body.publish_at || '');
  if (finalStatus === 'published' && Number.isFinite(pa) && pa > Date.now()) {
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
    if (RESERVED_SLUGS.has(cleaned)) return res.status(400).send('That slug is reserved');
    const conflict = db.prepare('SELECT id FROM posts WHERE site_id = ? AND slug = ? AND id != ?').get(site.id, cleaned, post.id);
    if (conflict) return res.status(400).send('Slug already taken');
    finalSlug = cleaned;
  }

  const now = new Date().toISOString();
  let finalStatus = status || post.status;
  let publishedAt = post.published_at;

  if (action === 'publish') {
    finalStatus = 'published';
    if (!publishedAt) publishedAt = now;
  }

  // Release-planning: gepubliceerd + toekomstige publish_at -> 'scheduled'.
  let publishAt = null;
  const pa = Date.parse(req.body.publish_at || '');
  if (finalStatus === 'published' && Number.isFinite(pa) && pa > Date.now()) {
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

// Newer/Older-buren over ALLE posts in feed-volgorde. Gedeeld door de volledige
// post-render én de fan-gate (premium fan_only), zodat de navigatie overal gelijk
// is. Solo: binnen de site (pinned eerst, dan datum). Hub: globaal op datum.
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

  if (!post) return next(); // onbekende slug -> nette 404 catch-all

  // Permission to view: published OR (logged in + can edit)
  if (post.status !== 'published') {
    const canEdit = req.session?.user && PermissionsService.canEditPost(req.session.user, post, site);
    if (!canEdit) return res.status(403).send('Not published');
  }

  // Fan-only preview (premium #3): volledige inhoud alleen voor ingelogde fans.
  // Anonieme bezoekers krijgen een nette login-gate i.p.v. de inhoud (de titel/
  // teaser mag elders wel als lokkertje verschijnen).
  if (post.fan_only && !(req.session && req.session.user)) {
    // Zelfde Newer/Older-navigatie als op een gewone post, zodat de bezoeker op
    // de fan-gate niet vastloopt maar verder kan bladeren.
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

  // Statistieken: tel de weergave (skipt beheerders + niet-gepubliceerd-eigen-preview).
  if (post.status === 'published') recordPostView(post, req);

  // Render content. Content is now user-authored HTML (already sanitized on
  // save). The pipeline still adds autoembed iframes and shortcode embeds:
  //   stored HTML → autoembed → [[track]]/[[album]]/[[playlist]] → response
  let html = post.content || '';
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
        SELECT t.id, t.title, t.artist, t.cover_url, m.filename
        FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
        WHERE t.site_id = ? AND t.id IN (${placeholders})
      `).all(site.id, ...trackIds);
      const byId = new Map(rows.map(r => [r.id, r]));
      html = AudioEmbedService.embedTrackShortcodes(html, (id) => {
        const r = byId.get(id);
        if (!r || !r.filename) return null;
        return {
          id: r.id,
          title: r.title,
          artist: r.artist,
          cover: r.cover_url,
          url: audioUrl(r.filename),
        };
      });
    }

    // Album shortcodes: [[album:Some Album Name]]
    const albumNames = [...html.matchAll(/\[\[album:([^\]]+)\]\]/g)].map(m => m[1].trim());
    if (albumNames.length) {
      const placeholders = albumNames.map(() => '?').join(',');
      const albumRows = db.prepare(`
        SELECT t.id, t.title, t.artist, t.album, t.cover_url, t.position, m.filename
        FROM audio_tracks t LEFT JOIN media m ON m.id = t.media_id
        WHERE t.site_id = ? AND t.album IN (${placeholders})
        ORDER BY t.position ASC, t.created_at ASC
      `).all(site.id, ...albumNames);
      const byAlbum = new Map();
      for (const r of albumRows) {
        if (!r.filename) continue;
        if (!byAlbum.has(r.album)) byAlbum.set(r.album, []);
        byAlbum.get(r.album).push({
          url: audioUrl(r.filename),
          title: r.title || 'Untitled',
          artist: r.artist || '',
          cover: r.cover_url || '',
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
           c.author_id, u.username AS author_username, u.avatar_url AS author_avatar
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
  // Hub-modus: Gerelateerde posts + Newer/Older trekken uit ALLE users (alle
  // sites), nieuwste->oudste. Solo-modus: binnen de huidige site (oud gedrag).
  const isHub = res.locals.tenancy === 'hub';
  // Per-post URL-basis: in hub wijst een link naar /user/<site-slug>/<post-slug>.
  const urlBaseFor = (p) => (isHub && p && p.site_slug) ? `/user/${p.site_slug}` : '';

  // Newer/Older over ALLE posts (gedeelde helper — ook door de fan-gate gebruikt).
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

  renderPage(req, res, 'pages/post', {
    post,
    newerPost,
    olderPost,
    relatedPosts,
    comments: topLevel,
    totalComments,
    pageTitle: post.title + ' - ' + site.title,
    socialDescr: post.excerpt || '',
    socialImage: post.cover_image_url || '',
    bodyClass: 'on-post',
  });
});

export default router;
