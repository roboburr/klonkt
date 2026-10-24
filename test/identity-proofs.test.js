// Identiteitsbewijzen (FEP-c390, shaer-jpxj): een sleutel van elders zegt dat
// dit account van hem is; Klonkt controleert en publiceert, en ondertekent zelf
// niets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const I = await import('../src/services/IdentityProof.js');

// ── De W3C-testvector (vc-di-eddsa, B.3) ──────────────────────────
//
// Ed25519 is deterministisch, dus dezelfde sleutel en hetzelfde document moeten
// byte voor byte dezelfde handtekening geven. Is dat zo, dan kloppen JCS, de
// hashes en de volgorde ervan allemaal -- niet alleen met zichzelf.
const W3C_SECRET = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';
const W3C_DID = 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const W3C_DOC = {
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'],
  id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
  type: ['VerifiableCredential', 'AlumniCredential'],
  name: 'Alumni Credential',
  description: 'A minimum viable example of an Alumni Credential.',
  issuer: 'https://vc.example/issuers/5678',
  validFrom: '2023-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
};
const seed = I.seedFromSecretKeyMultibase(W3C_SECRET);

test('W3C: de sleutel geeft de did:key uit de specificatie', () => {
  assert.equal(I.didKeyFromPublicKey(I.publicKeyFromSeed(seed)), W3C_DID);
});

test('W3C: de canonieke vorm en zijn hash zijn die uit voorbeeld 31 en 32', () => {
  const canon = I.jcs(W3C_DOC);
  assert.equal(canon, '{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],"credentialSubject":{"alumniOf":"The School of Examples","id":"did:example:abcdefgh"},"description":"A minimum viable example of an Alumni Credential.","id":"urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33","issuer":"https://vc.example/issuers/5678","name":"Alumni Credential","type":["VerifiableCredential","AlumniCredential"],"validFrom":"2023-01-01T00:00:00Z"}');
  assert.equal(crypto.createHash('sha256').update(canon).digest('hex'), '59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19');
});

test('W3C: de handtekening is byte voor byte die uit voorbeeld 38, en klopt', () => {
  const vm = `${W3C_DID}#${W3C_DID.slice('did:key:'.length)}`;
  const s = I.signEddsaJcs2022(W3C_DOC, seed, { created: '2023-02-24T23:36:38Z', verificationMethod: vm, proofPurpose: 'assertionMethod' });
  assert.equal(s.proof.proofValue, 'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX');
  assert.equal(I.verifyEddsaJcs2022(s, I.publicKeyFromDidKey(W3C_DID)), true);
});

// ── De bouwstenen ─────────────────────────────────────────────────

test('JCS sorteert op UTF-16-code-eenheden, en schrijft getallen zoals ECMAScript', () => {
  // U+1F600 (😀) is in UTF-16 😀, en dat valt VOOR U+FB01 (ﬁ, ﬁ)
  // -- op codepunt zou het erna komen. RFC 8785 kiest UTF-16.
  assert.equal(I.jcs({ 'ﬁ': 1, '😀': 2, a: 3 }), '{"a":3,"😀":2,"ﬁ":1}');
  assert.equal(I.jcs({ n: 1e21, m: 0.1, z: -0 }), '{"m":0.1,"n":1e+21,"z":0}');
  assert.throws(() => I.jcs({ x: NaN }));
});

test('base58 overleeft voorloopnullen en een retour', () => {
  for (const hex of ['', '00', '0000ff', 'deadbeef', '00'.repeat(5) + '01']) {
    const b = Buffer.from(hex, 'hex');
    assert.deepEqual(I.base58Decode(I.base58Encode(b)), b, hex);
  }
  assert.equal(I.base58Decode('0OIl'), null, 'tekens buiten het alfabet');
});

test('alleen een Ed25519-did:key wordt als sleutel gelezen', () => {
  assert.ok(I.publicKeyFromDidKey(W3C_DID));
  assert.equal(I.publicKeyFromDidKey('did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'), null, 'P-256');
  assert.equal(I.publicKeyFromDidKey('did:web:example.com'), null);
  assert.equal(I.publicKeyFromDidKey(`${W3C_DID}#frag`), null);
});

// ── FEP-c390: de verklaring ───────────────────────────────────────

const ACTOR = 'https://test.example/ap/users/kind';
function verklaring(extra = {}, { actor = ACTOR, vm = W3C_DID } = {}) {
  const doc = { '@context': I.STATEMENT_CONTEXT, type: 'VerifiableIdentityStatement', subject: W3C_DID, alsoKnownAs: actor, ...extra };
  return I.signEddsaJcs2022(doc, seed, { created: '2026-10-24T10:00:00Z', verificationMethod: vm, proofPurpose: 'assertionMethod' });
}

test('een goede verklaring wordt aangenomen', () => {
  assert.deepEqual(I.checkStatement(verklaring(), ACTOR), { ok: true, subject: W3C_DID });
});

test('elke regel van c390 weigert met zijn eigen reden', () => {
  assert.equal(I.checkStatement(verklaring({}, { actor: 'https://elders.example/users/x' }), ACTOR).error,
    'alsoKnownAs_is_not_this_actor', 'een verklaring voor een ander account');
  assert.equal(I.checkStatement(verklaring({}, { vm: `${W3C_DID}#${W3C_DID.slice(8)}` }), ACTOR).error,
    'verificationMethod_is_not_subject', 'c390 eist precies de subject, zonder fragment');
  const anders = { ...verklaring(), type: 'Note' };
  assert.equal(I.checkStatement(anders, ACTOR).error, 'wrong_type');
  const geknoeid = verklaring(); geknoeid.proof = { ...geknoeid.proof, created: '2030-01-01T00:00:00Z' };
  assert.equal(I.checkStatement(geknoeid, ACTOR).error, 'bad_signature', 'een gewijzigd veld in de proof');
  const ander = verklaring(); ander.extra = 'erbij';
  assert.equal(I.checkStatement(ander, ACTOR).error, 'bad_signature', 'een veld erbij in het document');
  assert.equal(I.checkStatement({ ...verklaring(), proof: undefined }, ACTOR).error, 'no_proof');
  assert.equal(I.checkStatement(verklaring({ ballast: 'x'.repeat(5000) }), ACTOR).error, 'too_large');
});

// ── Door de route en de actor heen ───────────────────────────────

test('POST zet de verklaring op de actor, DELETE haalt hem weg, en alleen de eigenaar', async (t) => {
  const express = (await import('express')).default;
  const routes = (await import('../src/routes/activitypub.js')).default;
  const AP = (await import('../src/services/ActivityPubService.js')).default;

  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary, profile_links) VALUES (?,?,?,?,1,1,?)')
    .run('s1', 'kind', 'Kind', 'u1', JSON.stringify([{ platform: 'Website', url: 'https://kind.example' }]));
  const bearer = 'test-token-' + 'c'.repeat(24);
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(bearer).digest('base64url'), 'c', 'u1', 'kind', 'read write');

  const app = express(); app.use(routes);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/ap/users/kind/identityProofs`;
  const post = (body, auth = true) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await post(verklaring(), false)).status, 403, 'zonder token');
  const fout = await post(verklaring({}, { actor: 'https://elders.example/users/x' }));
  assert.equal(fout.status, 422);
  assert.equal((await fout.json()).error, 'alsoKnownAs_is_not_this_actor');

  const goed = await post(verklaring());
  assert.equal(goed.status, 201);

  const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
  const actor = AP.buildActor('https://test.example', site());
  assert.equal(actor.endpoints['shaer:identityProofs'], 'https://test.example/ap/users/kind/identityProofs');
  assert.equal(actor.attachment[0].type, 'PropertyValue', 'de profiellink blijft vooraan staan');
  const bewijs = actor.attachment.find((a) => a.type === 'VerifiableIdentityStatement');
  assert.ok(bewijs, 'de verklaring staat onder attachment');
  assert.equal(I.checkStatement(bewijs, actor.id).ok, true, 'en is daar nog steeds na te lopen');

  // Dezelfde sleutel opnieuw vervangt, verdubbelt niet.
  assert.equal((await post(verklaring())).status, 201);
  assert.equal(JSON.parse(site().identity_proofs).length, 1);

  const weg = await fetch(`${url}?subject=${encodeURIComponent(W3C_DID)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(weg.status, 204);
  assert.equal(site().identity_proofs, null);
  assert.ok(!AP.buildActor('https://test.example', site()).attachment.some((a) => a.type === 'VerifiableIdentityStatement'));
});
