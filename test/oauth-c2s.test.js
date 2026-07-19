// OAuth 2.0 C2S: PKCE authorization-code round-trip, replay protection, bearer
// resolution, and redirect-URI validation. In-memory DB.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
const OAuth = await import('../src/services/OAuthService.js');
dbMod.initializeDatabase();

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'r@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');

const b64url = (b) => b.toString('base64url');
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

test('validRedirectUri: https, loopback and reverse-DNS ok; plain http not', () => {
  assert.equal(OAuth.validRedirectUri('https://app.example/cb'), true);
  assert.equal(OAuth.validRedirectUri('http://127.0.0.1:1234/cb'), true);
  assert.equal(OAuth.validRedirectUri('com.shaer.app:/callback'), true);
  assert.equal(OAuth.validRedirectUri('http://evil.example/cb'), false);
  assert.equal(OAuth.validRedirectUri('not a url'), false);
});

test('register rejects a bad redirect_uri', () => {
  const bad = OAuth.registerClient({ client_name: 'X', redirect_uris: ['http://evil.example/cb'] });
  assert.equal(bad.error, 'invalid_redirect_uri');
});

test('full PKCE flow yields a working bearer token', () => {
  const reg = OAuth.registerClient({ client_name: 'Shaer', redirect_uris: ['com.shaer.app:/cb'] });
  assert.ok(reg.client_id);
  assert.equal(reg.token_endpoint_auth_method, 'none');

  const { verifier, challenge } = pkce();
  const { code } = OAuth.createCode({
    clientId: reg.client_id, userId: 'u1', siteSlug: 'me',
    redirectUri: 'com.shaer.app:/cb', codeChallenge: challenge, scope: 'c2s',
  });
  assert.ok(code);

  const tok = OAuth.exchangeCode({ code, client_id: reg.client_id, redirect_uri: 'com.shaer.app:/cb', code_verifier: verifier });
  assert.equal(tok.token_type, 'Bearer');
  assert.ok(tok.access_token);

  const who = OAuth.verifyBearer('Bearer ' + tok.access_token);
  assert.equal(who.user.id, 'u1');
  assert.equal(who.site.slug, 'me');

  // Replay: the same code must not work twice.
  const replay = OAuth.exchangeCode({ code, client_id: reg.client_id, redirect_uri: 'com.shaer.app:/cb', code_verifier: verifier });
  assert.equal(replay.error, 'invalid_grant');
});

test('createCode requires a PKCE challenge', () => {
  const r = OAuth.createCode({ clientId: 'c', userId: 'u1', siteSlug: 'me', redirectUri: 'com.shaer.app:/cb', codeChallenge: '' });
  assert.equal(r.error, 'invalid_request');
});

test('wrong PKCE verifier is rejected', () => {
  const reg = OAuth.registerClient({ client_name: 'Shaer2', redirect_uris: ['com.shaer.app:/cb'] });
  const { challenge } = pkce();
  const { code } = OAuth.createCode({ clientId: reg.client_id, userId: 'u1', siteSlug: 'me', redirectUri: 'com.shaer.app:/cb', codeChallenge: challenge });
  const bad = OAuth.exchangeCode({ code, client_id: reg.client_id, redirect_uri: 'com.shaer.app:/cb', code_verifier: 'wrong-verifier' });
  assert.equal(bad.error, 'invalid_grant');
});

test('verifyBearer returns null for garbage and revoked tokens', () => {
  assert.equal(OAuth.verifyBearer('Bearer nope-nope-nope-nope-nope'), null);
  assert.equal(OAuth.verifyBearer(''), null);
  const reg = OAuth.registerClient({ client_name: 'Shaer3', redirect_uris: ['com.shaer.app:/cb'] });
  const { verifier, challenge } = pkce();
  const { code } = OAuth.createCode({ clientId: reg.client_id, userId: 'u1', siteSlug: 'me', redirectUri: 'com.shaer.app:/cb', codeChallenge: challenge });
  const tok = OAuth.exchangeCode({ code, client_id: reg.client_id, redirect_uri: 'com.shaer.app:/cb', code_verifier: verifier });
  OAuth.revokeToken(tok.access_token);
  assert.equal(OAuth.verifyBearer('Bearer ' + tok.access_token), null);
});
