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
  // Only count failed attempts. Successful logins don't burn the budget.
  skipSuccessfulRequests: true,
  handler: blockedHandler('pages/auth-login', 'on-special', 'Too many login attempts.'),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,        // 1 hour
  max: 5,                          // 5 signups per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,   // any attempt counts (registration spam is the concern)
  handler: blockedHandler('pages/auth-register', 'on-special', 'Too many signup attempts.'),
});
