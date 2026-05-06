/**
 * PrutterService — Real-time Direct Messaging
 * 
 * Features:
 * - Per-conversation (user A ↔ user B)
 * - Optional site-specific (conversations tied to a community)
 * - WebSocket real-time notifications
 * - Message history in SQLite
 * - Unread message tracking
 */

import { v4 as uuid } from 'uuid';

class PrutterService {
  constructor(db) {
    this.db = db;
    this.wsConnections = new Map(); // userId → Set<WebSocket>
  }

  /**
   * Get or create conversation
   */
  getOrCreateConversation(userA, userB, siteId = null) {
    if (!userA || !userB) throw new Error('Both users required');
    
    // Normalize order: always smaller ID first
    const [u1, u2] = userA < userB ? [userA, userB] : [userB, userA];

    const existing = this.db.prepare(`
      SELECT * FROM conversations
      WHERE (user_a_id = ? AND user_b_id = ? AND site_id IS ?)
      LIMIT 1
    `).get(u1, u2, siteId);

    if (existing) {
      return existing;
    }

    const convId = uuid();
    this.db.prepare(`
      INSERT INTO conversations (id, user_a_id, user_b_id, site_id)
      VALUES (?, ?, ?, ?)
    `).run(convId, u1, u2, siteId);

    return { id: convId, user_a_id: u1, user_b_id: u2, site_id: siteId };
  }

  /**
   * Send message
   */
  sendMessage(conversationId, authorId, content) {
    if (!conversationId || !authorId || !content) {
      throw new Error('Missing required fields');
    }

    const msgId = uuid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, author_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, conversationId, authorId, content, now);

    // Update last_message_at on conversation
    this.db.prepare(`
      UPDATE conversations SET last_message_at = ? WHERE id = ?
    `).run(now, conversationId);

    // Fetch full message for response
    const message = this.db.prepare(`
      SELECT m.*, u.username, u.avatar_url
      FROM messages m
      JOIN users u ON m.author_id = u.id
      WHERE m.id = ?
    `).get(msgId);

    // Notify recipient via WebSocket (if online)
    const conv = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    const recipientId = conv.user_a_id === authorId ? conv.user_b_id : conv.user_a_id;
    
    this.notifyUser(recipientId, {
      type: 'new_message',
      conversationId,
      message
    });

    return message;
  }

  /**
   * Get conversation messages
   */
  getMessages(conversationId, limit = 50, offset = 0) {
    return this.db.prepare(`
      SELECT m.*, u.username, u.avatar_url
      FROM messages m
      JOIN users u ON m.author_id = u.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(conversationId, limit, offset);
  }

  /**
   * Get user's conversations (list)
   */
  getUserConversations(userId) {
    return this.db.prepare(`
      SELECT c.*,
             CASE 
               WHEN c.user_a_id = ? THEN u2.id
               ELSE u1.id
             END as other_user_id,
             CASE 
               WHEN c.user_a_id = ? THEN u2.username
               ELSE u1.username
             END as other_username,
             CASE 
               WHEN c.user_a_id = ? THEN u2.avatar_url
               ELSE u1.avatar_url
             END as other_avatar,
             (SELECT COUNT(*) FROM messages m 
              WHERE m.conversation_id = c.id 
              AND m.author_id != ? 
              AND m.read_at IS NULL) as unread_count,
             (SELECT content FROM messages m 
              WHERE m.conversation_id = c.id 
              ORDER BY m.created_at DESC LIMIT 1) as last_message_preview
      FROM conversations c
      JOIN users u1 ON c.user_a_id = u1.id
      JOIN users u2 ON c.user_b_id = u2.id
      WHERE c.user_a_id = ? OR c.user_b_id = ?
      ORDER BY c.last_message_at DESC
    `).all(userId, userId, userId, userId, userId, userId);
  }

  /**
   * Mark conversation messages as read
   */
  markAsRead(conversationId, userId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE messages
      SET read_at = ?
      WHERE conversation_id = ? AND author_id != ? AND read_at IS NULL
    `).run(now, conversationId, userId);
  }

  /**
   * WebSocket connection management
   */
  addConnection(userId, ws) {
    if (!this.wsConnections.has(userId)) {
      this.wsConnections.set(userId, new Set());
    }
    this.wsConnections.get(userId).add(ws);
  }

  removeConnection(userId, ws) {
    const conns = this.wsConnections.get(userId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        this.wsConnections.delete(userId);
      }
    }
  }

  /**
   * Notify user via WebSocket (if online)
   */
  notifyUser(userId, message) {
    const conns = this.wsConnections.get(userId);
    if (!conns) return;

    const data = JSON.stringify(message);
    for (const ws of conns) {
      if (ws.readyState === 1) { // OPEN
        ws.send(data);
      }
    }
  }

  /**
   * Broadcast to all users in conversation (except sender)
   */
  broadcastToConversation(conversationId, senderUserId, message) {
    const conv = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conv) return;

    const otherUserId = conv.user_a_id === senderUserId ? conv.user_b_id : conv.user_a_id;
    this.notifyUser(otherUserId, message);
  }
}

export default PrutterService;
