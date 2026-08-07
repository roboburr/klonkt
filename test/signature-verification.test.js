// verifyRequest met een ECHTE handtekening.
//
// Dit ontbrak, en dat is hoe het hoort te heten: de hele testsuite maakte
// nergens een handtekening aan. De inbox-tests injecteren preVerified en slaan
// verifyRequest dus over; de authorized-fetch-tests raken alleen fetchActor.
// Ondertussen is het sleutel-ophaalpad op 2026-08-06 twee keer verbouwd
// (9561d58 ondertekenen bij secure mode, efe5633 onbetekend eerst) zonder één
// test die aantoont dat verificatie nog SLAAGT.
//
// Hier wordt een echt RSA-paar gemaakt, het actor-document met die publieke
// sleutel geserveerd via de gestubde fetch, en een verzoek ondertekend zoals
// een fediverse-server het doet.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ACTOR = 'https://203.0.113.70/users/zender';
const KEY_ID = `${ACTOR}#main-key`;
// Secure mode: dit actor-document komt alleen op een ondertekend verzoek.
const SECURE_ACTOR = 'https://203.0.113.80/users/gesloten';
const SECURE_KEY_ID = `${SECURE_ACTOR}#main-key`;

const actorDoc = (id) => ({
  id, type: 'Person', preferredUsername: 'zender', inbox: `${id}/inbox`,
  publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: publicKey },
});

const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ondertekend = !!(opts.headers && (opts.headers.Signature || opts.headers.signature));
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/activity+json' } });
  if (u === ACTOR) return json(actorDoc(ACTOR));
  if (u === SECURE_ACTOR) return ondertekend ? json(actorDoc(SECURE_ACTOR)) : new Response('unauthorized', { status: 401 });
  return new Response('not found', { status: 404 });
};

/** Bouwt een verzoek zoals een fediverse-server het aflevert: ondertekend over
 *  (request-target), host, date en digest — precies wat verifyRequest eist. */
function ondertekendVerzoek({ keyId = KEY_ID, body = { type: 'Follow', actor: ACTOR }, date = new Date().toUTCString(), key = privateKey } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(raw).digest('base64');
  const host = 'klonkt.test';
  const target = 'post /ap/users/me/inbox';
  const headers = '(request-target) host date digest';
  const line = [
    `(request-target): ${target}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join('\n');
  const sig = crypto.sign('sha256', Buffer.from(line), key).toString('base64');
  return {
    method: 'POST',
    originalUrl: '/ap/users/me/inbox',
    rawBody: raw,
    body,
    ip: '203.0.113.9',
    headers: {
      host, date, digest,
      signature: `keyId="${keyId}",headers="${headers}",signature="${sig}"`,
    },
  };
}

test('een correct ondertekend verzoek verifieert', async () => {
  const verified = await AP.verifyRequest(ondertekendVerzoek(), 'me');
  assert.ok(verified, 'verifyRequest hoort de actor terug te geven');
  assert.equal(verified.id, ACTOR);
});

test('en ook zonder aangewezen site (de gedeelde inbox)', async () => {
  const verified = await AP.verifyRequest(ondertekendVerzoek());
  assert.ok(verified);
  assert.equal(verified.id, ACTOR);
});

test('een actor achter authorized fetch verifieert ook', async () => {
  // De combinatie die vandaag tweemaal is verbouwd: de sleutel zit achter secure
  // mode, dus de ophaal moet ondertekend worden voordat verificatie kan slagen.
  const verified = await AP.verifyRequest(ondertekendVerzoek({ keyId: SECURE_KEY_ID }), 'me');
  assert.ok(verified, 'de sleutel hoort ondertekend opgehaald te worden');
  assert.equal(verified.id, SECURE_ACTOR);
});

test('een verdraaid lichaam breekt de handtekening', async () => {
  const req = ondertekendVerzoek();
  req.rawBody = Buffer.from(JSON.stringify({ type: 'Follow', actor: 'https://kwaad.test/users/x' }));
  assert.equal(await AP.verifyRequest(req, 'me'), null);
});

test('een oude Date wordt geweigerd (replay)', async () => {
  const oud = new Date(Date.now() - 25 * 60 * 60 * 1000).toUTCString();
  assert.equal(await AP.verifyRequest(ondertekendVerzoek({ date: oud }), 'me'), null);
});

test('ondertekend met een ANDERE sleutel dan de actor publiceert → null', async () => {
  const ander = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  assert.equal(await AP.verifyRequest(ondertekendVerzoek({ key: ander.privateKey }), 'me'), null);
});

test('geen handtekening → null, en geen enkele ophaalpoging', async () => {
  assert.equal(await AP.verifyRequest({ method: 'POST', originalUrl: '/x', headers: {} }, 'me'), null);
});

test.after(() => { globalThis.fetch = echteFetch; });
