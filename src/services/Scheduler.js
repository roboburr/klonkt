/**
 * Scheduler — release planning (premium #3).
 *
 * Scheduled posts have status 'scheduled' + publish_at (future). A lightweight
 * timer flips them to 'published' once publish_at is reached. This means public
 * queries (status='published') need NO changes — a scheduled post simply isn't
 * 'published' yet and therefore invisible until that moment.
 */

import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';
import ActivityPubService from './ActivityPubService.js';

export function flipScheduledPosts() {
  try {
    const due = db.prepare(`
      SELECT p.id, p.site_id, p.slug, p.title, p.content, p.cover_image_url, p.fan_only,
             p.published_at, p.publish_at, p.created_at, u.username
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.status = 'scheduled' AND p.publish_at IS NOT NULL AND datetime(p.publish_at) <= datetime('now')
    `).all();
    if (!due.length) return 0;
    const upd = db.prepare(
      "UPDATE posts SET status = 'published', published_at = COALESCE(published_at, publish_at, CURRENT_TIMESTAMP) WHERE id = ?"
    );
    const ftsDel = db.prepare('DELETE FROM posts_fts WHERE post_id = ?');
    const fts = db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)');
    const siteStmt = db.prepare('SELECT * FROM sites WHERE id = ?');
    for (const p of due) {
      upd.run(p.id);
      // Delete-before-insert so a re-scheduled (previously published) post doesn't
      // get a duplicate FTS row → duplicate search hits.
      try { ftsDel.run(p.id); fts.run(HtmlSanitizerService.toPlainText(p.content || ''), p.title || '', p.username || '', p.id); } catch { /* FTS failure is non-fatal */ }
      // ActivityPub: federate the now-published post to followers.
      if (!p.fan_only) {
        try {
          const site = siteStmt.get(p.site_id);
          if (site) {
            ActivityPubService.deliverCreate(site, {
              id: p.id, slug: p.slug, title: p.title || p.slug,
              content: p.content, cover_image_url: p.cover_image_url || null,
              published_at: p.published_at || p.publish_at, created_at: p.created_at,
            }).catch(() => { /* best-effort */ });
          }
        } catch { /* non-fatal */ }
      }
    }
    return due.length;
  } catch { return 0; }
}

let _timer = null;
export function startScheduler() {
  flipScheduledPosts();                 // run immediately on boot
  if (_timer) return;
  _timer = setInterval(flipScheduledPosts, 60 * 1000); // every minute
  if (_timer.unref) _timer.unref();
}
