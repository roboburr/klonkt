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
 *     page picks the site).
 *   - The scope is ENFORCED, closed by default (shaer-ivi4, shaer-4jb1).
 *     `c2s` is everything; `read` reads, `write` writes (FEP-d8c2's names);
 *     `write:door` is only Playtime's door. What a request needs follows from
 *     its METHOD (needFor), not from a list a new route could be left out of,
 *     and verifyBearer without a need asks for read + write.
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

// ── Scopes ─────────────────────────────────────────────────────────────
//
// Wat een scope toestaat, in rechten. `c2s` is alles wat er is, zodat de
// tokens van Shaer en Android blijven werken. `read` en `write` zijn de namen
// uit het voorbeeld van FEP-d8c2 (shaer-4jb1). `write:door` is alleen de deur
// van Playtime (shaer-ivi4) en zijn eigen sleutel: zetten en weghalen, verder
// niets, ook niet lezen. De naam volgt write:<ding>, dus `write` omvat hem.
const GRANTS = {
  c2s: ['read', 'write', 'write:door'],
  read: ['read'],
  write: ['write', 'write:door'],
  'write:door': ['write:door'],
};
/** Wat een client vandaag mag vragen (RFC 8414 scopes_supported). */
export const SCOPES_SUPPORTED = ['read', 'write', 'c2s', 'write:door'];
/** Wat een route vraagt als hij niets noemt: alles van vóór de scopes. */
const FULL = ['read', 'write'];

/**
 * Een gevraagde scope (RFC 6749 §3.3: met spaties gescheiden) lezen.
 * Leeg is `c2s`, zoals altijd. Een onbekende scope wordt GEWEIGERD en niet
 * stil c2s: een app die om minder vraagt mag niet meer krijgen.
 */
export function parseScope(scope) {
  const delen = [...new Set(String(scope == null ? '' : scope).split(/\s+/).filter(Boolean))];
  if (!delen.length) return { scope: 'c2s', parts: ['c2s'] };
  const onbekend = delen.filter((d) => !SCOPES_SUPPORTED.includes(d));
  if (onbekend.length) return { error: 'invalid_scope', error_description: `unsupported scope: ${onbekend.join(' ')}` };
  return { scope: delen.join(' '), parts: delen };
}

/** De rechten achter een opgeslagen scope. Een leeg veld is een oud c2s-token. */
export function grantsOf(scope) {
  const uit = new Set();
  const delen = String(scope == null ? '' : scope).split(/\s+/).filter(Boolean);
  for (const d of (delen.length ? delen : ['c2s'])) for (const g of (GRANTS[d] || [])) uit.add(g);
  return uit;
}

/** Mag een token met deze scope wat de route vraagt? */
export function scopeAllows(scope, need = FULL) {
  const heeft = grantsOf(scope);
  return [].concat(need).every((n) => heeft.has(n));
}

/**
 * Wat een C2S-verzoek vraagt. Op de METHODE, zodat een route die er later
 * bijkomt niet vergeten kan worden: lezen is `read`, al het andere `write`.
 * Drie paden wijken af, en dat zijn alle drie die van Playtime:
 *   - de deur: lezen is openbaar (null), zetten en weghalen is `write:door`;
 *   - de identiteitsbewijzen: `write:door`, en de route laat zo'n token alleen
 *     aan de sleutels komen die het zelf koppelde (`write` mag alles);
 *   - de open deuren: lezen is `read`, de schakelaar is `write:door`.
 */
export function needFor(req) {
  const pad = String(req.path || '').replace(/\/+$/, '');
  const lezen = req.method === 'GET' || req.method === 'HEAD';
  if (/\/door$/.test(pad)) return lezen ? null : 'write:door';
  if (/\/identityProofs$/.test(pad)) return 'write:door';
  if (/\/openDoors$/.test(pad)) return lezen ? 'read' : 'write:door';
  return lezen ? 'read' : 'write';
}

/** Het token achter een header, zonder iets te controleren of bij te werken. */
export function inspectBearer(authHeader) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/i.exec(String(authHeader || '').trim());
  if (!m) return null;
  const row = db.prepare('SELECT scope, client_id FROM oauth_tokens WHERE token_hash = ?').get(b64url(sha256(m[1])));
  return row || null;
}

/**
 * FEP-c180 "Client not authorized": de gebruiker mag het misschien wel, deze
 * client niet -- zijn scope dekt het niet. 403 met het client-id erbij.
 */
export function clientNotAuthorized(res, { clientId, need }) {
  return res.status(403).type('application/problem+json').send(JSON.stringify({
    type: 'https://w3id.org/fep/c180#client-not-authorized',
    title: 'Client not authorized',
    status: 403,
    detail: need ? `This token's scope does not include ${need}.` : "This token's scope does not cover this request.",
    client: clientId || null,
  }));
}

// Authorization step (after user consent): mint a single-use code.
export function createCode({ clientId, userId, siteSlug, redirectUri, codeChallenge, scope }) {
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(String(codeChallenge))) {
    return { error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required' };
  }
  const gelezen = parseScope(scope);
  if (gelezen.error) return gelezen;
  scope = gelezen.scope;
  const code = b64url(crypto.randomBytes(24));
  db.prepare(`INSERT INTO oauth_codes (code, client_id, user_id, site_slug, redirect_uri, code_challenge, scope, expires_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, clientId, userId, siteSlug, redirectUri, codeChallenge, scope,
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
//
// `need` is what the route asks for. Leave it out and the route asks for
// read + write, which only c2s gives: closed by default, so a route nobody
// thought about refuses a narrow token instead of serving it. A token that
// lacks the scope gets null, exactly like an unknown one.
export function verifyBearer(authHeader, need = FULL) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/i.exec(String(authHeader || '').trim());
  if (!m) return null;
  const hash = b64url(sha256(m[1]));
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hash);
  if (!row) return null;
  if (!scopeAllows(row.scope, need)) return null;
  try { db.prepare('UPDATE oauth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hash); } catch { /* non-fatal */ }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(row.site_slug);
  if (!user || !site) return null;
  return { user, site, scope: row.scope, client_id: row.client_id };
}

export function revokeToken(token) {
  try { db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(b64url(sha256(String(token || '')))); } catch { /* ignore */ }
}

// The active authorizations (bearer tokens) a user has granted, with the app
// name and the site each is scoped to. The bearer itself is never stored, so
// revocation is keyed on token_hash: safe to render, you cannot derive the
// token from its hash.
export function listAuthorizations(userId) {
  return db.prepare(`
    SELECT t.token_hash, t.site_slug, t.scope, t.created_at, t.last_used_at, c.client_name
    FROM oauth_tokens t
    LEFT JOIN oauth_clients c ON c.client_id = t.client_id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
  `).all(String(userId || ''));
}

// Revoke one authorization, scoped to the owner so a user can only revoke their
// own tokens. Returns true when a row was removed.
export function revokeAuthorization(userId, tokenHash) {
  try {
    const r = db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND user_id = ?')
      .run(String(tokenHash || ''), String(userId || ''));
    return r.changes > 0;
  } catch { return false; }
}

export default {
  registerClient, getClient, createCode, exchangeCode, verifyBearer, revokeToken, validRedirectUri,
  listAuthorizations, revokeAuthorization, parseScope, grantsOf, scopeAllows, SCOPES_SUPPORTED,
  needFor, inspectBearer, clientNotAuthorized,
};
