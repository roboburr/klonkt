/**
 * Rate limiters — anti-brute-force.
 *
 * In-memory store via express-rate-limit's default. Fine for a single Node
 * process. If we ever scale to multiple workers, swap to a shared store
 * (Redis or rate-limit-redis).
 *
 * Friendly 429 response handles HTMX requests (returns HX-Redirect to the
 * form page so the error is shown inline) and full requests (renders a
 * small message page).
 */

import rateLimit from 'express-rate-limit';
import { renderPage } from './render.js';

// Behind Cloudflare/Caddy, req.ip can arrive as "1.2.3.4:11046" (IPv4 with
// port). express-rate-limit v7 validates the IP and otherwise throws
// ERR_ERL_INVALID_IP_ADDRESS — uncaught async → the process crashes (and pm2
// enters a restart loop). Strip a trailing IPv4 port, fall back to the
// socket address, and leave IPv6 (multiple colons) untouched.
function clientKey(req) {
  let ip = req.ip || req.socket?.remoteAddress || '';
  // Strip a trailing IPv4 port (1.2.3.4:11046 -> 1.2.3.4)
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.split(':')[0];
  // IPv6-mapped IPv4 (::ffff:1.2.3.4) -> the plain IPv4
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  // Real IPv6: key on the /64 network prefix, not the full address. A single
  // user/allocation is usually a whole /64, so this stops an attacker from
  // getting a fresh budget by rotating addresses within their own range.
  if (ip.includes(':')) {
    const left = ip.includes('::') ? ip.split('::')[0] : ip;
    const groups = left.split(':').filter(Boolean);
    while (groups.length < 4) groups.push('0');
    return groups.slice(0, 4).join(':') + '::/64';
  }
  return ip || 'unknown';
}

function blockedHandler(viewName, bodyClass, friendlyMsg) {
  return (req, res, next, options) => {
    const message = `${friendlyMsg} Try again in a few minutes.`;
    if (req.headers['hx-request'] === 'true') {
      // HTMX: surface the error in the form's error slot via partial render.
      return renderPage(req, res, viewName, {
        pageTitle: 'Too many attempts',
        bodyClass,
        error: message,
        username: req.body?.username || '',
        email: req.body?.email || '',
      });
    }
    res.status(options.statusCode).type('html').send(`
      <div style="font-family:system-ui;max-width:520px;margin:4rem auto;padding:2rem;text-align:center;">
        <h1 style="font-size:2rem;margin:0 0 0.5rem;">Too many attempts</h1>
        <p>${message}</p>
        <p><a href="/" style="color:#c2410c;">&larr; Home</a></p>
      </div>
    `);
  };
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15 min
  max: 5,                          // 5 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: { ip: false },
  // Only count failed attempts. Successful logins don't burn the budget.
  skipSuccessfulRequests: true,
  handler: blockedHandler('pages/auth-login', 'on-special', 'Too many login attempts.'),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,        // 1 hour
  max: 5,                          // 5 signups per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: { ip: false },
  skipSuccessfulRequests: false,   // any attempt counts (registration spam is the concern)
  handler: blockedHandler('pages/auth-register', 'on-special', 'Too many signup attempts.'),
});

// ─── Fediverse (/ap/*) ────────────────────────────────────────────
// These endpoints are hit by REMOTE SERVERS, not browsers, so the default
// plain-text 429 is the right response (no HTML page). Deliberately generous:
// legitimate federation from one instance never comes close, but a flood from
// a single IP is capped. Per-IP via the same /64-aware clientKey.

// Baseline read cap across all /ap/* (actor, outbox, notes, webfinger, …).
// 5 req/sec per IP — far above any real Mastodon polling.
export const apReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: { ip: false },
});

// Inbox POSTs each trigger an outbound actor fetch (signature verify) → cap the
// amplification/queue-inflation a single source can drive. 120/min/IP is still
// generous for a small site's inbound federation; bump if a busy instance trips it.
export const apInboxLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: { ip: false },
});
