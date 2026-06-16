/**
 * Artiesten-directory — alleen in hub-modus.
 *
 * GET /leden?q=&page=  -> doorzoekbare, gepagineerde lijst van ALLE
 * Klonkt-site's. De hub-home toont maar een beperkte selectie; deze pagina
 * schaalt naar honderden/duizenden artiesten via zoeken + paginering.
 *
 * In solo-modus bestaat er maar één site -> next() (valt door naar postsRoutes,
 * die 'artiesten' als onbekende slug afhandelt).
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

  // De hoofd-/labelsite (oudste) is geen artiest -> uit de directory weren,
  // consistent met de hub-home die 'm apart toont.
  const mainRow = db.prepare('SELECT id FROM sites ORDER BY created_at ASC LIMIT 1').get();
  const mainId = mainRow ? mainRow.id : '';

  // Zoekterm tegen titel/slug/tagline (case-insensitive via LIKE; SQLite LIKE is
  // standaard ongevoelig voor ASCII-hoofdletters). De ESCAPE '\' maakt %, _ en \
  // in de zoekterm letterlijk (anders zouden ze als wildcards werken).
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
