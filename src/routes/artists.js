/**
 * Artists directory — hub mode only.
 *
 * GET /leden?q=&page=  -> searchable, paginated list of ALL
 * Klonkt sites. The hub home shows only a limited selection; this page
 * scales to hundreds/thousands of artists via search + pagination.
 *
 * In solo mode there is only one site -> next() (falls through to postsRoutes,
 * which handles 'artiesten' as an unknown slug).
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { getTenancy } from '../services/SettingsService.js';

const router = express.Router();

const PER_PAGE = 24;

router.get('/', (req, res, next) => {
  if (getTenancy() !== 'hub') return next();

  const q = (req.query.q || '').toString().trim().slice(0, 80);
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  // The main/label site (oldest) is not an artist -> exclude from the directory,
  // consistent with the hub home which displays it separately.
  const mainRow = db.prepare('SELECT id FROM sites ORDER BY created_at ASC LIMIT 1').get();
  const mainId = mainRow ? mainRow.id : '';

  // Search term against title/slug/tagline (case-insensitive via LIKE; SQLite LIKE is
  // case-insensitive for ASCII by default). ESCAPE '\' makes %, _, and \
  // in the search term literal (otherwise they would act as wildcards).
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const conds = ['s.id != @mainId'];
  if (q) conds.push("(s.title LIKE @like ESCAPE '\\' OR s.slug LIKE @like ESCAPE '\\' OR s.tagline LIKE @like ESCAPE '\\')");
  const where = 'WHERE ' + conds.join(' AND ');
  const params = q ? { mainId, like } : { mainId };

  const total = db.prepare(`SELECT COUNT(*) AS c FROM sites s ${where}`)
    .get(params).c;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (page > pages) page = pages;
  const offset = (page - 1) * PER_PAGE;

  const artists = db.prepare(`
    SELECT s.slug, s.title, s.tagline, s.profile_photo, s.accent,
           u.avatar_url AS owner_avatar,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id AND status = 'published') AS post_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    ${where}
    ORDER BY s.title COLLATE NOCASE ASC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: PER_PAGE, offset });

  renderPage(req, res, 'pages/artists-directory', {
    pageTitle: 'Leden',
    bodyClass: 'on-hub',
    q,
    artists,
    total,
    page,
    pages,
  });
});

export default router;
