// De wardmodus: een besloten Klonkt waarvan alleen het profiel openbaar is
// (Robins ontwerp, 30-9; middleware/ward-profile.js).
//
// Wat hier bewaakt wordt, en waarom elk een eigen zaak is:
//   1. AFGELEID VAN DE GUARDIANS. Aan zodra een guardianship geaccepteerd is,
//      niet bij een voorstel; uit zodra de set leeg is (emancipatie). Geen
//      schakelaar die ernaast kan gaan liggen.
//   2. STANDAARD DICHT. Een bezoeker ziet het profiel en verder niets; een
//      pagina gaat terug naar het profiel, al het andere is 404, en een POST
//      bereikt zijn handler niet.
//   3. WAT OPEN MOET BLIJVEN, blijft open: inloggen, de audiostream (die bewaakt
//      elk bestand zelf), de bestanden van de pagina zelf.
//   4. DE WARD EN HET BEHEER zien de hele site.
//   5. DE PROFIELLINKS staan bij het account, en Appearance wist ze niet meer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.MEDIA_PATH = path.join(os.tmpdir(), 'klonkt-test-media');

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const { resolveSite } = await import('../src/middleware/site.js');
const { wardProfileGate } = await import('../src/middleware/ward-profile.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('kid', 'kid', 'k@t', 'x', 'user');
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('fan', 'fan', 'f@t', 'x', 'user');
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('baas', 'baas', 'b@t', 'x', 'god');
db.prepare(`INSERT INTO sites (id, slug, title, description, owner_id, is_primary, is_public, profile_links)
            VALUES (?,?,?,?,?,1,1,?)`)
  .run('s1', 'kid', 'Robin', 'Ik maak muziek met mijn gitaar', 'kid',
    JSON.stringify([{ platform: 'instagram', url: 'https://instagram.com/robin' }]));

const GUARDIAN = 'https://elders.test/u/oma';
const koppel = (status) => db.prepare("INSERT OR REPLACE INTO ap_guardianships (slug, role, other_uri, status) VALUES ('kid','ward',?,?)").run(GUARDIAN, status);
const ontkoppel = () => db.prepare("DELETE FROM ap_guardianships WHERE slug = 'kid'").run();

// Een Klonkt in het klein: de echte siteresolver en de echte poort, en daarachter
// routes die alleen zeggen dat ze bereikt zijn.
let sessie = {};
const bereikt = [];
const express = (await import('express')).default;
const app = express();
app.use((req, res, next) => { req.session = sessie; next(); });
app.use(resolveSite);
app.use(wardProfileGate);
const hier = (naam) => (req, res) => { bereikt.push(naam); res.send('ROUTE:' + naam); };
app.get('/', hier('feed'));
app.get('/auth/login', hier('login'));
app.get('/audio/stream/:f', hier('stream'));
app.get('/manifest.webmanifest', hier('manifest'));
app.get('/search', hier('search'));
app.get('/feed.xml', hier('rss'));
app.post('/:slug/comment', hier('comment'));
app.get('/:slug', hier('post'));
const server = app.listen(0);
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const vraag = (pad, opts = {}) => fetch(base + pad, { redirect: 'manual', headers: { Accept: 'text/html', ...(opts.headers || {}) }, ...opts });
const alsBezoeker = () => { sessie = {}; };
const als = (id, role) => { sessie = { user: { id, username: id, role } }; };

test('zonder guardians is het een gewone Klonkt', async () => {
  ontkoppel(); alsBezoeker();
  const r = await vraag('/');
  assert.equal(await r.text(), 'ROUTE:feed');
});

test('een voorstel is nog geen koppeling', async () => {
  ontkoppel(); koppel('offered'); alsBezoeker();
  assert.equal(await (await vraag('/')).text(), 'ROUTE:feed', 'pas een GEACCEPTEERDE guardianship zet de site dicht');
});

test('gekoppeld ziet een bezoeker alleen het profiel', async () => {
  ontkoppel(); koppel('accepted'); alsBezoeker();
  const r = await vraag('/');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!html.includes('ROUTE:feed'), 'de stroom komt er niet aan te pas');
  assert.ok(html.includes('Robin'), 'de naam');
  assert.ok(html.includes('Ik maak muziek met mijn gitaar'), 'de bio');
  assert.ok(html.includes('https://instagram.com/robin'), 'de links');
  assert.ok(html.includes('@kid@test.example'), 'de handle, om te volgen');
});

test('elke andere pagina gaat terug naar het profiel', async () => {
  koppel('accepted'); alsBezoeker();
  for (const pad of ['/geheim', '/search?q=gitaar']) {
    const r = await vraag(pad);
    assert.equal(r.status, 302, pad);
    assert.equal(r.headers.get('location'), '/', pad);
  }
});

test('wat geen pagina is, bestaat niet voor een bezoeker', async () => {
  koppel('accepted'); alsBezoeker(); bereikt.length = 0;
  const rss = await vraag('/feed.xml', { headers: { Accept: 'application/rss+xml' } });
  assert.equal(rss.status, 404);
  const post = await vraag('/geheim/comment', { method: 'POST' });
  assert.equal(post.status, 404);
  assert.deepEqual(bereikt, [], 'geen enkele handler bereikt, ook de reactie niet');
});

test('een htmx-navigatie gaat echt naar het profiel, niet als brokstuk', async () => {
  koppel('accepted'); alsBezoeker();
  const r = await vraag('/geheim', { headers: { 'HX-Request': 'true', Accept: '*/*' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('hx-redirect'), '/');
});

test('inloggen, de audiostream en de bestanden van de pagina blijven bereikbaar', async () => {
  koppel('accepted'); alsBezoeker();
  assert.equal(await (await vraag('/auth/login')).text(), 'ROUTE:login', 'de ward moet kunnen inloggen');
  assert.equal(await (await vraag('/audio/stream/zwaluwen.mp3')).text(), 'ROUTE:stream',
    'die bewaakt elk bestand zelf, en een geopende track moet speelbaar blijven op de fediverse');
  assert.equal(await (await vraag('/manifest.webmanifest')).text(), 'ROUTE:manifest');
});

test('de ward zelf en het beheer zien de hele site', async () => {
  koppel('accepted');
  als('kid', 'user');
  assert.equal(await (await vraag('/')).text(), 'ROUTE:feed', 'de eigenaar ziet zijn eigen Klonkt');
  assert.equal(await (await vraag('/geheim')).text(), 'ROUTE:post');
  als('baas', 'god');
  assert.equal(await (await vraag('/geheim')).text(), 'ROUTE:post');
});

test('een andere ingelogde gebruiker is gewoon een bezoeker', async () => {
  koppel('accepted'); als('fan', 'user');
  const r = await vraag('/geheim');
  assert.equal(r.status, 302, 'ingelogd zijn is niet hetzelfde als deze site mogen beheren');
});

test('emancipatie maakt er weer een gewone Klonkt van', async () => {
  koppel('accepted'); alsBezoeker();
  assert.equal((await vraag('/geheim')).status, 302);
  ontkoppel();
  assert.equal(await (await vraag('/geheim')).text(), 'ROUTE:post', 'geen guardians meer: alles weer open');
});

// ── De profiellinks: bij het account, en Appearance wist ze niet meer ────────
const accountRoutes = (await import('../src/routes/account.js')).default;
const sitesRoutes = (await import('../src/routes/admin-sites.js')).default;
const app2 = express();
app2.use(express.urlencoded({ extended: true }));
app2.use((req, res, next) => { req.session = sessie; res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get(); res.locals.siteUrlBase = ''; next(); });
app2.use('/account', accountRoutes);
app2.use('/admin/sites', sitesRoutes);
const server2 = app2.listen(0);
server2.unref();
const base2 = `http://127.0.0.1:${server2.address().port}`;
test.after(() => server2.close());
const links = () => JSON.parse(db.prepare("SELECT profile_links FROM sites WHERE id = 's1'").get().profile_links || '[]');

test('de accountpagina toont de links die er al zijn', async () => {
  // Gevonden bij het bekijken, niet door een toets: ownedSite haalde
  // profile_links niet op, dus de pagina toonde nul links -- en wie daarna
  // opsloeg, wiste ze. Het opslaan was getoetst, het tonen niet.
  als('kid', 'user');
  const html = await (await fetch(`${base2}/account`)).text();
  assert.ok(html.includes('value="https://instagram.com/robin"'), 'de bestaande link staat in het formulier');
});

test('de links bewerk je bij je account', async () => {
  als('kid', 'user');
  const body = new URLSearchParams();
  body.append('profile_link_platform[]', 'instagram'); body.append('profile_link_url[]', 'https://instagram.com/robin');
  body.append('profile_link_platform[]', 'youtube'); body.append('profile_link_url[]', 'https://youtube.com/@robin');
  const r = await fetch(`${base2}/account/links`, { method: 'POST', body, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.deepEqual(links().map((l) => l.platform), ['instagram', 'youtube']);
});

test('opslaan in Appearance wist de links niet meer', async () => {
  // Hier zat de val: de linkvelden staan niet meer op dat formulier, en zolang
  // die pagina profile_links bleef schrijven, wiste elke keer opslaan ze.
  als('baas', 'god');
  const voor = links();
  assert.ok(voor.length > 0);
  const body = new URLSearchParams({ title: 'Robin', description: 'Nu ook met drums', palette: 'klonkt' });
  await fetch(`${base2}/admin/sites/kid/save`, { method: 'POST', body, redirect: 'manual' });
  // Eerst bewijzen dat de opslag echt gebeurde. Een verkeerd pad geeft een 404,
  // en dan "wist" hij de links ook niet -- dan zegt deze toets niets.
  assert.equal(db.prepare("SELECT description FROM sites WHERE id = 's1'").get().description, 'Nu ook met drums',
    'Appearance heeft opgeslagen');
  assert.deepEqual(links(), voor, 'en de links staan er nog precies zo');
});
