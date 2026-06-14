/**
 * Admin routes — Phase B stub.
 * Read-only god-only overview of users / sites / posts.
 * Real admin dashboard (create/delete sites, manage users, etc.) comes later.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { getTenancy } from '../services/SettingsService.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  const tenancy = getTenancy();

  // De primaire/owner-site — in solo dé site, in hub de hoofdsite. Geeft de
  // "Uiterlijk"-tegel z'n edit-link.
  const primarySite = db.prepare(
    'SELECT slug, title FROM sites ORDER BY created_at ASC LIMIT 1'
  ).get() || null;

  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    sites: db.prepare('SELECT COUNT(*) AS c FROM sites').get().c,
    posts: db.prepare('SELECT COUNT(*) AS c FROM posts').get().c,
    published: db.prepare(
      "SELECT COUNT(*) AS c FROM posts WHERE status = 'published'"
    ).get().c,
  };

  // Sites/users-tabellen zijn alleen in hub relevant; in solo besparen we de query.
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

  renderPage(req, res, 'pages/admin', {
    pageTitle: 'Beheer',
    bodyClass: 'on-admin',
    tenancy,
    primarySite,
    stats,
    sites,
    users,
  });
});

export default router;
