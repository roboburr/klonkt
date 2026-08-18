// OpenWebAuth over HTTP: de vindbaarheid, de poort van het token-endpoint, en
// de impersonatie-verdediging.
//
// Die laatste is de belangrijkste toets in dit bestand. De FEP beschrijft hem
// zo: Mallory maakt een link naar ONZE site met ?zid=bob@elders, klikt hem zelf,
// en komt terug met een token dat MALLORY zegt. Wie `zid` gelooft in plaats van
// het ingewisselde `owt`, laat Mallory als Bob binnen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const OWA = await import('../src/services/OpenWebAuthService.js');
const apRoutes = (await import('../src/routes/activitypub.js')).default;
const owaMod = await import('../src/routes/openwebauth.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary, created_at) VALUES (?,?,?,?,1,?)')
  .run('s1', 'kid', 'kid', 'u1', '2026-01-01 00:00:00');

const ACTOR = 'https://elders.example/users/mee';
const SLACHTOFFER = 'https://elders.example/users/bob';

// Eén app met een sessie-nep: we willen hier de middleware toetsen, niet
// express-session.
const app = express();
app.use((req, _res, next) => { req.session = app.locals.sessie; next(); });
app.use(apRoutes);
app.use(owaMod.default);
app.use(owaMod.owaMiddleware);
app.get('/een-bericht', (req, res) => res.json({ owa: (req.session && req.session.owa) || null }));

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
test.after(() => server.close());

const haal = (pad, opts) => fetch(`http://127.0.0.1:${port}${pad}`, { redirect: 'manual', ...opts });

// ── vindbaarheid ──────────────────────────────────────────────────────────

test('de wortel wijst een home instance naar ons token-endpoint', async () => {
  const r = await haal('/.well-known/webfinger?resource=' + encodeURIComponent('https://test.example/'));
  assert.equal(r.status, 200);
  const jrd = await r.json();
  const link = jrd.links.find((l) => l.rel === 'http://purl.org/openwebauth/v1');
  assert.ok(link, 'de rel uit de FEP staat erin');
  assert.equal(link.href, 'https://test.example/owa/token');
});

test('en een ACTOR-uri blijft een 400, zoals eerder besloten', async () => {
  // Dit is geen detail: test/webfinger-bare-host.test.js legt het vast, en de
  // wortel-uitzondering mocht die keuze niet stiekem omdraaien.
  const r = await haal('/.well-known/webfinger?resource=' + encodeURIComponent('https://test.example/ap/users/kid'));
  assert.equal(r.status, 400);
});

test('een wortel van een ANDERE host is niet van ons', async () => {
  const r = await haal('/.well-known/webfinger?resource=' + encodeURIComponent('https://ergens-anders.example/'));
  assert.equal(r.status, 400);
});

// ── het token-endpoint ────────────────────────────────────────────────────

test('zonder handtekening geen token', async () => {
  // De hele waarde van dit endpoint zit in de handtekening: wie hem niet zet,
  // bewijst niets en krijgt niets.
  for (const method of ['GET', 'POST']) {
    const r = await haal('/owa/token', { method });
    assert.equal(r.status, 401, method);
    assert.deepEqual(await r.json(), { success: false });
  }
});

test('een verzonnen handtekening ook niet', async () => {
  const r = await haal('/owa/token', {
    headers: { signature: 'keyId="https://elders.example/users/mee#main-key",signature="bm9wZQ=="' },
  });
  assert.equal(r.status, 401);
});

// ── impersonatie ──────────────────────────────────────────────────────────

test('?owt= bepaalt wie je bent', async () => {
  app.locals.sessie = {};
  const t = OWA.issueToken(ACTOR);
  const r = await haal('/een-bericht?owt=' + encodeURIComponent(t));
  assert.equal(r.status, 302, 'het token wordt uit de URL gehaald');
  assert.equal(r.headers.get('location'), '/een-bericht', 'en laat niets achter in de adresbalk');
  assert.equal(app.locals.sessie.owa.actor, ACTOR);
});

test('?zid= bepaalt NIETS -- dit is de impersonatie-aanval uit de FEP', async () => {
  app.locals.sessie = {};
  // Mallory wijst met zid naar Bob. Er mag hier geen identiteit uit ontstaan.
  const r = await haal('/een-bericht?zid=' + encodeURIComponent('bob@elders.example'));
  assert.ok(r.status === 302 || r.status === 200, 'hooguit een doorverwijzing');
  assert.equal(app.locals.sessie.owa, undefined, 'zid logt niemand in');
});

test('en zid naast een geldig owt verandert de uitkomst niet', async () => {
  app.locals.sessie = {};
  const t = OWA.issueToken(ACTOR);                       // dit is Mallory's eigen token
  const r = await haal(`/een-bericht?owt=${encodeURIComponent(t)}&zid=${encodeURIComponent('bob@elders.example')}`);
  assert.equal(r.status, 302);
  assert.equal(app.locals.sessie.owa.actor, ACTOR, 'het token wint, niet de claim');
  assert.notEqual(app.locals.sessie.owa.actor, SLACHTOFFER);
  assert.equal(r.headers.get('location'), '/een-bericht', 'en zid gaat ook de URL uit');
});

test('een opgebruikt token logt niemand in', async () => {
  app.locals.sessie = {};
  const t = OWA.issueToken(ACTOR);
  await haal('/een-bericht?owt=' + encodeURIComponent(t));
  app.locals.sessie = {};
  await haal('/een-bericht?owt=' + encodeURIComponent(t));
  assert.equal(app.locals.sessie.owa, undefined, 'de tweede keer is hij niets waard');
});

// ── uitloggen ─────────────────────────────────────────────────────────────

test('uitloggen laat een lokale sessie met rust', async () => {
  app.locals.sessie = { owa: { actor: ACTOR }, user: { id: 'u1' } };
  await haal('/owa/logout');
  assert.equal(app.locals.sessie.owa, undefined, 'de gast is weg');
  assert.deepEqual(app.locals.sessie.user, { id: 'u1' }, 'de lokale gebruiker niet');
});
