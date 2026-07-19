/**
 * OAuthService — OAuth 2.0 for ActivityPub Client-to-Server (C2S).
 *
 * The AP spec recommends OAuth 2.0 bearer tokens for C2S; the actor document
 * advertises endpoints.oauthAuthorizationEndpoint / oauthTokenEndpoint, and
 * RFC 8414 (/.well-known/oauth-authorization-server) advertises the
 * registration endpoint. Design choices (v1):
 *   - PUBLIC clients only (native apps, RFC 8252): no client secrets,
 *     PKCE S256 is REQUIRED on the authorization-code flow.
 *   - A token is scoped to ONE user + ONE site (multi-site hub: the consent
 *     page picks the site). Scope string is informational ('c2s').
 *   - Tokens are stored hashed (sha256); codes are single-use, 10 min TTL.
 */

import crypto from 'crypto';
import db from '../config/database.js';

const CODE_TTL_MS = 10 * 60 * 1000;

const b64url = (buf) => buf.toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// Redirect URIs: https:// (web) or a custom scheme with a dot (reverse-DNS,
// RFC 8252 §7.1, e.g. com.shaer.app:/callback). Plain http only for loopback.
export function validRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+:$/i.test(u.protocol); // custom reverse-DNS scheme
  } catch { return false; }
}

// RFC 7591 (subset): register a public client. Returns the stored metadata.
export function registerClient({ client_name, redirect_uris }) {
  const name = String(client_name || '').trim().slice(0, 120);
  const uris = (Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris]).filter(Boolean).map(String);
  if (!name) return { error: 'invalid_client_metadata', error_description: 'client_name is required' };
  if (!uris.length || !uris.every(validRedirectUri)) {
    return { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, loopback http, or a reverse-DNS custom scheme' };
  }
  const clientId = b64url(crypto.randomBytes(18));
  db.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?,?,?)')
    .run(clientId, name, JSON.stringify(uris));
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none', // public client: PKCE, no secret
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}

export function getClient(clientId) {
  const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(String(clientId || ''));
  if (!row) return null;
  let uris = []; try { uris = JSON.parse(row.redirect_uris); } catch { /* corrupt row */ }
  return { client_id: row.client_id, client_name: row.client_name, redirect_uris: uris };
}

// Authorization step (after user consent): mint a single-use code.
export function createCode({ clientId, userId, siteSlug, redirectUri, codeChallenge, scope }) {
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(String(codeChallenge))) {
    return { error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required' };
  }
  const code = b64url(crypto.randomBytes(24));
  db.prepare(`INSERT INTO oauth_codes (code, client_id, user_id, site_slug, redirect_uri, code_challenge, scope, expires_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, clientId, userId, siteSlug, redirectUri, codeChallenge, scope || 'c2s',
         new Date(Date.now() + CODE_TTL_MS).toISOString());
  return { code };
}

// Token step: exchange code + PKCE verifier for a bearer token.
export function exchangeCode({ code, client_id, redirect_uri, code_verifier }) {
  const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(String(code || ''));
  // Single use: delete immediately, whatever happens next (replay protection).
  if (row) db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(row.code);
  if (!row) return { error: 'invalid_grant' };
  if (Date.parse(row.expires_at) < Date.now()) return { error: 'invalid_grant', error_description: 'code expired' };
  if (row.client_id !== String(client_id || '')) return { error: 'invalid_grant', error_description: 'client mismatch' };
  if (row.redirect_uri !== String(redirect_uri || '')) return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
  const expected = b64url(sha256(String(code_verifier || '')));
  if (expected !== row.code_challenge) return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
  const token = b64url(crypto.randomBytes(32));
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(b64url(sha256(token)), row.client_id, row.user_id, row.site_slug, row.scope);
  return { access_token: token, token_type: 'Bearer', scope: row.scope };
}

// Resolve "Authorization: Bearer <token>" → { user, site } or null. The C2S
// caller must additionally check the site matches the URL and permissions.
export function verifyBearer(authHeader) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/i.exec(String(authHeader || '').trim());
  if (!m) return null;
  const hash = b64url(sha256(m[1]));
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hash);
  if (!row) return null;
  try { db.prepare('UPDATE oauth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hash); } catch { /* non-fatal */ }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(row.site_slug);
  if (!user || !site) return null;
  return { user, site, scope: row.scope, client_id: row.client_id };
}

export function revokeToken(token) {
  try { db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(b64url(sha256(String(token || '')))); } catch { /* ignore */ }
}

export default { registerClient, getClient, createCode, exchangeCode, verifyBearer, revokeToken, validRedirectUri };
