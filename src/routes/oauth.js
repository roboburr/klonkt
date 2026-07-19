/**
 * OAuth 2.0 routes for ActivityPub Client-to-Server (native/web clients).
 *
 *   POST /oauth/register            dynamic client registration (RFC 7591 subset)
 *   GET  /.well-known/oauth-authorization-server   server metadata (RFC 8414)
 *   GET  /oauth/authorize           consent screen (session-authenticated)
 *   POST /oauth/authorize           user grants → redirect back with ?code
 *   POST /oauth/token               code + PKCE verifier → bearer token
 *
 * Auth model: PUBLIC clients + PKCE only (see OAuthService). The consent screen
 * reuses Klonkt's normal login session; the token it mints is scoped to one
 * user + one of their sites.
 */
import express from 'express';
import db from '../config/database.js';
import OAuth from '../services/OAuthService.js';
import { requireAuth } from '../middleware/auth.js';
import { renderPage } from '../middleware/render.js';
import PermissionsService from '../services/PermissionsService.js';
import { apEnabled } from '../services/SettingsService.js';

const router = express.Router();
router.use((req, res, next) => { if (!apEnabled()) return next('router'); next(); });

const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// Sites this user may post as (owner or co-admin). The consent screen lists these.
function manageableSites(user) {
  return db.prepare('SELECT id, slug, title, owner_id FROM sites ORDER BY created_at')
    .all()
    .filter((s) => PermissionsService.canAdminSite(user, s));
}

// Append query params to a redirect URI WITHOUT re-serializing it: native custom
// schemes (com.shaer.app:/cb) get mangled by new URL().toString() (→ //cb/), and
// RFC 6749 §4.1.2 says to append to the registered URI as-is. The URI is already
// validated against the registered set before we ever call this.
function redirectWith(redirectUri, params) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const sep = redirectUri.includes('?') ? '&' : '?';
  return q ? `${redirectUri}${sep}${q}` : redirectUri;
}

// Hand control back to the client at redirect_uri + params. For a web client
// (http/https) a plain 302 is right. For a NATIVE custom scheme
// (com.klonkt.shaer:/oauth) a 302 is unreliable: mobile browsers routinely drop
// a server redirect to a custom scheme (no user gesture). So we serve a tiny
// interstitial that both auto-forwards AND offers a tap link — a tap is a user
// gesture that launches the app on Android, and iOS's ASWebAuthenticationSession
// intercepts either navigation. Same page for allow and deny (neutral copy).
function finishRedirect(res, redirectUri, params) {
  const target = redirectWith(redirectUri, params);
  if (/^https?:\/\//i.test(redirectUri)) return res.redirect(target);
  const attr = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${attr}">
<title>Return to the app</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
.box{padding:1.5rem}p{color:#aaa;line-height:1.5}a.btn{display:inline-block;margin-top:1.2rem;padding:.85rem 1.7rem;border-radius:12px;background:#5A32E6;color:#fff;text-decoration:none;font-weight:700}</style>
</head><body><div class="box">
<p>Almost done. If the app doesn't open by itself:</p>
<a class="btn" href="${attr}">Open the app</a>
</div>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`);
}

// Bounce back to the client with an OAuth error (RFC 6749 §4.1.2.1) when we have
// a validated redirect_uri; otherwise render a plain error (open-redirect guard).
function authError(res, redirectUri, state, error, desc) {
  if (redirectUri) return finishRedirect(res, redirectUri, { error, error_description: desc, state });
  return res.status(400).json({ error, error_description: desc });
}

// ── RFC 8414: server metadata ────────────────────────────────────────────
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = baseUrl(req);
  res.type('application/json').json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['c2s'],
  });
});

// ── RFC 7591: dynamic client registration ────────────────────────────────
router.post('/oauth/register', (req, res) => {
  const out = OAuth.registerClient({ client_name: req.body.client_name, redirect_uris: req.body.redirect_uris });
  if (out.error) return res.status(400).json(out);
  return res.status(201).json(out);
});

// ── Authorization: consent screen ────────────────────────────────────────
router.get('/oauth/authorize', requireAuth, (req, res) => {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state } = req.query;
  const client = OAuth.getClient(client_id);
  // Pre-redirect validation errors must NOT bounce to an unvalidated URI.
  if (!client) return res.status(400).json({ error: 'invalid_client' });
  if (!client.redirect_uris.includes(String(redirect_uri || ''))) return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
  if (response_type !== 'code') return authError(res, redirect_uri, state, 'unsupported_response_type');
  if (code_challenge_method !== 'S256' || !code_challenge) return authError(res, redirect_uri, state, 'invalid_request', 'PKCE S256 required');

  const sites = manageableSites(req.session.user);
  if (!sites.length) return authError(res, redirect_uri, state, 'access_denied', 'no manageable sites for this account');

  return renderPage(req, res, 'pages/oauth-consent', {
    pageTitleKey: 'oauth.title', bodyClass: 'on-special',
    client, sites, params: { client_id, redirect_uri, code_challenge, scope: scope || 'c2s', state: state || '' },
  });
});

router.post('/oauth/authorize', requireAuth, (req, res) => {
  const { client_id, redirect_uri, code_challenge, scope, state, site_slug, decision } = req.body;
  const client = OAuth.getClient(client_id);
  if (!client || !client.redirect_uris.includes(String(redirect_uri || ''))) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client/redirect mismatch' });
  }
  if (decision !== 'allow') return authError(res, redirect_uri, state, 'access_denied');

  const site = db.prepare('SELECT id, slug, owner_id FROM sites WHERE slug = ?').get(String(site_slug || ''));
  if (!site || !PermissionsService.canAdminSite(req.session.user, site)) {
    return authError(res, redirect_uri, state, 'access_denied', 'not allowed to post as this site');
  }
  const out = OAuth.createCode({
    clientId: client_id, userId: req.session.user.id, siteSlug: site.slug,
    redirectUri: redirect_uri, codeChallenge: code_challenge, scope,
  });
  if (out.error) return authError(res, redirect_uri, state, out.error, out.error_description);
  return finishRedirect(res, redirect_uri, { code: out.code, state });
});

// ── Token exchange ───────────────────────────────────────────────────────
router.post('/oauth/token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.body.grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  const out = OAuth.exchangeCode({
    code: req.body.code, client_id: req.body.client_id,
    redirect_uri: req.body.redirect_uri, code_verifier: req.body.code_verifier,
  });
  if (out.error) return res.status(400).json(out);
  return res.json(out);
});

export default router;
