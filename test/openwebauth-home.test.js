// OpenWebAuth, de HOME-kant: onze gebruiker bewijst zich bij een andere site.
//
// De rollen zijn hier omgedraaid, en daarmee de gevaren. Als target riskeer je
// dat je iemand binnenlaat die je niet kent; als home riskeer je dat je je
// BEZOEKER ergens heen stuurt waar hij niet heen wilde, of dat je namens hem
// tekent met een sleutel die niet van hem is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://thuis.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const OWA = await import('../src/services/OpenWebAuthService.js');

// ── bdest heen en terug ───────────────────────────────────────────────────

test('bdest is hex, en alleen hex', () => {
  const url = 'https://doel.example/een-bericht?a=1';
  assert.equal(OWA.fromBdest(OWA.toBdest(url)).href, url);
});

test('rommel in bdest levert niets op', () => {
  // Dit is de eerste zeef: wat hier doorheen komt bepaalt straks waar we de
  // bezoeker naartoe sturen.
  for (const rot of ['', null, 'geenhex', 'abc', '6z6z', Buffer.from('javascript:alert(1)').toString('hex')]) {
    assert.equal(OWA.fromBdest(rot), null, JSON.stringify(rot));
  }
});

// ── open redirect, de kant van de home instance ───────────────────────────

test('een token-endpoint op een ANDERE origin wordt geweigerd', async () => {
  // De aanval: de doelsite (of iemand die zich ervoor uitgeeft) wijst ons naar
  // een endpoint elders. De FEP: alleen doorsturen als het endpoint dezelfde
  // origin heeft als bdest.
  const nep = async () => ({
    ok: true,
    json: async () => ({ links: [{ rel: OWA.REL_TOKEN, href: 'https://ergens-anders.example/owa/token' }] }),
  });
  const r = await OWA.discoverTokenEndpoint('https://doel.example/pagina', { fetchImpl: nep });
  assert.equal(r, null);
});

test('en zonder ontdekking sturen we nergens heen', async () => {
  // Belangrijk: geen endpoint betekent NIET "stuur hem dan maar gewoon terug".
  // Dat zou /magic tot doorgeefluik maken. De route geeft hier een 502.
  const leeg = async () => ({ ok: true, json: async () => ({ links: [] }) });
  assert.equal(await OWA.discoverTokenEndpoint('https://doel.example/p', { fetchImpl: leeg }), null);
  const stuk = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await OWA.discoverTokenEndpoint('https://doel.example/p', { fetchImpl: stuk }), null);
});

test('op dezelfde origin is het goed', async () => {
  const nep = async () => ({
    ok: true,
    json: async () => ({ links: [{ rel: OWA.REL_TOKEN, href: 'https://doel.example/owa/token' }] }),
  });
  const r = await OWA.discoverTokenEndpoint('https://doel.example/een-bericht', { fetchImpl: nep });
  assert.equal(r, 'https://doel.example/owa/token');
});

// ── de ondertekende aanvraag ──────────────────────────────────────────────

test('de aanvraag tekent zoals de FEP het voorschrijft', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });

  let gezien = null;
  const nep = async (url, opts) => {
    gezien = { url, headers: opts.headers };
    // Doe alsof wij de doelsite zijn: geef een token terug voor deze sleutel.
    return { ok: true, json: async () => ({ success: true, encrypted_token: OWA.encryptTokenFor('proef-token-abcdefghijklmnop', pub) }) };
  };

  const enc = await OWA.requestToken('https://doel.example/owa/token', {
    keyId: 'https://thuis.example/ap/users/kid#main-key', privatePem: priv, fetchImpl: nep,
  });

  // Authorization, NIET Signature -- dat is precies waar echte clients op vallen.
  assert.match(gezien.headers.Authorization, /^Signature keyId="https:\/\/thuis\.example\/ap\/users\/kid#main-key"/);
  assert.ok(gezien.headers['X-Open-Web-Auth'], 'de entropie-header uit de FEP staat erop');
  assert.match(gezien.headers.Authorization, /headers="\(request-target\) host date x-open-web-auth"/,
    'en hij wordt MEE-ondertekend, anders voegt hij niets toe');

  // En de handtekening klopt ook echt.
  const p = Object.fromEntries([...gezien.headers.Authorization.matchAll(/([a-zA-Z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const signingString = [
    '(request-target): get /owa/token',
    'host: doel.example',
    `date: ${gezien.headers.Date}`,
    `x-open-web-auth: ${gezien.headers['X-Open-Web-Auth']}`,
  ].join('\n');
  assert.ok(crypto.verify('sha256', Buffer.from(signingString), pub, Buffer.from(p.signature, 'base64')),
    'de handtekening dekt precies wat hij zegt te dekken');

  // En het token komt er heelhuids uit.
  assert.equal(OWA.decryptToken(enc, priv), 'proef-token-abcdefghijklmnop');
});

test('een mislukt antwoord levert geen token op', async () => {
  const priv = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const antwoord of [
    { ok: false, json: async () => ({}) },
    { ok: true, json: async () => ({ success: false }) },
    { ok: true, json: async () => ({ success: true }) },              // geen token erbij
  ]) {
    const r = await OWA.requestToken('https://doel.example/owa/token', {
      keyId: 'k', privatePem: priv, fetchImpl: async () => antwoord,
    });
    assert.equal(r, null);
  }
});

test('onzin uit de ontsleuteling gaat niet door voor een token', () => {
  // PKCS#1 v1.5 geeft bij een verkeerde sleutel geen fout maar afgeleide bytes
  // (implicit rejection). Die mogen hier niet als token de wereld in gaan.
  const a = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const enc = OWA.encryptTokenFor('een-net-token', a.publicKey.export({ type: 'spki', format: 'pem' }));
  const uit = OWA.decryptToken(enc, b.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(uit, null, 'andermans sleutel levert geen token, ook niet stiekem');
});

// ── de twee kanten samen ──────────────────────────────────────────────────

test('twee Klonkts: de home-kant en de target-kant passen op elkaar', async () => {
  // De hele reden dat beide helften bestaan. Hier speelt één proces allebei de
  // rollen: de home tekent en ontsleutelt, de target verifieert en versleutelt.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const ACTOR = 'https://thuis.example/ap/users/kid';

  // TARGET: geeft een token uit voor deze actor en versleutelt het met zijn sleutel.
  const token = OWA.issueToken(ACTOR);
  const enc = OWA.encryptTokenFor(token, pub);

  // HOME: ontsleutelt het met zijn eigen helft.
  const terug = OWA.decryptToken(enc, priv);
  assert.equal(terug, token);

  // TARGET: wisselt het in en weet nu wie er binnenkomt.
  assert.equal(OWA.redeemToken(terug), ACTOR);
  assert.equal(OWA.redeemToken(terug), null, 'en daarna is hij op');
});
