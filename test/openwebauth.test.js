// OpenWebAuth (FEP-61cf), de target-kant.
//
// Dit is een AUTHENTICATIEPAD, dus de toetsen hier staan scherper dan elders:
// niet alleen "werkt de gelukkige route", maar met name de drie aanvallen die de
// FEP zelf beschrijft -- impersonatie via ?zid=, open redirect via het
// ontdekte endpoint, en tokens die blijven liggen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const OWA = await import('../src/services/OpenWebAuthService.js');

const ACTOR = 'https://elders.example/users/mee';
const ANDER = 'https://elders.example/users/iemand';

// ── tokens ────────────────────────────────────────────────────────────────

test('een token wijst naar de actor die hem kreeg', () => {
  const t = OWA.issueToken(ACTOR);
  assert.equal(OWA.redeemToken(t), ACTOR);
});

test('een token werkt precies ÉÉN keer', () => {
  // Anders is een token dat ergens in een log of een history-item blijft hangen
  // een sleutel die blijft werken.
  const t = OWA.issueToken(ACTOR);
  assert.equal(OWA.redeemToken(t), ACTOR);
  assert.equal(OWA.redeemToken(t), null, 'de tweede keer is niets meer waard');
});

test('een verzonnen token levert niemand op', () => {
  assert.equal(OWA.redeemToken('zomaar-wat'), null);
  assert.equal(OWA.redeemToken(''), null);
  assert.equal(OWA.redeemToken(null), null);
});

test('een token verloopt, en verlopen aanbieden verbrandt hem ook', () => {
  const t = OWA.issueToken(ACTOR, Date.now() - (OWA.TOKEN_TTL_MS + 1000));
  assert.equal(OWA.redeemToken(t), null, 'te oud');
  // En hij is weg: opnieuw aanbieden binnen de tijd kan niet alsnog lukken.
  const rij = db.prepare('SELECT 1 FROM owa_tokens WHERE token = ?').get(t);
  assert.equal(rij, undefined, 'een aangeboden token blijft niet liggen');
});

test('oude tokens worden opgeruimd (de DoS uit de FEP)', () => {
  db.prepare('DELETE FROM owa_tokens').run();
  const oud = Date.now() - (OWA.TOKEN_TTL_MS + 60_000);
  for (let i = 0; i < 5; i++) {
    db.prepare('INSERT INTO owa_tokens (token, actor_uri, created_at) VALUES (?,?,?)')
      .run('oud-' + i, ACTOR, oud);
  }
  OWA.issueToken(ACTOR);            // elke uitgifte veegt
  const over = db.prepare('SELECT COUNT(*) AS n FROM owa_tokens').get().n;
  assert.equal(over, 1, 'alleen de verse blijft staan');
});

// ── versleuteling ─────────────────────────────────────────────────────────

test('het token is alleen leesbaar voor wie de privésleutel heeft', () => {
  // De hele reden dat deze stap bestaat: de ondertekenaar bewijst dat hij de
  // actor BEHEERT, niet alleen dat hij zijn document kent.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const token = OWA.issueToken(ACTOR);
  const versleuteld = OWA.encryptTokenFor(token, pem);

  assert.ok(!versleuteld.includes('='), 'base64url zonder padding, zoals de FEP zegt');
  assert.ok(!/[+/]/.test(versleuteld), 'en URL-veilig');

  const terug = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(versleuteld.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  ).toString('utf8');
  assert.equal(terug, token);

  // Een ANDERE sleutel komt er niet bij -- maar LET OP HOE dat eruitziet, want
  // de voor de hand liggende toets (assert.throws) is hier fout.
  //
  // PKCS#1 v1.5 gooit bij een verkeerde sleutel geen fout: OpenSSL 3 doet aan
  // "implicit rejection" en geeft afgeleide onzin terug in plaats van te falen,
  // juist zodat een aanvaller niet aan het foutgedrag kan aflezen of zijn gok
  // klopte (Bleichenbacher/Marvin). Gemeten: 200 vreemde sleutels, 0 fouten,
  // 200 keer bytes -- en 0 keer het token.
  //
  // De eigenschap die telt is dus niet "het knalt" maar "er komt iets anders
  // uit". Wat de home instance daarna terugstuurt matcht geen enkel opgeslagen
  // token, en de inlog mislukt gewoon.
  const ruw = Buffer.from(versleuteld.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  for (let i = 0; i < 5; i++) {
    const vreemde = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    let uit = null;
    try {
      uit = crypto.privateDecrypt({ key: vreemde, padding: crypto.constants.RSA_PKCS1_PADDING }, ruw).toString('utf8');
    } catch { uit = null; }                     // een fout mag, maar is niet de regel
    assert.notEqual(uit, token, 'andermans sleutel levert nooit het token');
  }
});

// ── adressen lezen ────────────────────────────────────────────────────────

test('een adres mag op vier manieren geschreven worden', () => {
  for (const vorm of ['mee@elders.example', '@mee@elders.example', 'acct:mee@elders.example', '  @mee@elders.example  ']) {
    const h = OWA.parseHandle(vorm);
    assert.ok(h, vorm);
    assert.equal(h.acct, 'mee@elders.example');
  }
});

test('en onzin is geen adres', () => {
  for (const vorm of ['', null, 'geen-apenstaartje', 'twee@@apen', 'met/schuine@streep', 'a@b@c']) {
    assert.equal(OWA.parseHandle(vorm), null, JSON.stringify(vorm));
  }
});

// ── open redirect ─────────────────────────────────────────────────────────

test('een endpoint op een ANDERE host wordt geweigerd', async () => {
  // De aanval: een server antwoordt op webfinger met een redirect-endpoint dat
  // ergens anders wijst, en ons inlogformulier wordt een doorgeefluik.
  const nep = async () => ({
    ok: true,
    json: async () => ({ links: [{ rel: OWA.REL_REDIRECT, href: 'https://kwaadaardig.example/magic' }] }),
  });
  const r = await OWA.discoverRedirectEndpoint('mee@elders.example', { fetchImpl: nep });
  assert.equal(r, null, 'andere host dan het ingetypte adres → niet doen');
});

test('een endpoint op de eigen host is prima', async () => {
  const nep = async () => ({
    ok: true,
    json: async () => ({ links: [{ rel: OWA.REL_REDIRECT, href: 'https://elders.example/owa/hier' }] }),
  });
  const r = await OWA.discoverRedirectEndpoint('mee@elders.example', { fetchImpl: nep });
  assert.equal(r.endpoint, 'https://elders.example/owa/hier');
});

test('zonder webfinger-link vallen we terug op /magic, op dezelfde host', async () => {
  const nep = async () => ({ ok: false, json: async () => ({}) });
  const r = await OWA.discoverRedirectEndpoint('mee@elders.example', { fetchImpl: nep });
  assert.equal(r.endpoint, 'https://elders.example/magic', 'Hubzilla en (streams) doen het zo');
});

test('de redirect draagt owa=1 en een hex-bdest', () => {
  const terug = 'https://test.example/een-bericht';
  const url = new URL(OWA.buildRedirect('https://elders.example/magic', terug));
  assert.equal(url.searchParams.get('owa'), '1');
  const bdest = url.searchParams.get('bdest');
  assert.match(bdest, /^[0-9a-f]+$/i, 'hexadecimaal, zoals de FEP zegt');
  assert.equal(Buffer.from(bdest, 'hex').toString('utf8'), terug);
});

// ── wie is er binnen ──────────────────────────────────────────────────────

test('volgerschap is de vraag die fan_only stelt', () => {
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u-owa', 'u-owa', 'u@t', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s-owa', 'kid', 'kid', 'u-owa');
  db.prepare('INSERT INTO ap_followers (slug, actor_uri) VALUES (?,?)').run('kid', ACTOR);

  assert.equal(OWA.isFollowerOf('kid', ACTOR), true);
  assert.equal(OWA.isFollowerOf('kid', ANDER), false, 'een vreemde volgt niet');
  assert.equal(OWA.isFollowerOf('kid', null), false, 'en niemand al helemaal niet');
  assert.equal(OWA.isFollowerOf('andere-site', ACTOR), false, 'volgen doe je een SITE, niet de server');
});

test('een sessie zonder bewijs levert geen actor', () => {
  assert.equal(OWA.guestActor(null), null);
  assert.equal(OWA.guestActor({ session: {} }), null);
  assert.equal(OWA.guestActor({ session: { owa: {} } }), null);
  assert.equal(OWA.guestActor({ session: { owa: { actor: ACTOR } } }), ACTOR);
});

test('viewerFor zet het bewijs om in een besluitbare vorm', () => {
  const req = { session: { owa: { actor: ACTOR } } };
  const v = OWA.viewerFor(req, { slug: 'kid' });
  assert.equal(v.fediActor, ACTOR);
  assert.equal(v.isFollower, true);
  assert.equal(v.user, null, 'een gast is geen lokale gebruiker');
});
