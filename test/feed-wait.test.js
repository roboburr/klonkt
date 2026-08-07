// Wachten op nieuws, als uitbreiding van de inbox-lezing (shaer-n05).
//
// Geen tweede endpoint en geen seintje-formaat: dezelfde lezing, die desgevraagd
// even blijft hangen. Wat hier bewaakt wordt is de MERKSTEEN -- als die niet
// beweegt bij iets dat de inbox wel zou tonen, blijft een wachtende client
// slapen terwijl er nieuws is. Dat is erger dan niet wachten, want het lijkt te
// werken.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'buur', 'Buur', 'u1');
db.prepare('INSERT INTO posts (id, site_id, slug, author_id, title, content, status) VALUES (?,?,?,?,?,?,?)')
  .run('p1', 's1', 'mijn-post', 'u1', 'Post', '<p>x</p>', 'published');

let n = 0;
const nieuwePost = (slug = 'me') => db.prepare(
  "INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES (?,?,'https://r.test/u/a','<p>x</p>')",
).run(`https://r.test/n/${++n}`, slug);

test('een verse tijdlijnpost beweegt de merksteen', () => {
  const voor = AP.feedCursor('me');
  nieuwePost();
  assert.notEqual(AP.feedCursor('me'), voor);
});

test('en zo ook de andere drie poten van de inbox', () => {
  // De inbox voegt vier bronnen samen. Ontbreekt er een in de merksteen, dan
  // wordt een client niet wakker van precies dat soort nieuws.
  const bericht = () => db.prepare(
    "INSERT INTO ap_mentions (slug, object_uri, actor_uri, content) VALUES ('me',?, 'https://r.test/u/a','<p>hoi</p>')",
  ).run(`https://r.test/m/${++n}`);
  const antwoord = () => db.prepare(
    `INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, content)
     VALUES ('reply','p1',?, 'https://r.test/u/a','<p>hoi</p>')`,
  ).run(`https://r.test/r/${++n}`);
  const verstuurd = () => db.prepare(
    "INSERT INTO ap_outbox (id, site_slug, post_id, content) VALUES (?,'me','p1','<p>x</p>')",
  ).run(`o${++n}`);

  for (const [naam, doen] of [['bericht', bericht], ['antwoord', antwoord], ['verstuurd', verstuurd]]) {
    const voor = AP.feedCursor('me');
    doen();
    assert.notEqual(AP.feedCursor('me'), voor, `${naam} hoort de merksteen te bewegen`);
  }
});

test('een BEWERKING beweegt hem ook', () => {
  // De reden dat de merksteen niet meer op MAX(rowid) leunt. Een Update schrijft
  // dezelfde rij, dus de rowid bleef staan en een wachtende client sliep door.
  db.prepare("INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES ('bw','me','https://r.test/u/a','<p>oud</p>')").run();
  const voor = AP.feedCursor('me');
  db.prepare("UPDATE ap_timeline SET content = '<p>nieuw</p>' WHERE id = 'bw'").run();
  assert.notEqual(AP.feedCursor('me'), voor);
});

test('en een VERWIJDERING, ook als het niet de laatste is', () => {
  db.prepare("INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES ('later','me','https://r.test/u/a','<p>x</p>')").run();
  const voor = AP.feedCursor('me');
  db.prepare("DELETE FROM ap_timeline WHERE id = 'bw'").run();
  assert.notEqual(AP.feedCursor('me'), voor, 'anders blijft een verwijderde post staan tot je toevallig ververst');
});

test('maar een LIKE of BOOST van jezelf niet', () => {
  // De val waar dit bijna in liep: een like schrijft ap_timeline.liked en een 🔁
  // schrijft .boosted. Zonder de UPDATE OF-kolomlijst zou je eigen like het
  // bericht als BEWERKT merken en elke wachtende client wekken.
  const voor = AP.feedCursor('me');
  db.prepare("UPDATE ap_timeline SET liked = 1 WHERE id = 'later'").run();
  db.prepare("UPDATE ap_timeline SET boosted = 1 WHERE id = 'later'").run();
  db.prepare("UPDATE ap_interactions SET acted_like = 1 WHERE post_id = 'p1'").run();
  assert.equal(AP.feedCursor('me'), voor, 'je eigen reactie is geen nieuws');
});

test('een INSERT OR IGNORE die niets doet beweegt hem niet', () => {
  const voor = AP.feedCursor('me');
  db.prepare("INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, content) VALUES ('later','me','https://r.test/u/a','<p>x</p>')").run();
  assert.equal(AP.feedCursor('me'), voor);
});

test('de teller loopt nooit achteruit', () => {
  // Met MAX(rowid) zakte hij terug zodra de nieuwste rij verdween, en dan denkt
  // een client dat er niets gebeurd is.
  const hoog = parseInt(AP.feedCursor('me'), 10);
  db.prepare('DELETE FROM ap_timeline WHERE slug = ?').run('me');
  assert.ok(parseInt(AP.feedCursor('me'), 10) >= hoog);
});

test('en hij vertelt WAT er veranderd is', () => {
  // Dit is wat een revisieteller niet kan en deze tabel gratis meegeeft: de
  // "bewerkt"-markering hoeft er later geen eigen bouwsel voor te worden.
  const stand = (uri) => (AP.feedChangesSince('me', 0).find((r) => r.object_uri === uri) || {}).kind;

  db.prepare("INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES ('vers','me','https://r.test/u/a','<p>x</p>')").run();
  assert.equal(stand('vers'), 'new');

  db.prepare("UPDATE ap_timeline SET content = '<p>anders</p>' WHERE id = 'vers'").run();
  assert.equal(stand('vers'), 'updated');

  db.prepare("DELETE FROM ap_timeline WHERE id = 'vers'").run();
  assert.equal(stand('vers'), 'deleted');
});

test('het is een STAND en geen logboek: bewerkt-en-toen-weg leest als weg', () => {
  // Een rij per bericht, niet een rij per gebeurtenis. Vijf keer bewerken blijft
  // één rij, en dat is waarom er niets te snoeien valt. Mijn eerste test ging uit
  // van een log en viel daar terecht over.
  const alles = AP.feedChangesSince('me', 0);
  const perUri = new Set(alles.map((r) => r.object_uri));
  assert.equal(alles.length, perUri.size, 'geen enkel bericht komt twee keer voor');
});

test('nieuws van een ANDER account laat je merksteen staan', () => {
  const voor = AP.feedCursor('me');
  nieuwePost('buur');
  assert.equal(AP.feedCursor('me'), voor, 'anders wordt iedereen wakker van andermans post');
});

test('is er al iets veranderd, dan wordt er niet gewacht', async () => {
  const oud = AP.feedCursor('me');
  nieuwePost();
  const begin = Date.now();
  const uit = await AP.waitForFeedChange('me', { since: oud, waitMs: 5000, tickMs: 20 });
  assert.equal(uit.changed, true);
  assert.equal(uit.waited, false, 'meteen antwoorden, niet eerst de tijd volmaken');
  assert.ok(Date.now() - begin < 500);
});

test('zonder sinds is het gewoon de huidige stand', async () => {
  const uit = await AP.waitForFeedChange('me', { waitMs: 5000, tickMs: 20 });
  assert.equal(uit.changed, false);
  assert.equal(uit.waited, false);
  assert.equal(uit.cursor, AP.feedCursor('me'));
});

test('wachten wordt afgebroken zodra er iets binnenkomt', async () => {
  const oud = AP.feedCursor('me');
  const begin = Date.now();
  setTimeout(() => nieuwePost(), 60);
  const uit = await AP.waitForFeedChange('me', { since: oud, waitMs: 4000, tickMs: 20 });
  assert.equal(uit.changed, true);
  assert.equal(uit.waited, true);
  assert.ok(Date.now() - begin < 2000, 'hij hoort wakker te worden, niet de tijd vol te maken');
  assert.notEqual(uit.cursor, oud, 'en de nieuwe merksteen komt mee');
});

test('gebeurt er niets, dan komt hij leeg terug binnen de tijd', async () => {
  const oud = AP.feedCursor('me');
  const begin = Date.now();
  const uit = await AP.waitForFeedChange('me', { since: oud, waitMs: 150, tickMs: 20 });
  assert.equal(uit.changed, false);
  assert.equal(uit.waited, true);
  assert.equal(uit.cursor, oud);
  assert.ok(Date.now() - begin >= 100, 'hij hoort wel echt gewacht te hebben');
  assert.ok(Date.now() - begin < 3000, 'en niet langer dan gevraagd');
});

test('ophangen breekt het wachten af', async () => {
  // Zonder dit blijft er een timer draaien voor een client die er niet meer is.
  const oud = AP.feedCursor('me');
  const ac = new AbortController();
  const begin = Date.now();
  setTimeout(() => ac.abort(), 60);
  const uit = await AP.waitForFeedChange('me', { since: oud, waitMs: 4000, tickMs: 20, signal: ac.signal });
  assert.equal(uit.changed, false);
  assert.ok(Date.now() - begin < 2000);
});

test('meer dan vier wachters tegelijk: de rest krijgt meteen antwoord', async () => {
  // Een client met een kapotte herverbind-lus mag de instance niet vastzetten.
  // De overtolligen krijgen geen fout maar gewoon de huidige stand.
  const oud = AP.feedCursor('me');
  const lopend = [];
  for (let i = 0; i < 4; i++) lopend.push(AP.waitForFeedChange('me', { since: oud, waitMs: 300, tickMs: 20 }));
  await new Promise((r) => setTimeout(r, 30));
  const vijfde = await AP.waitForFeedChange('me', { since: oud, waitMs: 4000, tickMs: 20 });
  assert.equal(vijfde.busy, true);
  assert.equal(vijfde.waited, false);
  await Promise.all(lopend);
  // En daarna is er weer plek: de teller moet netjes teruglopen.
  const daarna = await AP.waitForFeedChange('me', { since: oud, waitMs: 60, tickMs: 20 });
  assert.notEqual(daarna.busy, true);
});
