/**
 * Admin routes — Phase B stub.
 * Read-only god-only overview of users / sites / posts.
 * Real admin dashboard (create/delete sites, manage users, etc.) comes later.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireAuth } from '../middleware/auth.js';
import { getTenancy, apEnabled } from '../services/SettingsService.js';
import { getPrimarySite } from '../middleware/site.js';

const router = express.Router();

// Recent posts from one site, DRAFTS ON TOP, with mode-aware edit/view URLs.
// Solves the problem that drafts (status != published) were not findable anywhere:
// the timeline shows only published posts.
function sitePosts(siteId, siteSlug, tenancy, limit = 60) {
  const base = tenancy === 'hub' ? `/user/${siteSlug}` : '';
  return db.prepare(`
    SELECT slug, title, status, published_at, created_at, updated_at
    FROM posts WHERE site_id = ?
    ORDER BY (status != 'published') DESC, COALESCE(updated_at, published_at, created_at) DESC
    LIMIT ?
  `).all(siteId, limit).map((p) => ({
    ...p,
    isDraft: p.status !== 'published',
    editUrl: `${base}/posts/${p.slug}/edit`,
    viewUrl: `${base}/${p.slug}`,
  }));
}

router.get('/', requireAuth, (req, res) => {
  const user = req.session.user;

  // A kijker may view the full (god) admin panel read-only — same as god,
  // but writing is globally blocked. A regular artist who owns a site gets
  // a "My Klonkt Hub" dashboard, scoped to their own site. No site -> no admin.
  if (user.role !== 'god' && user.role !== 'kijker') {
    const mySite = db.prepare(
      'SELECT * FROM sites WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(user.id);
    if (!mySite) return res.status(403).send('Geen beheer beschikbaar voor dit account.');

    const mine = {
      posts: db.prepare("SELECT COUNT(*) AS c FROM posts WHERE site_id = ?").get(mySite.id).c,
      published: db.prepare("SELECT COUNT(*) AS c FROM posts WHERE site_id = ? AND status = 'published'").get(mySite.id).c,
    };
    return renderPage(req, res, 'pages/my-site', {
      pageTitleKey: 'admin.t_hub',
      bodyClass: 'on-admin',
      mySite,
      mine,
      posts: sitePosts(mySite.id, mySite.slug, 'hub'), // my-site is hub-only
    });
  }

  const tenancy = getTenancy();

  // The primary/main site — in solo THE site, in hub the main site. Provides the
  // "Appearance" tile with its edit link + the posts/drafts list.
  const primarySite = getPrimarySite();

  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    sites: db.prepare('SELECT COUNT(*) AS c FROM sites').get().c,
    posts: db.prepare('SELECT COUNT(*) AS c FROM posts').get().c,
    published: db.prepare(
      "SELECT COUNT(*) AS c FROM posts WHERE status = 'published'"
    ).get().c,
  };

  // Sites/users tables are only relevant in hub mode; in solo we skip the query.
  const sites = tenancy === 'hub' ? db.prepare(`
    SELECT s.slug, s.title, s.created_at, u.username AS owner_username
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    ORDER BY s.created_at DESC
    LIMIT 50
  `).all() : [];

  const users = tenancy === 'hub' ? db.prepare(`
    SELECT username, email, role, created_at
    FROM users
    ORDER BY created_at DESC
    LIMIT 50
  `).all() : [];

  // Posts/drafts of the primary site (in solo = the site; in hub = the admin's
  // main site). Drafts are listed first so they are easy to find.
  const posts = primarySite ? sitePosts(primarySite.id, primarySite.slug, tenancy) : [];

  renderPage(req, res, 'pages/admin', {
    pageTitleKey: 'admin.t_admin',
    bodyClass: 'on-admin',
    tenancy,
    circlesOn: apEnabled(),   // solo vs cirkels tagline (federatie aan/uit)
    primarySite,
    stats,
    sites,
    posts,
    users,
  });
});

// Handleiding — searchable explanation of all admin features. Visible to anyone
// who may view the admin panel (logged in); purely static help text, nothing sensitive.
router.get('/handleiding', requireAuth, (req, res) => {
  renderPage(req, res, 'pages/admin-help', {
    pageTitleKey: 'admin.t_manual',
    bodyClass: 'on-admin',
    tenancy: getTenancy(),
  });
});

export default router;
