/**
 * Meldingen — antwoord op je reactie, reactie op je post, like op je post.
 * Voor élke ingelogde gebruiker (Google-bezoekers/fans én admin). Snapshots van
 * actor-naam + post-titel zodat de lijst zonder joins te tonen is.
 */
import { randomUUID } from 'crypto';
import db from '../config/database.js';

// Maakt een melding aan. Doet niets als er geen ontvanger is of als je jezelf
// zou notificeren (eigen reactie/like op eigen post/reactie).
export function notify({ userId, actorId, actorName, type, postSlug, postTitle, url }) {
  if (!userId || userId === actorId) return;
  try {
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, actor_id, actor_name, post_slug, post_title, url, read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(randomUUID(), userId, type, actorId || null, actorName || null, postSlug || null, postTitle || null, url || null);
  } catch { /* meldingen zijn niet-fataal */ }
}

export function unreadCount(userId) {
  if (!userId) return 0;
  try { return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(userId).c; }
  catch { return 0; }
}

export function list(userId, limit = 50) {
  if (!userId) return [];
  try { return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit); }
  catch { return []; }
}

export function markAllRead(userId) {
  if (!userId) return;
  try { db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId); } catch { /* noop */ }
}

export default { notify, unreadCount, list, markAllRead };
