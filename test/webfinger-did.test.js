// WebFinger op een did:key (FEP-c390, shaer-jpxj): wie een papieren sleutel
// vasthoudt, vraagt welk account zegt dat het die sleutel is.
//
// Wat hier bewaakt wordt: alleen wat NU klopt (een verklaring die niet meer
// natelopen is telt niet), alleen openbare sites (net als acct:), twee accounts
// met dezelfde sleutel staan er allebei (oud en nieuw na een verhuizing), en
// een acct:-vraag gaat precies als vroeger.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const I = await import('../src/services/IdentityProof.js');

const seedA = Buffer.alloc(32, 7);
const seedB = Buffer.alloc(32, 9);
const didA = I.didKeyFromPublicKey(I.publicKeyFromSeed(seedA));
const didB = I.didKeyFromPublicKey(I.publicKeyFromSeed(seedB));
const actorOf = (slug) => `https://test.example/ap/users/${slug}`;
function verklaring(seed, slug) {
  const did = I.didKeyFromPublicKey(I.publicKeyFromSeed(seed));
  const doc = { '@context': I.STATEMENT_CONTEXT, type: 'VerifiableIdentityStatement', subject: did, alsoKnownAs: actorOf(slug) };
  return I.signEddsaJcs2022(doc, seed, { created: '2026-10-24T10:00:00Z', verificationMethod: did, proofPurpose: 'assertionMethod' });
}

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
const site = (id, slug, proofs, isPublic = 1) => db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary, identity_proofs) VALUES (?,?,?,?,?,?,?)')
  .run(id, slug, slug, 'u1', isPublic, id === 's1' ? 1 : 0, proofs ? JSON.stringify(proofs) : null);
site('s1', 'oud', [verklaring(seedA, 'oud')]);
site('s2', 'nieuw', [verklaring(seedA, 'nieuw')]);          // dezelfde sleutel, na een verhuizing
site('s3', 'besloten', [verklaring(seedB, 'besloten')], 0);  // niet openbaar
// Een verklaring die op de verkeerde actor staat: geldig ondertekend, maar voor 'oud'.
site('s4', 'leent', [verklaring(seedA, 'oud')]);

const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const app = express(); app.use(routes);
const server = app.listen(0); server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const wf = (resource) => fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);

test('een gekoppelde sleutel vindt zijn accounts, oud en nieuw allebei', async () => {
  const r = await wf(didA);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/jrd\+json/);
  const jrd = await r.json();
  assert.equal(jrd.subject, didA);
  assert.deepEqual(jrd.links.map((l) => l.href), [actorOf('nieuw'), actorOf('oud')]);
  assert.ok(jrd.links.every((l) => l.rel === 'self' && l.type === 'application/activity+json'));
  assert.ok(!jrd.links.some((l) => l.href === actorOf('leent')), 'een verklaring voor een ander account telt niet voor deze');
});

test('een sleutel die nergens aan hangt, of alleen aan een besloten site, is er niet', async () => {
  assert.equal((await wf(I.didKeyFromPublicKey(I.publicKeyFromSeed(Buffer.alloc(32, 1))))).status, 404);
  assert.equal((await wf(didB)).status, 404, 'besloten sites tellen niet mee, net als bij acct:');
});

test('een verklaring die niet meer klopt, telt niet', async () => {
  const geknoeid = verklaring(seedA, 'oud'); geknoeid.proof.created = '2030-01-01T00:00:00Z';
  db.prepare("UPDATE sites SET identity_proofs = ? WHERE id = 's1'").run(JSON.stringify([geknoeid]));
  try {
    const jrd = await (await wf(didA)).json();
    assert.deepEqual(jrd.links.map((l) => l.href), [actorOf('nieuw')]);
  } finally {
    db.prepare("UPDATE sites SET identity_proofs = ? WHERE id = 's1'").run(JSON.stringify([verklaring(seedA, 'oud')]));
  }
});

test('geen did:key is geen did-vraag, en acct: gaat als vroeger', async () => {
  assert.equal((await wf('did:key:zNietBase58!!')).status, 400);
  const r = await wf('acct:oud@test.example');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).subject, 'acct:oud@test.example');
});
