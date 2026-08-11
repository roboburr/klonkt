// De outbox pagineert (Funkwhale, 11-8).
//
// Hun serializer weigerde onze outbox letterlijk met
//   {'first': ['This field is required.'], 'last': ['This field is required.']}
// AS2 eist die velden niet -- een collectie mag zijn items inline dragen -- maar
// bijna iedereen pagineert, en dit was de eerste CONCRETE reden die we hoorden
// waarom er niets van ons binnenkwam.
//
// De items blijven inline op de wortel: Shaer bouwt zijn feed daaruit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'dev', 'Dev', 'u1');
const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
const POST = { id: 'p1', slug: 'hallo', title: 'Hallo', content: '<p>x</p>', published_at: '2026-08-01T00:00:00Z' };
const BASE = 'https://ons.test';
const OUT = `${BASE}/ap/users/dev/outbox`;

test('de wortel draagt first en last', () => {
  const ob = AP.buildOutbox(BASE, site, [POST]);
  assert.equal(ob.type, 'OrderedCollection');
  assert.equal(ob.first, `${OUT}?page=1`);
  assert.equal(ob.last, `${OUT}?page=1`);
});

test('en houdt zijn items inline, want Shaer leest die', () => {
  const ob = AP.buildOutbox(BASE, site, [POST]);
  assert.equal(ob.orderedItems.length, 1);
  assert.equal(ob.totalItems, 1);
});

test('de pagina is een OrderedCollectionPage die terugwijst', () => {
  const pg = AP.buildOutbox(BASE, site, [POST], [], { page: true });
  assert.equal(pg.type, 'OrderedCollectionPage');
  assert.equal(pg.id, `${OUT}?page=1`);
  assert.equal(pg.partOf, OUT, 'zonder partOf hangt een pagina in de lucht');
  assert.equal(pg.orderedItems.length, 1);
});

test('een pagina noemt zichzelf geen wortel', () => {
  const pg = AP.buildOutbox(BASE, site, [POST], [], { page: true });
  assert.equal(pg.first, undefined, 'first hoort op de wortel, niet op de pagina');
  assert.equal(pg.last, undefined);
});

test('ook een LEGE outbox draagt ze -- een geblokkeerde lezer krijgt geldige AS2', () => {
  // De blocked-tak levert een lege collectie. Zonder first/last zou juist die
  // door dezelfde serializer geweigerd worden.
  const leeg = AP.buildOutbox(BASE, site, []);
  assert.equal(leeg.totalItems, 0);
  assert.equal(leeg.first, `${OUT}?page=1`);
  assert.equal(leeg.last, `${OUT}?page=1`);
});
