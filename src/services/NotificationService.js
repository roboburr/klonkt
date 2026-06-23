/**
 * Notifications — reply to your comment, comment on your post, like on your post.
 * For every logged-in user (Google visitors/fans and admins). Snapshots of
 * actor name + post title so the list can be rendered without joins.
 */
import { randomUUID } from 'crypto';
import db from '../config/database.js';

// Creates a notification. Does nothing if there is no recipient or if you
// would notify yourself (your own comment/like on your own post/comment).
export function notify({ userId, actorId, actorName, type, postSlug, postTitle, url }) {
  if (!userId || userId === actorId) return;
  try {
    db.prepare(`
      INSERT INTO user_notifications (id, user_id, type, actor_id, actor_name, post_slug, post_title, url, read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(randomUUID(), userId, type, actorId || null, actorName || null, postSlug || null, postTitle || null, url || null);
  } catch { /* notifications are non-fatal */ }
}

export function unreadCount(userId) {
  if (!userId) return 0;
  try { return db.prepare('SELECT COUNT(*) AS c FROM user_notifications WHERE user_id = ? AND read = 0').get(userId).c; }
  catch { return 0; }
}

export function list(userId, limit = 50) {
  if (!userId) return [];
  try { return db.prepare('SELECT * FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit); }
  catch { return []; }
}

export function markAllRead(userId) {
  if (!userId) return;
  try { db.prepare('UPDATE user_notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId); } catch { /* no-op */ }
}

export default { notify, unreadCount, list, markAllRead };
