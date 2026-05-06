/**
 * Auth middleware
 */

/**
 * Validate a "next" URL for safe redirect after login.
 * Returns the URL if safe, otherwise null.
 *
 * Rules:
 *  - Must be a string, max 256 chars (prevent abuse).
 *  - Must start with "/" but NOT "//" or "/\" (no protocol-relative open redirects).
 *  - Must not point back at /auth/* (prevents login → login loop).
 */
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.length || raw.length > 256) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  if (/^\/auth(\/|$)/i.test(raw)) return null;
  return raw;
}

function loginRedirect(req, res) {
  // Preserve the originally-requested URL so login can return us there.
  const next = encodeURIComponent(req.originalUrl || req.url || '/');
  const target = `/auth/login?next=${next}`;
  if (req.headers['hx-request'] === 'true') {
    res.setHeader('HX-Redirect', target);
    return res.status(401).send('Login required');
  }
  return res.redirect(target);
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  next();
}

export function requireGod(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  if (req.session.user.role !== 'god') {
    return res.status(403).send('God role required');
  }
  next();
}
