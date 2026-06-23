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

export function flipScheduledPosts() {
  try {
    const due = db.prepare(`
      SELECT p.id, p.title, p.content, u.username
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.status = 'scheduled' AND p.publish_at IS NOT NULL AND datetime(p.publish_at) <= datetime('now')
    `).all();
    if (!due.length) return 0;
    const upd = db.prepare(
      "UPDATE posts SET status = 'published', published_at = COALESCE(published_at, publish_at, CURRENT_TIMESTAMP) WHERE id = ?"
    );
    const fts = db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)');
    for (const p of due) {
      upd.run(p.id);
      try { fts.run(HtmlSanitizerService.toPlainText(p.content || ''), p.title || '', p.username || '', p.id); } catch { /* FTS failure is non-fatal */ }
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
