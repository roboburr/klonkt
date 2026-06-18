/**
 * Admin: Site management — Phase E.
 *
 * GET  /admin/sites             -> list all sites
 * GET  /admin/sites/new         -> create form
 * POST /admin/sites/create      -> insert + redirect to edit
 * GET  /admin/sites/:slug/edit  -> edit form
 * POST /admin/sites/:slug/save  -> update
 * POST /admin/sites/:slug/delete-> delete (refuses if site has posts)
 *
 * God-only (requireGod middleware). Slug is immutable after create — too
 * many things hang off it (URLs, manifest scope, federation). If you really
 * need to rename: delete + re-create.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod, requireAuth, requireSiteManagerBySlug } from '../middleware/auth.js';
import ThemeService from '../services/ThemeService.js';
import { listPlatforms, PLATFORMS } from '../services/PlatformIcons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Profile photos share the avatar directory with user avatars — same physical
// folder, same URL prefix. Filenames are uuid-prefixed so site photos and
// user avatars never collide.
const PHOTO_DIR = path.resolve(
  process.env.AVATAR_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'avatars')
);
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const ALLOWED_PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `site-${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_PHOTO_EXT.has(ext)) {
      return cb(new Error('Alleen JPG/PNG/WebP/GIF toegestaan'));
    }
    cb(null, true);
  },
});

/** Coerce req.body fields into the JSON profile_links array. */
function buildProfileLinks(body) {
  const platforms = body.profile_link_platform || [];
  const urls = body.profile_link_url || [];
  const arr = [];
  const platformsArr = Array.isArray(platforms) ? platforms : [platforms];
  const urlsArr      = Array.isArray(urls)      ? urls      : [urls];
  for (let i = 0; i < platformsArr.length; i++) {
    const p = (platformsArr[i] || '').toString().trim();
    const u = (urlsArr[i] || '').toString().trim();
    if (!p || !u) continue;
    if (!PLATFORMS[p]) continue;
    if (!/^https?:\/\//i.test(u) && p !== 'email') continue;
    if (p === 'email' && !/^mailto:|^[^\s@]+@[^\s@]+$/i.test(u)) continue;
    arr.push({ platform: p, url: u });
  }
  return arr.length ? JSON.stringify(arr) : null;
}

const router = express.Router();

// ==================== UPLOAD PROFILE PHOTO (JSON) ====================
// POST /admin/sites/upload-photo  → { ok: true, url: '/media/avatars/<filename>' }
// Used by the admin-site-edit form's photo picker. The form itself still
// holds the URL string in `profile_photo` — this endpoint just stores the
// file and hands back a URL that the form can paste into the input field.
router.post('/upload-photo', requireAuth, (req, res) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Geen bestand ontvangen' });
    res.json({
      ok: true,
      url: `/media/avatars/${req.file.filename}`,
      size: req.file.size,
      mime: req.file.mimetype,
    });
  });
});

const RESERVED_SITE_SLUGS = new Set([
  'auth', 'admin', 'login', 'register', 'logout', 'archive', 'search',
  'account', 'sites', 'comments', 'posts', 'media', 'audio', 'prutter',
  'forum', 'tag', 'user', 'users', 'artiesten', 'leden', 'feed.xml', 'atom.xml', 'sitemap.xml',
  'manifest.webmanifest', 'sw.js', 'favicon.ico', 'favicon.svg', 'assets',
]);

function siteEditableFields() {
  return {
    title: '',
    description: '',
    tagline: '',
    language: 'nl',
    palette: 'sage',
    accent: '#c2410c',
    profile_photo: '',
    profile_enabled: 1,
    profile_name: '',
    profile_bio: '',
    is_public: 1,
    robots_index: 1,
    require_login_to_comment: 0,
    enable_audio_player: 1,
    enable_prutter: 1,
    comments_moderation_mode: 'moderate',
    feed_view_default: 'grid',
    feed_view_switch: 1,
    show_search: 1,
    show_archive_link: 1,
    title_template: '{title} — {site}',
    twitter: '',
    canonical: '',
    google_verification: '',
    bing_verification: '',
    pinterest_verification: '',
    yandex_verification: '',
    custom_css: '',
    custom_head_html: '',
    custom_foot_html: '',
  };
}

/** Geldige user-id voor owner-toewijzing, of null bij leeg/onbekend. */
function validOwnerId(raw) {
  const id = (raw || '').toString().trim();
  if (!id) return null;
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) ? id : null;
}

/** Geef een user admin-rechten op een site (idempotent upsert). */
function grantSiteAdmin(siteId, userId) {
  db.prepare(`
    INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')
    ON CONFLICT(site_id, user_id) DO UPDATE SET role = 'admin'
  `).run(siteId, userId);
}

/** Kandidaat-owners voor het owner-keuzeveld (god-only). */
function listOwnerCandidates() {
  return db.prepare('SELECT id, username, role FROM users ORDER BY username').all();
}

// ==================== LIST ====================
router.get('/', requireGod, (req, res) => {
  const sites = db.prepare(`
    SELECT s.id, s.slug, s.title, s.description, s.created_at,
           s.is_public, s.robots_index, s.is_primary,
           u.username AS owner_username,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id) AS post_count
    FROM sites s LEFT JOIN users u ON u.id = s.owner_id
    ORDER BY s.is_primary DESC, s.created_at DESC
  `).all();

  renderPage(req, res, 'pages/admin-sites', {
    pageTitle: 'Sites',
    bodyClass: 'on-admin',
    sites,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// ==================== NEW (form) ====================
router.get('/new', requireGod, (req, res) => {
  renderPage(req, res, 'pages/admin-site-edit', {
    pageTitle: 'New site',
    bodyClass: 'on-admin',
    isNew: true,
    site: { slug: '', owner_id: req.session.user.id, ...siteEditableFields() },
    users: listOwnerCandidates(),
    palettes: ThemeService.listPalettes(),
    accents: ThemeService.listAccents(),
    platforms: listPlatforms(),
    parsedLinks: [],
    error: null,
  });
});

// ==================== CREATE ====================
router.post('/create', requireGod, (req, res) => {
  const slug = (req.body.slug || '').toString().toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,40}$/.test(slug)) {
    return res.redirect('/admin/sites/new?error=' + encodeURIComponent('Slug: 2-40 chars, letters/numbers/underscore/dash'));
  }
  if (RESERVED_SITE_SLUGS.has(slug)) {
    return res.redirect('/admin/sites/new?error=' + encodeURIComponent('That slug is reserved'));
  }
  const existing = db.prepare('SELECT id FROM sites WHERE slug = ?').get(slug);
  if (existing) {
    return res.redirect('/admin/sites/new?error=' + encodeURIComponent('Slug already taken'));
  }

  const f = { ...siteEditableFields(), ...req.body };

  // Owner: god mag de site aan een ANDERE gebruiker toewijzen — dit is de kern
  // van hub-modus (elke gebruiker z'n eigen, zelf te beheren Klonkt). Leeg of
  // ongeldig → de aanmakende god zelf.
  const ownerId = validOwnerId(req.body.owner_id) || req.session.user.id;

  const siteId = uuid();
  db.prepare(`
    INSERT INTO sites (
      id, slug, title, description, tagline, owner_id,
      language, palette, accent, profile_photo,
      is_public, robots_index, require_login_to_comment, enable_audio_player,
      feed_view_default, comments_moderation_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    siteId, slug,
    (f.title || slug).slice(0, 200),
    (f.description || '').slice(0, 500),
    (f.tagline || '').slice(0, 200),
    ownerId,
    f.language || 'nl',
    f.palette || 'sage',
    ThemeService.validateAccent(f.accent) || '#c2410c',
    f.profile_photo || null,
    f.is_public ? 1 : 0,
    f.robots_index ? 1 : 0,
    f.require_login_to_comment ? 1 : 0,
    (f.enable_audio_player !== undefined ? (f.enable_audio_player ? 1 : 0) : 1),
    f.feed_view_default === 'timeline' ? 'timeline' : 'grid',
    f.comments_moderation_mode === 'trust' ? 'trust' : 'moderate',
  );

  // De OWNER (niet per se de aanmaker) krijgt een site_members-admin-rij → zo komt
  // 'ie door canAdminSite + de requireSiteManager-gates en beheert 'ie z'n site.
  grantSiteAdmin(siteId, ownerId);

  res.redirect(`/admin/sites/${slug}/edit?success=` + encodeURIComponent('Site aangemaakt'));
});

// ==================== EDIT (form) ====================
router.get('/:slug/edit', requireSiteManagerBySlug, (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(req.params.slug);
  if (!site) return res.redirect('/admin/sites?error=Not+found');

  let parsedLinks = [];
  if (site.profile_links) {
    try { parsedLinks = JSON.parse(site.profile_links) || []; } catch {}
  }

  renderPage(req, res, 'pages/admin-site-edit', {
    pageTitle: `Edit: ${site.title}`,
    bodyClass: 'on-admin',
    isNew: false,
    site,
    users: listOwnerCandidates(),
    palettes: ThemeService.listPalettes(),
    accents: ThemeService.listAccents(),
    platforms: listPlatforms(),
    parsedLinks,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// ==================== SAVE ====================
router.post('/:slug/save', requireSiteManagerBySlug, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE slug = ?').get(req.params.slug);
  if (!site) return res.redirect('/admin/sites?error=Not+found');

  const f = req.body;
  const moderationMode = f.comments_moderation_mode === 'moderate' ? 'moderate' : 'trust';
  const feedViewDef = f.feed_view_default === 'grid' ? 'grid' : 'timeline';
  const profileLinksJson = buildProfileLinks(f);

  // theme_override: only accept the three legal values. Empty string means
  // "Auto" — defer to user's prefers-color-scheme on first paint.
  const themeOverride = ['light', 'dark'].includes(f.theme_override) ? f.theme_override : '';

  // accent: only accept colors from the curated ACCENTS list. Falls back to
  // the orange default if the submitted value isn't recognised.
  const accent = ThemeService.validateAccent(f.accent) || '#c2410c';

  db.prepare(`
    UPDATE sites SET
      title = ?, description = ?, tagline = ?, language = ?,
      palette = ?, accent = ?, theme_override = ?, profile_photo = ?,
      profile_enabled = ?,
      profile_links = ?,
      is_public = ?, robots_index = ?, require_login_to_comment = ?,
      enable_audio_player = ?, enable_prutter = ?,
      comments_moderation_mode = ?,
      feed_view_default = ?, feed_view_switch = ?,
      show_search = ?, show_archive_link = ?,
      title_template = ?, twitter = ?, canonical = ?,
      google_verification = ?, bing_verification = ?,
      pinterest_verification = ?, yandex_verification = ?,
      custom_css = ?, custom_head_html = ?, custom_foot_html = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    (f.title || '').slice(0, 200),
    (f.description || '').slice(0, 500),
    (f.tagline || '').slice(0, 200),
    f.language || 'nl',
    f.palette || 'sage',
    accent,
    themeOverride,
    f.profile_photo || null,
    f.profile_enabled ? 1 : 0,
    profileLinksJson,
    f.is_public ? 1 : 0,
    f.robots_index ? 1 : 0,
    f.require_login_to_comment ? 1 : 0,
    f.enable_audio_player ? 1 : 0,
    f.enable_prutter ? 1 : 0,
    moderationMode,
    feedViewDef,
    f.feed_view_switch ? 1 : 0,
    f.show_search ? 1 : 0,
    f.show_archive_link ? 1 : 0,
    (f.title_template || '{title} — {site}').slice(0, 200),
    (f.twitter || '').slice(0, 64) || null,
    (f.canonical || '').slice(0, 200) || null,
    (f.google_verification    || '').slice(0, 200) || null,
    (f.bing_verification      || '').slice(0, 200) || null,
    (f.pinterest_verification || '').slice(0, 200) || null,
    (f.yandex_verification    || '').slice(0, 200) || null,
    f.custom_css      || null,
    f.custom_head_html || null,
    f.custom_foot_html || null,
    site.id,
  );

  // Owner (her)toewijzen — ALLEEN god. Een site-owner die z'n eigen site bewerkt
  // kan de eigenaar niet wijzigen (het veld wordt voor niet-god ook niet getoond).
  if (req.session.user.role === 'god') {
    const newOwner = validOwnerId(req.body.owner_id);
    if (newOwner) {
      db.prepare('UPDATE sites SET owner_id = ? WHERE id = ?').run(newOwner, site.id);
      grantSiteAdmin(site.id, newOwner);
    }
  }

  res.redirect(`/admin/sites/${req.params.slug}/edit?success=` + encodeURIComponent('Opgeslagen'));
});

// ==================== MAAK PRIMAIR ====================
// God kiest welke site de primaire/hoofd-site is (de label-/bedrijfssite in hub;
// in solo dé site). Precies één site is primair → eerst alles uit, dan deze aan.
router.post('/:slug/make-primary', requireGod, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE slug = ?').get(req.params.slug);
  if (!site) return res.redirect('/admin/sites?error=Niet+gevonden');
  db.transaction(() => {
    db.prepare('UPDATE sites SET is_primary = 0').run();
    db.prepare('UPDATE sites SET is_primary = 1 WHERE id = ?').run(site.id);
  })();
  res.redirect('/admin/sites?success=' + encodeURIComponent('Primaire site bijgewerkt'));
});

// ==================== DELETE ====================
router.post('/:slug/delete', requireGod, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE slug = ?').get(req.params.slug);
  if (!site) return res.redirect('/admin/sites?error=Not+found');

  const postCount = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE site_id = ?').get(site.id).c;
  if (postCount > 0) {
    return res.redirect('/admin/sites?error=' + encodeURIComponent(`Cannot delete: site has ${postCount} post(s). Delete posts first.`));
  }

  // Clean up site_members and audio_tracks (no posts to worry about).
  db.prepare('DELETE FROM site_members WHERE site_id = ?').run(site.id);
  db.prepare('DELETE FROM audio_tracks WHERE site_id = ?').run(site.id);
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);

  res.redirect('/admin/sites?success=' + encodeURIComponent('Site deleted'));
});

export default router;
