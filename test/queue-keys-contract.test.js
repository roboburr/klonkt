// Wat de actor als wachtrij ADVERTEERT, moet er ook zijn -- en de lijst mag
// niet stilletjes groeien (shaer-x3kj, contract uit shaer-6d9).
//
// De daemon en Klonkt delen dit contract: een client die tegen allebei praat
// mag geen sleutel op de een vinden en op de ander niet. Zo ontstond deze bead:
// Klonkt kreeg er outgoingFollows en help bij, de daemon bleef op vier staan,
// en de UI die je tegen de daemon test zegt dan niets over Klonkt.
//
// Deze toets bewaakt de kant die HIER te bewaken is:
//   1. de sleutelverzameling ligt vast, dus een zevende sleutel is een bewuste
//      daad met een rode toets ernaast in plaats van stille drift;
//   2. elke geadverteerde sleutel wijst naar een route die BESTAAT. Adverteren
//      wat er niet is, is erger dan niet adverteren -- dan gaat een client hem
//      halen en krijgt 404 op iets wat het actor-document beloofde.
//
// De spiegelkant (draait de daemon dezelfde zes?) hoort in de daemon zelf; die
// heeft geen toegang tot deze suite en andersom.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)').run('s1', 'kid', 'Kid', 'u1');

const app = express(); app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// De zes die Klonkt vandaag adverteert. Komt er een bij, dan hoort hij hier
// EN in de daemon -- dat is het hele punt van shaer-6d9.
const VERWACHT = ['follows', 'guardians', 'help', 'offers', 'outgoingFollows', 'wards'];

async function queues() {
  const r = await fetch(`${base}/ap/users/kid`, { headers: { Accept: 'application/activity+json' } });
  assert.equal(r.status, 200, 'het actor-document hoort er te zijn');
  return (await r.json())['shaer:queues'] || {};
}

test('de actor adverteert precies de afgesproken wachtrijen', async () => {
  assert.deepEqual(Object.keys(await queues()).sort(), [...VERWACHT].sort(),
    'wijkt dit af, dan loopt Klonkt uit de pas met de daemon (shaer-x3kj)');
});

test('elke geadverteerde wachtrij bestaat als route', async () => {
  const q = await queues();
  const missend = [];
  for (const [sleutel, url] of Object.entries(q)) {
    // Zonder token geeft een bestaande wachtrij 403 (alleen de eigenaar mag
    // erin). 404 betekent dat de route niet bestaat -- dan belooft het
    // actor-document iets wat er niet is.
    const r = await fetch(base + new URL(url).pathname, { headers: { Accept: 'application/activity+json' } });
    if (r.status === 404) missend.push(`${sleutel} -> ${new URL(url).pathname}`);
  }
  assert.deepEqual(missend, [], 'geadverteerd maar niet bereikbaar');
});
