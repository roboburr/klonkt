/**
 * Prutter — Direct Messaging routes.
 *
 * GET  /prutter                   -> inbox (list of your conversations on THIS site)
 * GET  /prutter/new?to=<username> -> start (or resume) a conversation, redirects to /prutter/:id
 * GET  /prutter/:id               -> conversation view (messages + send form)
 * POST /prutter/:id/send          -> send a message (HTMX-friendly response)
 *
 * Scoping: conversations are per-site (PrutterService.getOrCreateConversation
 * uses res.locals.site.id). Robin's quote: "Prutter = DM (per .com domain)".
 *
 * Per-site toggle: site.enable_prutter == 0 -> 404 the whole feature.
 *
 * No anonymous DMs — always requires login.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireAuth } from '../middleware/auth.js';
import PermissionsService from '../services/PermissionsService.js';

const router = express.Router();

const MAX_MESSAGE_LEN = 2000;

function siteAllowsDM(req, res) {
  const site = res.locals.site;
  if (!site) return false;
  return site.enable_prutter !== 0;
}

// Middleware: require both auth + Prutter enabled
function requirePrutter(req, res, next) {
  if (!siteAllowsDM(req, res)) return res.status(404).send('Prutter not enabled on this site');
  return requireAuth(req, res, next);
}

// ==================== INBOX ====================
router.get('/', requirePrutter, (req, res) => {
  const prutter = req.app.locals.prutter;
  const conversations = prutter.getUserConversations(req.session.user.id);

  // Filter to only conversations on THIS site (Prutter scope is per-site)
  const siteId = res.locals.site.id;
  const scoped = conversations.filter(c => c.site_id === siteId);

  renderPage(req, res, 'pages/prutter-inbox', {
    pageTitle: 'Prutter',
    bodyClass: 'on-special',
    conversations: scoped,
  });
});

// ==================== START / RESUME CONVERSATION ====================
router.get('/new', requirePrutter, (req, res) => {
  const targetUsername = (req.query.to || '').toString().trim();
  if (!targetUsername) {
    return res.redirect(`${res.locals.siteUrlBase || ''}/prutter`);
  }
  const target = db.prepare('SELECT id, username FROM users WHERE username = ?').get(targetUsername);
  if (!target) return res.status(404).send('User not found');
  if (target.id === req.session.user.id) {
    return res.redirect(`${res.locals.siteUrlBase || ''}/prutter`);
  }

  const prutter = req.app.locals.prutter;
  const conv = prutter.getOrCreateConversation(req.session.user.id, target.id, res.locals.site.id);
  res.redirect(`${res.locals.siteUrlBase || ''}/prutter/${conv.id}`);
});

// ==================== CONVERSATION VIEW ====================
router.get('/:id', requirePrutter, (req, res) => {
  const prutter = req.app.locals.prutter;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).send('Conversation not found');

  // Auth: must be a participant
  const me = req.session.user.id;
  if (conv.user_a_id !== me && conv.user_b_id !== me) return res.status(403).send('Not a participant');

  // Scope: this conversation must belong to the resolved site
  if (conv.site_id !== res.locals.site.id) return res.status(404).send('Conversation not on this site');

  // Other party
  const otherId = conv.user_a_id === me ? conv.user_b_id : conv.user_a_id;
  const other = db.prepare('SELECT id, username, avatar_url FROM users WHERE id = ?').get(otherId);

  // Messages (oldest first for natural reading order)
  const messages = prutter.getMessages(conv.id, 200, 0).reverse();

  // Mark inbound messages as read
  prutter.markAsRead(conv.id, me);

  renderPage(req, res, 'pages/prutter-conversation', {
    pageTitle: 'Prutter — ' + (other?.username || ''),
    bodyClass: 'on-special',
    conversation: conv,
    other,
    messages,
  });
});

// ==================== SEND MESSAGE ====================
router.post('/:id/send', requirePrutter, (req, res) => {
  const prutter = req.app.locals.prutter;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).send('Not found');

  const me = req.session.user.id;
  if (conv.user_a_id !== me && conv.user_b_id !== me) return res.status(403).send('Not a participant');
  if (conv.site_id !== res.locals.site.id) return res.status(404).send('Wrong site');

  const content = (req.body.content || '').toString().trim();
  if (!content) return res.status(400).send('Empty');
  if (content.length > MAX_MESSAGE_LEN) return res.status(413).send('Too long');

  const message = prutter.sendMessage(conv.id, me, content);

  // HTMX request → return the single rendered message HTML, appended to the thread
  if (req.headers['hx-request']) {
    return res.send(
      `<li class="prutter-msg prutter-msg--mine" data-msg-id="${message.id}">` +
      `<div class="prutter-msg-bubble">${escapeHtml(content)}</div>` +
      `</li>`
    );
  }

  res.redirect(`${res.locals.siteUrlBase || ''}/prutter/${conv.id}`);
});

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default router;
