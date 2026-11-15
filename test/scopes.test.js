// Scopes (shaer-4jb1): read, write, c2s en write:door, afgedwongen op de
// METHODE, met een FEP-c180-antwoord als een token het verzoek niet dekt.
// En de sleutels van Playtime (shaer-ivi4): een write:door-token koppelt en
// ontkoppelt zijn eigen sleutel, en laat die van een ander met rust.
//
// In-memory SQLite. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { readFileSync } from 'fs';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
const BASE = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const OAuth = await import('../src/services/OAuthService.js');
const I = await import('../src/services/IdentityProof.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'eigen', 'Eigen', 'u1');
const ACTOR = `${BASE}/ap/users/eigen`;

// Een volger, zodat een actor-Update ergens heen moet en we hem kunnen tellen.
const VOLGER = 'https://203.0.113.50/users/volger';
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox, shared_inbox) VALUES (?,?,?,?)').run('eigen', VOLGER, `${VOLGER}/inbox`, null);

const tokens = {};
for (const [naam, scope, client] of [
  ['lees', 'read', 'playtime'], ['schrijf', 'write', 'bot'], ['c2s', 'c2s', 'shaer'],
  ['deur', 'write:door', 'playtime'], ['playtime', 'read write:door', 'playtime'], ['anderedeur', 'write:door', 'nog-een-app'],
]) {
  tokens[naam] = `test-token-${naam}-` + 'e'.repeat(24);
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(tokens[naam]).digest('base64url'), client, 'u1', 'eigen', scope);
}

const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const LOKAAL = `http://127.0.0.1:${server.address().port}`;
server.unref();

const bezorgd = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(LOKAAL)) return echteFetch(url, opts);
  if (opts.method === 'POST') {
    try { bezorgd.push({ naar: u, activiteit: JSON.parse(opts.body) }); } catch { /* geen JSON */ }
    return new Response('', { status: 202 });
  }
  return new Response('{}', { status: 404 });
};
after(() => { globalThis.fetch = echteFetch; server.close(); });

const vraag = (pad, token, { method = 'GET', body } = {}) => echteFetch(`${LOKAAL}${pad}`, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${tokens[token] || token}` } : {}), ...(body ? { 'Content-Type': 'application/activity+json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const even = () => new Promise((r) => setTimeout(r, 60));

async function c180(r, client) {
  assert.equal(r.status, 403);
  assert.match(r.headers.get('content-type'), /application\/problem\+json/);
  const p = await r.json();
  assert.equal(p.type, 'https://w3id.org/fep/c180#client-not-authorized');
  assert.equal(p.status, 403);
  if (client) assert.equal(p.client, client);
  return p;
}

// ── Wat een verzoek vraagt ────────────────────────────────────────

test('needFor volgt de methode, met de drie paden van Playtime als uitzondering', () => {
  const n = (method, path) => OAuth.needFor({ method, path });
  assert.equal(n('GET', '/ap/users/x/inbox'), 'read');
  assert.equal(n('HEAD', '/ap/users/x/following'), 'read');
  assert.equal(n('POST', '/ap/users/x/outbox'), 'write');
  assert.equal(n('POST', '/ap/users/x/uploadMedia'), 'write');
  assert.equal(n('DELETE', '/ap/users/x/anything-new'), 'write', 'een nieuwe route is vanzelf write');
  assert.equal(n('GET', '/ap/users/x/door'), null, 'de deur lezen is openbaar');
  assert.equal(n('PUT', '/ap/users/x/door'), 'write:door');
  assert.equal(n('POST', '/ap/users/x/identityProofs'), 'write:door');
  assert.equal(n('GET', '/ap/users/x/openDoors'), 'read');
  assert.equal(n('PUT', '/ap/users/x/openDoors'), 'write:door');
});

test('elke bearer-controle in de routes zegt wat hij vraagt', () => {
  const bron = readFileSync(new URL('../src/routes/activitypub.js', import.meta.url), 'utf8');
  const kaal = bron.match(/verifyBearer\(req\.headers\.authorization\)/g) || [];
  assert.equal(kaal.length, 0, 'een kale verifyBearer valt terug op read + write; zeg het liever');
});

// ── read ──────────────────────────────────────────────────────────

test('read leest de inbox en de eigenaar-collecties', async () => {
  for (const pad of ['/ap/users/eigen/inbox', '/ap/users/eigen/following', '/ap/users/eigen/followers', '/ap/users/eigen/blocked']) {
    const r = await vraag(pad, 'lees');
    assert.equal(r.status, 200, `${pad} gaf ${r.status}`);
  }
});

test('read schrijft nergens: elke schrijfweg geeft FEP-c180 met het client-id', async () => {
  await c180(await vraag('/ap/users/eigen/outbox', 'lees', { method: 'POST', body: { type: 'Note', content: 'hoi' } }), 'playtime');
  await c180(await vraag('/ap/users/eigen/uploadMedia', 'lees', { method: 'POST', body: {} }));
  await c180(await vraag('/ap/users/eigen/identityProofs', 'lees', { method: 'POST', body: {} }));
  await c180(await vraag('/ap/users/eigen/door', 'lees', { method: 'PUT', body: {} }));
  await c180(await vraag('/ap/users/eigen/identityProofs?subject=did:key:z6Mk', 'lees', { method: 'DELETE' }));
});

test('write alleen leest niet, maar komt wel langs de poort', async () => {
  const p = await c180(await vraag('/ap/users/eigen/inbox', 'schrijf'), 'bot');
  assert.match(p.detail, /read/);
  const r = await vraag('/ap/users/eigen/outbox', 'schrijf', { method: 'POST', body: { type: 'Note', content: '<p>hoi</p>', to: [] } });
  assert.notEqual(r.headers.get('content-type') || '', 'application/problem+json');
  assert.ok(r.status !== 403, `outbox gaf ${r.status}`);
});

test('c2s mag alles nog, en een onbekend token beslist de route zelf', async () => {
  assert.equal((await vraag('/ap/users/eigen/inbox', 'c2s')).status, 200);
  const r = await vraag('/ap/users/eigen/inbox', 'onbekend-token-dat-lang-genoeg-is-xx');
  assert.ok([401, 403].includes(r.status));
  assert.doesNotMatch(r.headers.get('content-type') || '', /problem\+json/, 'een dood token is geen scopevraag');
});

test('wat Playtime vraagt, read write:door, leest en zet de deur maar post niet', async () => {
  assert.equal((await vraag('/ap/users/eigen/following', 'playtime')).status, 200);
  await c180(await vraag('/ap/users/eigen/outbox', 'playtime', { method: 'POST', body: { type: 'Note', content: 'hoi' } }));
  const r = await vraag('/ap/users/eigen/door', 'playtime', { method: 'PUT', body: {} });
  assert.equal(r.status, 422, 'langs de scope, en dan geweigerd om de deur zelf');
});

// ── De sleutels van Playtime ──────────────────────────────────────

const sleutel = () => { const seed = crypto.randomBytes(32); return { seed, did: I.didKeyFromPublicKey(I.publicKeyFromSeed(seed)) }; };
const verklaring = ({ seed, did }, created = '2026-11-15T12:00:00Z') => I.signEddsaJcs2022(
  { '@context': I.STATEMENT_CONTEXT, type: 'VerifiableIdentityStatement', subject: did, alsoKnownAs: ACTOR },
  seed, { created, verificationMethod: did, proofPurpose: 'assertionMethod' });
const koppel = (k, token, created) => vraag('/ap/users/eigen/identityProofs', token, { method: 'POST', body: verklaring(k, created) });
const ontkoppel = (k, token) => vraag(`/ap/users/eigen/identityProofs?subject=${encodeURIComponent(k.did)}`, token, { method: 'DELETE' });
const subjects = () => JSON.parse(db.prepare("SELECT identity_proofs FROM sites WHERE slug = 'eigen'").get().identity_proofs || '[]').map((b) => b.subject);
const updates = () => bezorgd.filter((b) => b.activiteit.type === 'Update');

const papier = sleutel();
const playtime = sleutel();

test('Shaer koppelt de papieren sleutel met c2s, en de volgers horen het', async () => {
  bezorgd.length = 0;
  assert.equal((await koppel(papier, 'c2s')).status, 201);
  await even();
  assert.equal(updates().length, 1);
});

test('write:door koppelt de sleutel van Playtime', async () => {
  bezorgd.length = 0;
  assert.equal((await koppel(playtime, 'deur')).status, 201);
  assert.deepEqual(subjects(), [papier.did, playtime.did]);
  await even();
  assert.equal(updates().length, 1, 'een nieuwe sleutel is een nieuwe bewering');
});

test('opnieuw koppelen bij elke aanmelding stuurt de volgers niets', async () => {
  bezorgd.length = 0;
  assert.equal((await koppel(playtime, 'deur', '2026-11-15T13:00:00Z')).status, 201);
  await even();
  assert.equal(updates().length, 0, 'alleen het bewijs is vernieuwd');
  assert.deepEqual(subjects(), [papier.did, playtime.did]);
});

test('write:door komt niet aan de papieren sleutel, en een andere app niet aan die van Playtime', async () => {
  await c180(await ontkoppel(papier, 'deur'), 'playtime');
  await c180(await ontkoppel(playtime, 'anderedeur'), 'nog-een-app');
  await c180(await koppel(playtime, 'anderedeur'), 'nog-een-app');
  assert.deepEqual(subjects(), [papier.did, playtime.did], 'beide staan er nog');
});

test('Playtime ontkoppelt zijn eigen sleutel bij het afmelden', async () => {
  assert.equal((await ontkoppel(playtime, 'playtime')).status, 204, 'een ander token van dezelfde client');
  assert.deepEqual(subjects(), [papier.did]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM identity_proof_clients WHERE subject = ?').get(playtime.did).n, 0);
});

test('write (en c2s) mag elke sleutel', async () => {
  assert.equal((await koppel(playtime, 'deur')).status, 201);
  assert.equal((await ontkoppel(playtime, 'schrijf')).status, 204);
  assert.equal((await ontkoppel(papier, 'c2s')).status, 204);
  assert.deepEqual(subjects(), []);
});
