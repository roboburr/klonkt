// Alleen het verschil, als de client erom vraagt (shaer-pq4).
//
// De wachtende lezing zei tot nu toe alleen DAT er iets veranderde, waarna de
// client alles opnieuw las. Deze toetsen leggen drie dingen vast: dat het
// verschil klopt, dat een verwijdering meereist (want de volledigheid die dat
// tot nu toe deed valt hier weg), en dat de OUDE lezing niet verandert -- een
// app in het veld stuurt `since` al mee en zou zichzelf leegwissen.
//
// In-memory SQLite. Run: npm test
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
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kind', 'Kind', 'u1');

const post = (id, tekst) => db.prepare(
  `INSERT INTO ap_timeline (id, slug, author_uri, author_name, author_handle, content)
   VALUES (?, 'kind', 'https://elders/u/til', 'Til', '@til@elders', ?)`).run(id, tekst);

// De server leeft over de hele lezing heen: sluiten in een t.after van de
// EERSTE test zou hem dichttrekken voordat de tweede eraan toe is.
const crypto = await import('crypto');
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const bearer = 'test-token-' + 'f'.repeat(24);
db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
  .run(crypto.createHash('sha256').update(bearer).digest('base64url'), 'c', 'u1', 'kind', 'read write');
const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const poort = server.address().port;
// unref: een luisterende socket houdt de lus open, en dan wacht de testrunner
// eeuwig op een proces dat nooit vanzelf afloopt.
server.unref();

const get = async (qs) => {
  const r = await fetch(`http://127.0.0.1:${poort}/ap/users/kind/inbox${qs}`,
    { headers: { Authorization: `Bearer ${bearer}` } });
  return { status: r.status, body: r.status === 304 ? null : await r.json() };
};

test('het verschil draagt alleen wat er veranderde', async () => {
  post('https://elders/n/1', '<p>eerste</p>');
  const vol = await get('');
  const cursor = vol.body['shaer:cursor'];
  assert.equal(vol.body.orderedItems.length, 1);

  post('https://elders/n/2', '<p>tweede</p>');
  const delta = await get(`?changes=1&since=${encodeURIComponent(cursor)}`);
  assert.equal(delta.body.type, 'OrderedCollectionPage', 'een deel, en dat zegt het ook');
  assert.ok(delta.body.partOf.endsWith('/inbox'));
  assert.equal(delta.body.orderedItems.length, 1, 'alleen de nieuwe');
  assert.equal(delta.body.orderedItems[0].object.id, 'https://elders/n/2');
  // En de byline staat er gewoon op: dezelfde kaartvorm als de volle lezing.
  assert.equal(delta.body.orderedItems[0].object.attributedTo.name, 'Til');
});

test('een verwijdering reist mee als grafsteen', async () => {
  const heen = await get('');
  const cursor = heen.body['shaer:cursor'];
  db.prepare("DELETE FROM ap_timeline WHERE id = ?").run('https://elders/n/1');
  const delta = await get(`?changes=1&since=${encodeURIComponent(cursor)}`);
  const weg = delta.body.orderedItems.find((i) => i.type === 'Delete');
  assert.ok(weg, 'zonder dit zou de post voor altijd in de app blijven staan');
  assert.equal(weg.object.id, 'https://elders/n/1');
  assert.equal(weg.object.type, 'Tombstone');
});

test('zonder changes=1 verandert er NIETS aan de oude lezing', async () => {
  // De belangrijkste van deze vier: een app in het veld stuurt since al mee en
  // vervangt haar hele feed door wat er terugkomt.
  const vol = await get('');
  const cursor = vol.body['shaer:cursor'];
  const oud = await get(`?since=${encodeURIComponent(cursor)}`);
  assert.equal(oud.body.type, 'OrderedCollection', 'nog steeds de hele collectie');
  assert.equal(oud.body.orderedItems.length, vol.body.orderedItems.length);
});

test('het verschil draagt de rechten mee', async () => {
  // Zonder dit valt de client terug op zijn standaard, en die standaard is
  // 'alles mag': een gesloten poort zou zichzelf stil openzetten bij elke
  // verschil-lezing.
  const vol = await get('');
  db.prepare("UPDATE sites SET gate_images = 0 WHERE slug = 'kind'").run();
  db.prepare("INSERT INTO ap_guardianships (slug, other_uri, role, status) VALUES ('kind', 'https://elders/u/oma', 'guardian', 'accepted')").run();
  post('https://elders/n/9', '<p>na de poort</p>');
  const delta = await get(`?changes=1&since=${encodeURIComponent(vol.body['shaer:cursor'])}`);
  assert.equal(delta.body['shaer:capabilities']['shaer:images'], false, 'de dichte poort reist mee');
});

test('niets veranderd is een leeg verschil, niet een leeg antwoord', async () => {
  const vol = await get('');
  const delta = await get(`?changes=1&since=${encodeURIComponent(vol.body['shaer:cursor'])}`);
  assert.equal(delta.status, 200);
  assert.deepEqual(delta.body.orderedItems, []);
  assert.equal(delta.body['shaer:cursor'], vol.body['shaer:cursor'], 'en de cursor staat stil');
});
