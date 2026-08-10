// FEP-633c §4.2 — de reden mag niet verdampen.
//
// Guardianship-events waren vluchtig: onGuardianshipEvent wekte de long-poll,
// keek in een tabel van zeven soorten of er een push bij hoorde, en liet de
// rest vallen. Elf van de achttien soorten verdwenen daarmee spoorloos, met hun
// inhoud erbij. Een weigering droeg `reason: 'not_a_teapot'` tot precies daar en
// niet verder, terwijl §4.2 eist dat de ward en zijn guardians die reden TE
// HOREN krijgen -- en niet dat ze het afleiden uit een aanbod dat opeens weg is.
//
// Vastleggen en melden zijn nu twee dingen. Deze test bewaakt het eerste; welke
// gebeurtenis een mens wakker maakt blijft een aparte beslissing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)')
  .run('s1', 'kid', 'kid', 'u1');

test('een gebeurtenis die geen push oplevert wordt tóch onthouden', () => {
  // offer_rejected staat niet in de meldingstabel: niemand wordt er wakker van,
  // en dat was precies de reden dat hij ook nergens terechtkwam.
  const push = AP.onGuardianshipEvent('kid', {
    kind: 'offer_rejected', offer: 'o1',
    reason: 'not_a_teapot', candidate: 'https://elders.example/users/tess',
  });
  assert.equal(push, null, 'geen melding, zoals bedoeld');

  const log = AP.listGuardianEvents('kid');
  assert.equal(log.length, 1, 'maar wel vastgelegd');
  assert.equal(log[0].kind, 'offer_rejected');
  assert.equal(log[0].reason, 'not_a_teapot', 'MET de reden: daar staat dit logboek voor');
  assert.equal(log[0].candidate, 'https://elders.example/users/tess', 'en om wie het ging');
});

test('nieuwste eerst, want geschiedenis leest van achteren', () => {
  AP.onGuardianshipEvent('kid', { kind: 'committed', ward: 'https://test.example/ap/users/kid' });
  const log = AP.listGuardianEvents('kid');
  assert.equal(log[0].kind, 'committed');
  assert.equal(log[1].kind, 'offer_rejected');
});

test('het logboek van een ander account blijft van hem', () => {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)')
    .run('s2', 'mum', 'mum', 'u1');
  assert.deepEqual(AP.listGuardianEvents('mum'), [],
    'wat er over een kind is besloten is niet van iedereen');
});

test('het loopt niet vol', () => {
  // Een logboek dat oneindig groeit wordt een logboek dat niemand opent, en
  // hier ligt het in dezelfde database als alles wat wél om aandacht vraagt.
  for (let i = 0; i < AP.GUARDIAN_EVENT_KEEP + 25; i++) {
    AP.onGuardianshipEvent('mum', { kind: 'setting', n: i });
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM ap_guardian_events WHERE slug = ?').get('mum').n;
  assert.equal(n, AP.GUARDIAN_EVENT_KEEP, 'afgekapt op de bewaargrens');
  // En het zijn de JONGSTE die blijven: afkappen aan de verkeerde kant zou het
  // logboek precies onbruikbaar maken op het moment dat er iets gebeurt.
  assert.equal(AP.listGuardianEvents('mum', 1)[0].n, AP.GUARDIAN_EVENT_KEEP + 24);
});

test('een kapotte gebeurtenis breekt de gebeurtenis zelf niet', () => {
  // Het logboek is bijzaak. Zou een schrijffout hier de commit of de weigering
  // meesleuren, dan is de cure erger dan de kwaal.
  assert.doesNotThrow(() => AP.onGuardianshipEvent('kid', { kind: 'setting', zelf: { a: null } }));
  assert.doesNotThrow(() => AP.onGuardianshipEvent('kid', {}));
  assert.doesNotThrow(() => AP.onGuardianshipEvent(null, { kind: 'setting' }));
});
