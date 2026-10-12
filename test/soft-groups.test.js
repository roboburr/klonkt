// Zachte groepen in Berichten (shaer-mbji): een gesprek is de SET deelnemers,
// niet één tegenpartij.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const K = await import('../src/services/conversation-key.js');
const T = await import('../src/services/ap-timeline.js');

const ME = 'https://test.example/ap/users/me';
const ANNA = 'https://a.test/users/anna';
const BEN = 'https://b.test/users/ben';
const CARLA = 'https://c.test/users/carla';
const PUB = 'https://www.w3.org/ns/activitystreams#Public';

// ── De sleutel ────────────────────────────────────────────────────

test('één ander is zijn kale URI: bestaande gesprekken veranderen niet', () => {
  assert.equal(K.conversationKey([ANNA]), ANNA);
});

test('een groep is gesorteerd, dus {Anna, Ben} en {Ben, Anna} zijn één gesprek', () => {
  assert.equal(K.conversationKey([BEN, ANNA]), K.conversationKey([ANNA, BEN]));
  assert.equal(K.conversationKey([ANNA, BEN]), `${ANNA} ${BEN}`);
  assert.equal(K.conversationKey([ANNA, ANNA, BEN]), `${ANNA} ${BEN}`, 'dubbelen tellen een keer');
});

test('een publiek of een volgerslijst is geen deelnemer', () => {
  assert.equal(K.conversationKey([ANNA, PUB, `${ANNA}/followers`]), ANNA);
});

test('de sleutel valt terug in zijn deelnemers', () => {
  assert.deepEqual(K.participantsOfKey(`${ANNA} ${BEN}`), [ANNA, BEN]);
  assert.deepEqual(K.participantsOfKey(ANNA), [ANNA]);
  assert.equal(K.isGroupKey(`${ANNA} ${BEN}`), true);
  assert.equal(K.isGroupKey(ANNA), false);
});

test('de deelnemers van een binnenkomer: afzender plus geadresseerden, zonder mij', () => {
  const note = { to: [ME, BEN], cc: [PUB] };
  assert.deepEqual(K.participantsOf(note, ANNA, ME), [ANNA, BEN].sort());
  // Een gewoon één-op-één-bericht: alleen de afzender blijft over.
  assert.deepEqual(K.participantsOf({ to: [ME] }, ANNA, ME), [ANNA]);
  // AS2 staat ook objecten toe in to/cc.
  assert.deepEqual(K.participantsOf({ to: [{ id: ME }, { id: BEN }] }, ANNA, ME), [ANNA, BEN].sort());
});

test('context (FEP-7888) is een string of een object met een id', () => {
  assert.equal(K.contextOf({ context: 'https://a.test/ctx/1' }), 'https://a.test/ctx/1');
  assert.equal(K.contextOf({ context: { id: 'https://a.test/ctx/2' } }), 'https://a.test/ctx/2');
  assert.equal(K.contextOf({ context: 'javascript:alert(1)' }), null, 'alleen http(s)');
  assert.equal(K.contextOf({}), null);
});

// ── De lezing ─────────────────────────────────────────────────────

let n = 0;
function binnen(van, conv, stamp) {
  n += 1;
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, content, published, conv, participants)
              VALUES ('me', ?, ?, '<p>x</p>', ?, ?, ?)`)
    .run(`${van}/notes/${n}`, van, stamp, conv, conv ? JSON.stringify(K.participantsOfKey(conv)) : null);
  return `${van}/notes/${n}`;
}
function uit(ontvangers, { conv = K.conversationKey(ontvangers), stamp }) {
  n += 1;
  const id = `out-${n}`;
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, content, visibility, to_actor, to_actors, conv, created_at)
              VALUES (?, 'me', '', '<p>x</p>', 'direct', ?, ?, ?, ?)`)
    .run(id, ontvangers[0], JSON.stringify(ontvangers), conv, stamp);
  return id;
}

test('een bericht aan Anna en Ben is één gesprek, niet twee', () => {
  uit([ANNA, BEN], { stamp: '2026-10-01 10:00:00' });
  binnen(ANNA, K.conversationKey([ANNA, BEN]), '2026-10-01T10:05:00Z');
  binnen(ANNA, ANNA, '2026-10-01T09:00:00Z');   // het één-op-één-gesprek bestaat ernaast

  const koppen = T.conversationHeads('me').map((h) => h.other);
  const groep = K.conversationKey([ANNA, BEN]);
  assert.ok(koppen.includes(groep), 'de groep heeft een kop');
  assert.ok(koppen.includes(ANNA), 'het gesprek met alleen Anna blijft bestaan');
  assert.ok(!koppen.includes(BEN), 'Ben heeft geen los gesprek gekregen van een groepsbericht');

  const draad = T.conversationHistory('me', groep).rows;
  assert.equal(draad.length, 2, 'mijn bericht en Anna\'s antwoord staan in dezelfde draad');
  assert.deepEqual(new Set(draad.map((r) => r.direction)), new Set(['in', 'out']));
});

test('oude uitgaande rijen zonder sleutel lezen zoals ze altijd lazen', () => {
  // Geen conv: per ontvanger, zoals voor deze wijziging. Geen migratie die de
  // geschiedenis herschikt.
  uit([CARLA, BEN], { conv: null, stamp: '2026-09-01 10:00:00' });
  const koppen = T.conversationHeads('me').map((h) => h.other);
  assert.ok(koppen.includes(CARLA));
  assert.ok(koppen.includes(BEN));
  assert.ok(!koppen.includes(K.conversationKey([BEN, CARLA])), 'een oude rij wordt niet alsnog een groep');
});

test('ongelezen en gelezen gaan per gesprek, ook voor een groep', () => {
  const groep = K.conversationKey([ANNA, CARLA]);
  const eerste = binnen(ANNA, groep, '2026-10-02T10:00:00Z');
  binnen(CARLA, groep, '2026-10-02T10:01:00Z');

  assert.equal(T.unreadPerConversation('me').get(groep).n, 2);
  T.markRead('me', eerste);
  assert.equal(T.unreadPerConversation('me').get(groep).n, 1, 'gelezen tot en met het eerste');
  // Het één-op-één-gesprek met Anna merkt daar niets van.
  const losAnna = T.unreadPerConversation('me').get(ANNA);
  assert.ok(!losAnna || losAnna.n >= 1);
});
