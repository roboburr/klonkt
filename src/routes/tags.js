/**
 * GET /tag/:tag
 *
 * De openbare posts van deze site met deze tag.
 *
 * Twee dingen die hier mis waren (shaer-m5s6):
 *
 * - ZICHTBAARHEID. De pagina toonde elke gepubliceerde post met de tag, ook een
 *   post voor vrienden of alleen voor de mensen erin -- met titel en excerpt,
 *   voor iedereen. Hier staat alleen wat iedereen mag zien.
 * - SCHRIJFWIJZE. Een link naar een tag is kleingeschreven (/tag/livemusic),
 *   de editor bewaart een tag zoals hij getypt is ('Live Music'), en een
 *   hashtag uit Shaer zoals hij geschreven is (#LiveMusic). Die vonden elkaar
 *   niet. Nu op de sleutel van tagKey: zonder hoofdletters, spaties en
 *   leestekens.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { normalizeTags, tagKey } from '../services/ap-core.js';

const router = express.Router();

/** Hoeveel posts de pagina ten hoogste toont. */
const MAX = 100;

/**
 * De openbare posts van deze site met deze tag, nieuwste eerst. Los van de
 * route, zodat het te toetsen is zonder een pagina te renderen.
 */
export function findTaggedPosts(siteId, tag) {
  const sleutel = tagKey(tag);
  if (!sleutel) return [];
  // De tags staan als JSON-lijst (of een oude kommalijst) in een kolom; de
  // vergelijking op sleutel kan SQLite niet zelf, dus voorselecteren op 'heeft
  // tags en is openbaar', en dan hier passen.
  const rijen = db.prepare(`
    SELECT p.id, p.slug, p.title, p.excerpt, p.cover_image_url, p.cover_video_url,
           p.published_at, p.tags, u.username AS author_username
    FROM posts p
    JOIN users u ON u.id = p.author_id
    WHERE p.site_id = ?
      AND p.status = 'published'
      AND (p.fan_only IS NULL OR p.fan_only = 0)
      AND COALESCE(p.ap_visibility, '') NOT IN ('friends', 'direct')
      AND p.tags IS NOT NULL AND p.tags NOT IN ('', '[]')
    ORDER BY p.published_at DESC
  `).all(siteId);
  const uit = [];
  for (const p of rijen) {
    if (normalizeTags(p.tags).some((t) => tagKey(t) === sleutel)) {
      const { tags, ...rest } = p;
      uit.push(rest);
      if (uit.length >= MAX) break;
    }
  }
  return uit;
}

router.get('/:tag', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const tag = (req.params.tag || '').trim().replace(/^#+/, '');
  if (!tag) return res.redirect(res.locals.siteUrlBase || '/');

  renderPage(req, res, 'pages/tag', {
    pageTitle: `#${tag} — ${site.title}`,
    bodyClass: 'on-special',
    tag,
    posts: findTaggedPosts(site.id, tag),
  });
});

export default router;
