/**
 * ap-cirkel.js — de Cirkel (stap 10 van shaer-drc).
 *
 * De feed van uitgelichte accounts (auto_boost) plus zelf gebooste posts,
 * en de twee lijstjes eromheen. Leest ap_timeline, ap_following en
 * ap_my_reactions; schrijft niets. De enige snede tot nu toe zonder ook maar
 * een werktuig uit de dienstlaag: alleen db.
 */
import db from '../config/database.js';

// ── Cirkel = posts from the accounts you auto-boost ("feature an artist") ──
let _abCount, _cirkelPosts, _cirkelMembers;
export function autoBoostCount(slug) {
  try { if (!_abCount) _abCount = db.prepare('SELECT COUNT(*) AS n FROM ap_following WHERE slug = ? AND auto_boost = 1'); return _abCount.get(slug).n; } catch { return 0; }
}
export function getCirkelPosts(slug, limit, offset) {
  try {
    // Cirkel = posts from featured (auto_boost) accounts + posts you boosted
    // (t.boosted), mixed by date. One row per note in ap_timeline → no duplicates.
    if (!_cirkelPosts) _cirkelPosts = db.prepare(`
      SELECT t.id, t.author_uri, t.author_name, t.author_handle, t.author_icon, t.author_url,
             t.content, t.url, t.published, t.media_json, t.nsfw, t.cw,
             (rb.target_uri IS NOT NULL) AS boosted
      FROM ap_timeline t
      LEFT JOIN ap_following f ON f.slug = t.slug AND f.actor_uri = t.author_uri
      -- Uit de tussentabel, niet uit t.boosted: die kolom is een afgeleide. De
      -- UNIQUE(site_slug, target_uri, kind) garandeert hoogstens één match, dus
      -- deze join kan geen rijen verdubbelen.
      LEFT JOIN ap_my_reactions rb ON rb.site_slug = t.slug AND rb.target_uri = t.id AND rb.kind = 'boost'
      WHERE t.slug = ? AND (f.auto_boost = 1 OR rb.target_uri IS NOT NULL)
      ORDER BY COALESCE(t.published, t.created_at) DESC, t.rowid DESC
      LIMIT ? OFFSET ?`);
    return _cirkelPosts.all(slug, limit || 60, offset || 0);
  } catch { return []; }
}
export function getCirkelMembers(slug) {
  try { if (!_cirkelMembers) _cirkelMembers = db.prepare('SELECT name, url, icon FROM ap_following WHERE slug = ? AND auto_boost = 1 ORDER BY name'); return _cirkelMembers.all(slug); } catch { return []; }
}
