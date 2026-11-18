// Wat de openbare lijsten van een vriendenpost en van een post voor alleen de
// mensen erin laten zien (shaer-8zew).
//
// Twee regels, en elke lijst hoort ze allebei te volgen:
//
//   1. DIRECT staat nergens. Niet op home, niet in het archief, niet in een
//      feed of de sitemap, niet bij zoeken, niet bij een auteur of een type,
//      niet als buur. De pagina zelf is een 404 voor iedereen behalve de
//      maker -- een volger of een ingelogde is geen deelnemer.
//   2. EEN VRIENDENPOST IS EEN TEASER: hij staat in de lijst, maar met alleen
//      wat de maker ervoor schreef (titel, excerpt, cover). Niets uit de
//      tekst: geen eerste regel als titel, geen eerste foto als tegel, geen
//      eerste alinea als teaser, geen zoekfragment. Wie hem mag lezen, ziet
//      hem gewoon heel.
//
// In-memory SQLite; posten via de C2S-outbox zoals de app dat doet.
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const VOLGERS = 'https://klonkt.test/ap/users/ik/followers';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }

const { postEntry, listingRow } = await import('../src/services/PostAccessService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'maker', 'u1@t', 'x', 'god');
// Een ingelogde die NIET de maker is: mag vriendenposts lezen, is geen deelnemer.
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u2', 'vriend', 'u2@t', 'x', 'user');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const token = 'test-token-lijsten-' + 'b'.repeat(24);
db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
  .run(crypto.createHash('sha256').update(token).digest('base64url'), 'shaer', 'u1', 'ik', 'c2s');

const express = (await import('express')).default;

// De app praat met de C2S-outbox.
const ap = express();
ap.use((await import('../src/routes/activitypub.js')).default);
const apServer = ap.listen(0);
await new Promise((r) => apServer.once('listening', r));
apServer.unref();

// De website, met de routers zoals server.js ze ophangt.
let wie = null; // null = anoniem
const web = express();
web.use((req, res, next) => {
  res.locals.site = site();
  res.locals.siteUrlBase = '';
  req.session = wie ? { user: wie } : {};
  next();
});
web.use('/search', (await import('../src/routes/search.js')).default);
web.use('/type', (await import('../src/routes/types.js')).default);
web.use('/users', (await import('../src/routes/users.js')).default);
web.use('/', (await import('../src/routes/feed.js')).default);
web.use('/', (await import('../src/routes/posts.js')).default);
const webServer = web.listen(0);
await new Promise((r) => webServer.once('listening', r));
webServer.unref();
after(() => { apServer.close(); webServer.close(); });

const WEB = `http://127.0.0.1:${webServer.address().port}`;
const haal = async (pad, als = null) => {
  wie = als;
  const r = await fetch(WEB + pad, { signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: await r.text() };
};
const MAKER = { id: 'u1', role: 'god', username: 'maker' };
const VRIEND = { id: 'u2', role: 'user', username: 'vriend' };

const plaats = async (note) => {
  const r = await fetch(`http://127.0.0.1:${apServer.address().port}/ap/users/ik/outbox`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/activity+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', ...note }),
  });
  assert.ok(r.status < 300, `outbox gaf ${r.status}`);
  const { id } = await r.json();
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
};
const zet = (rij) => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, excerpt, content, status, type, fan_only, ap_visibility, published_at)
              VALUES (@id, 's1', @slug, 'u1', @title, @excerpt, @content, 'published', 'post', @fan_only, @ap_visibility, @published_at)`)
    .run({ excerpt: '', ...rij });
  db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?,?,?,?)')
    .run(rij.content.replace(/<[^>]+>/g, ' '), rij.title, 'maker', rij.id);
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(rij.id);
};

// ── De posts ────────────────────────────────────────────────────────────────
const openbaar = await plaats({ content: '<p>Openbare banaan</p>', to: [PUBLIC] });
// Uit Shaer, titelloos: de standaard van de app.
const vriendShaer = await plaats({ content: '<p>Geheime kokosnoot voor vrienden</p>', to: [VOLGERS] });
// Titelloos met een foto in de tekst: de tegel zou die als beeld nemen.
const vriendFoto = zet({ id: 'vf', slug: 'vriend-foto', title: '', content: '<p>Lychee</p><p><img src="/media/vriend-foto.jpg"></p>',
  fan_only: 1, ap_visibility: 'friends', published_at: '2026-11-02T00:00:00Z' });
// Uit de editor, met titel en een eigen excerpt: dat is een echte teaser.
const vriendEditor = zet({ id: 've', slug: 'voor-de-fans', title: 'Voor de fans', excerpt: 'Een teaser die ik zelf schreef',
  content: '<p>Binnenwerk ananas</p>', fan_only: 1, ap_visibility: null, published_at: '2026-11-03T00:00:00Z' });
// Alleen voor de mensen erin. Via C2S wordt dat sinds shaer-tqc een bericht en
// geen post; zo'n rij komt nog uit een archiefimport of van daarvoor.
const direct = zet({ id: 'dd', slug: 'alleen-erin', title: 'Deelnemerstitel', content: '<p>Mango prive</p>',
  fan_only: 1, ap_visibility: 'direct', published_at: '2026-11-04T00:00:00Z' });

const GEHEIM = ['kokosnoot', 'Lychee', 'vriend-foto.jpg', 'ananas'];
const DIRECT = ['alleen-erin', 'Deelnemerstitel', 'Mango'];
const zonder = (body, woorden, waar) => { for (const w of woorden) assert.ok(!body.includes(w), `${waar}: "${w}" hoort er niet te staan`); };

test('de opzet: C2S zette de zichtbaarheid zoals verwacht', () => {
  assert.equal(openbaar.fan_only, 0);
  assert.equal(vriendShaer.fan_only, 1);
  assert.equal(vriendShaer.ap_visibility, 'friends');
  assert.equal(vriendShaer.title, '');
});

test('home, anoniem: vriendenposts als teaser zonder inhoud, direct nergens', async () => {
  const { status, body } = await haal('/');
  assert.equal(status, 200);
  assert.ok(body.includes('Openbare banaan'));
  assert.ok(body.includes('/' + vriendShaer.slug), 'de vriendenpost staat er wel');
  assert.ok(body.includes('/voor-de-fans') && body.includes('Voor de fans'), 'met zijn eigen titel');
  assert.ok(body.includes('Een teaser die ik zelf schreef'), 'en zijn eigen excerpt');
  assert.ok(body.includes('🔒'), 'een titelloze heet naar zijn poort');
  zonder(body, GEHEIM, 'home');
  zonder(body, DIRECT, 'home');
});

test('home, verder bladeren (?append=1) volgt dezelfde regels', async () => {
  const { body } = await haal('/?append=1');
  zonder(body, GEHEIM, 'append');
  zonder(body, DIRECT, 'append');
});

test('home, ingelogd: vriendenposts heel, direct nog steeds niet -- ook niet voor de maker', async () => {
  const vriend = await haal('/', VRIEND);
  assert.ok(vriend.body.includes('kokosnoot') && vriend.body.includes('vriend-foto.jpg'));
  zonder(vriend.body, DIRECT, 'home als vriend');
  const maker = await haal('/', MAKER);
  zonder(maker.body, DIRECT, 'home als maker');
});

test('zoeken: vriendenposts alleen voor wie ze mag lezen, direct nooit', async () => {
  // De zoekpagina herhaalt de zoekterm zelf, dus kijken we naar wat een
  // TREFFER is: een link naar de post, een fragment, en de woorden eromheen.
  const treffers = ['/' + vriendShaer.slug, '/vriend-foto', '/voor-de-fans', 'class="sr-item-snippet"', 'Geheime', 'Binnenwerk'];
  for (const q of ['kokosnoot', 'ananas', 'Lychee']) {
    for (const pad of ['/search?q=', '/search/results?q=']) {
      const anoniem = await haal(pad + q);
      assert.equal(anoniem.status, 200, pad + q);
      zonder(anoniem.body, treffers, `${pad}${q} anoniem`);
    }
  }
  const vriend = await haal('/search?q=kokosnoot', VRIEND);
  assert.ok(vriend.body.includes('/' + vriendShaer.slug) && vriend.body.includes('class="sr-item-snippet"'), 'een vriend vindt hem wel');
  for (const als of [null, VRIEND, MAKER]) {
    const r = await haal('/search?q=Mango', als);
    zonder(r.body, ['/alleen-erin', 'Deelnemerstitel', 'class="sr-item-snippet"'], `zoeken als ${als ? als.username : 'anoniem'}`);
  }
  // Tegenproef: de openbare post wordt anoniem wel gevonden.
  const pub = await haal('/search?q=banaan');
  assert.ok(pub.body.includes('/' + openbaar.slug) && pub.body.includes('class="sr-item-snippet"'));
});

test('feeds en sitemap: geen direct; een vriendenpost alleen met titel en eigen excerpt', async () => {
  for (const pad of ['/feed.xml', '/atom.xml', '/sitemap.xml']) {
    const { status, body } = await haal(pad);
    assert.equal(status, 200, pad);
    zonder(body, DIRECT, pad);
    zonder(body, GEHEIM, pad);
  }
  const rss = (await haal('/feed.xml')).body;
  assert.ok(rss.includes('/voor-de-fans') && rss.includes('Een teaser die ik zelf schreef'));
});

test('archief, auteur en type: geen direct', async () => {
  for (const pad of ['/archive', '/users/maker', '/type/post']) {
    const { status, body } = await haal(pad);
    assert.equal(status, 200, pad);
    zonder(body, DIRECT, pad);
    zonder(body, GEHEIM, pad);
  }
  const archief = (await haal('/archive')).body;
  assert.ok(archief.includes('/voor-de-fans'), 'een vriendenpost staat wel in het archief');
});

test('de pagina van een directe post: 404, behalve voor de maker', async () => {
  assert.equal((await haal('/alleen-erin')).status, 404, 'anoniem');
  assert.equal((await haal('/alleen-erin', VRIEND)).status, 404, 'een ingelogde is geen deelnemer');
  const maker = await haal('/alleen-erin', MAKER);
  assert.equal(maker.status, 200, 'de maker ziet zijn eigen werk');
  assert.ok(maker.body.includes('Mango'));
});

test('een berichtpagina noemt de directe post niet als buur of als verwant', async () => {
  // De directe post is de nieuwste; de editorpost zou hem als "nieuwer" tonen.
  const { status, body } = await haal('/voor-de-fans', VRIEND);
  assert.equal(status, 200);
  zonder(body, DIRECT, 'buren');
  const pub = await haal('/' + openbaar.slug);
  zonder(pub.body, DIRECT, 'buren openbaar');
});

test('een vriendenpost achter de poort laat zijn tekst niet zien', async () => {
  const { status, body } = await haal('/' + vriendShaer.slug);
  assert.equal(status, 200);
  zonder(body, ['kokosnoot'], 'fan-poort');
});

test('postEntry: de teaser van een vriendenpost is alleen het eigen excerpt', () => {
  const anoniem = { user: null, isFollower: false };
  assert.equal(postEntry(vriendShaer, anoniem).teaser, null, 'geen eerste alinea uit de tekst');
  assert.equal(postEntry(vriendEditor, anoniem).teaser, 'Een teaser die ik zelf schreef');
  assert.equal(postEntry(vriendEditor, anoniem).content_html, null);
  // De betaalmuur houdt zijn eerste alinea: dat is daar het product.
  assert.equal(postEntry({ ...openbaar, paid: 1, content: '<p>Eerste</p><p>Tweede</p>' }, anoniem).teaser, 'Eerste');
  assert.equal(postEntry(direct, { user: { id: 'u2', role: 'user' }, isFollower: true }).access, 'forbidden');
});

test('listingRow geeft een vergrendelde rij geen inhoud en geen tags mee', () => {
  const anoniem = { user: null, isFollower: false };
  const r = listingRow({ ...vriendFoto, tags: '["geheim"]' }, anoniem);
  assert.equal(r.locked, true);
  assert.equal(r.content, '');
  assert.equal(r.tags, null);
  assert.equal(r.title, '');
  assert.equal(listingRow(vriendFoto, { user: { id: 'u2' } }), vriendFoto, 'wie mag lezen krijgt de rij zoals hij is');
  assert.equal(listingRow(openbaar, anoniem), openbaar);
});
