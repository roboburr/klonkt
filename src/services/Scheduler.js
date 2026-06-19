/**
 * Scheduler — release-planning (premium #3).
 *
 * Geplande posts hebben status 'scheduled' + publish_at (toekomst). Een lichte
 * timer zet ze op 'published' zodra publish_at bereikt is. Zo hoeven de publieke
 * queries (status='published') NIET aangepast te worden — een geplande post is
 * gewoon nog niet 'published' en dus nergens publiek zichtbaar tot het moment.
 */

import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';

export function flipScheduledPosts() {
  try {
    const due = db.prepare(`
      SELECT p.id, p.title, p.content, u.username
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.status = 'scheduled' AND p.publish_at IS NOT NULL AND p.publish_at <= CURRENT_TIMESTAMP
    `).all();
    if (!due.length) return 0;
    const upd = db.prepare(
      "UPDATE posts SET status = 'published', published_at = COALESCE(published_at, publish_at, CURRENT_TIMESTAMP) WHERE id = ?"
    );
    const fts = db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?, ?, ?, ?)');
    for (const p of due) {
      upd.run(p.id);
      try { fts.run(HtmlSanitizerService.toPlainText(p.content || ''), p.title || '', p.username || '', p.id); } catch { /* FTS niet-fataal */ }
    }
    return due.length;
  } catch { return 0; }
}

let _timer = null;
export function startScheduler() {
  flipScheduledPosts();                 // direct bij boot
  if (_timer) return;
  _timer = setInterval(flipScheduledPosts, 60 * 1000); // elke minuut
  if (_timer.unref) _timer.unref();
}
