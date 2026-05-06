/**
 * GET /search?q=...
 *
 * Queries the posts_fts virtual table (FTS5) for the current site.
 * Search is restricted to published posts of the resolved site.
 *
 * FTS5 quirks handled:
 *   - Empty / whitespace-only query: render the form with no results.
 *   - User input is wrapped in double quotes so FTS5 treats it as a phrase
 *     (avoids syntax errors from special chars like "OR", parentheses, etc.).
 *   - Snippet() builds the highlighted excerpt; we keep markup minimal so
 *     the EJS view can wrap the matches in <mark>.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';

const router = express.Router();

// Wrap user input as a single FTS5 phrase. Strip embedded double-quotes so
// the wrapping stays balanced. FTS5 phrase queries are forgiving and avoid
// the operator-soup pitfalls of bare user input.
function asPhrase(q) {
  return '"' + q.replace(/"/g, '') + '"';
}

router.get('/', (req, res) => {
  const site = res.locals.site;
  const rawQ = (req.query.q || '').toString().trim();

  if (!site) return res.status(404).send('No site');

  // Empty query — render the page with the form and no results.
  if (!rawQ) {
    return renderPage(req, res, 'pages/search', {
      pageTitle: 'Search',
      bodyClass: 'on-special',
      query: '',
      results: [],
      total: 0,
    });
  }

  let results = [];
  let total = 0;
  let queryError = null;

  try {
    // FTS5 join → posts table, filter by site + published
    results = db.prepare(`
      SELECT
        p.slug,
        p.title,
        p.excerpt,
        p.published_at,
        u.username AS author_username,
        snippet(posts_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
        bm25(posts_fts) AS score
      FROM posts_fts
      JOIN posts p ON p.id = posts_fts.post_id
      JOIN users u ON u.id = p.author_id
      WHERE posts_fts MATCH ?
        AND p.site_id = ?
        AND p.status = 'published'
      ORDER BY score ASC
      LIMIT 50
    `).all(asPhrase(rawQ), site.id);

    total = results.length;
  } catch (err) {
    queryError = err.message;
  }

  renderPage(req, res, 'pages/search', {
    pageTitle: `Search: ${rawQ}`,
    bodyClass: 'on-special',
    query: rawQ,
    results,
    total,
    queryError,
  });
});

export default router;
