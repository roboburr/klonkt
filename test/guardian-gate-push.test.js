// Meldingen bij gated settings (shaer-fax, fase 1 -- de PWA eerst).
//
// De guardianship-module zendt VEERTIEN soorten gebeurtenissen uit; de
// push-brug kende er vijf en deed `if (!texts) return`. Alles daarbuiten viel
// stil weg -- inclusief de twee die er voor een guardian het meest toe doen:
//
//   gated_review   een mede-guardian heeft iets voorgesteld en JOUW antwoord is
//                  nodig. Zonder melding loopt het venster leeg en verloopt het
//                  voorstel. Een drempel die niemand ziet is geen drempel.
//   gated_outcome  er is besloten.
//
// Getoetst wordt de BESLISSING (welke melding hoort hierbij), niet de bezorging.
// Of web-push zelf werkt heeft zijn eigen leven.
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
  .run('u1', 'g', 'g@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'oma', 'Oma', 'u1');

const KIND = 'https://kind.test/ap/users/kind';
const push = (ev) => AP.guardianEventPush('oma', ev);

test('een voorstel dat MIJN antwoord nodig heeft geeft een melding', () => {
  const m = push({ kind: 'gated_review', feature: 'shaer:externalEmbeds', value: true, ward: KIND });
  assert.ok(m, 'zonder dit weet een guardian niet dat er op hem gewacht wordt');
  assert.equal(m.type, 'guardian');
  assert.match(m.body, /kind/, 'de melding zegt over WIE het gaat');
  assert.match(m.body, /linkvoorbeelden|link previews|Link-Vorschauen/i, 'en WELKE instelling');
  assert.equal(m.url, '/guardian');
});

test('de stand staat erin, aan zowel als uit', () => {
  const aan = push({ kind: 'gated_review', feature: 'shaer:externalEmbeds', value: true, ward: KIND });
  const uit = push({ kind: 'gated_review', feature: 'shaer:externalEmbeds', value: false, ward: KIND });
  assert.notEqual(aan.body, uit.body, 'anders lees je niet of iets AAN of UIT gezet wordt');
});

test('afspelen is niet hetzelfde als linkvoorbeelden', () => {
  // Er is meer dan een gate, en ze betekenen heel verschillende dingen voor een
  // kind. Een melding die dat niet zegt is nutteloos.
  const a = push({ kind: 'gated_review', feature: 'shaer:externalEmbeds', value: true, ward: KIND });
  const b = push({ kind: 'gated_review', feature: 'shaer:externalPlayback', value: true, ward: KIND });
  assert.notEqual(a.body, b.body);
});

test('een besluit draagt de uitkomst', () => {
  const af = push({ kind: 'gated_outcome', feature: 'shaer:externalPlayback', value: false, outcome: 'rejected', ward: KIND });
  const aan = push({ kind: 'gated_outcome', feature: 'shaer:externalPlayback', value: false, outcome: 'accepted', ward: KIND });
  assert.match(af.body, /afgewezen|rejected|abgelehnt/i);
  assert.notEqual(af.body, aan.body);
});

test('een onbekende feature laat de melding NIET vervallen', () => {
  // Liever een iets vager bericht dan geen bericht: een guardian die niets hoort
  // denkt dat er niets speelt.
  assert.ok(push({ kind: 'gated_review', feature: 'shaer:ietsNieuws', value: true, ward: KIND }));
});

test('een soort die we niet kennen blijft stil', () => {
  // De vangnetregel blijft staan: liever geen melding dan een lege.
  assert.equal(push({ kind: 'iets_heel_anders', ward: KIND }), null);
});

test('de bestaande soorten blijven werken', () => {
  // Deze brug is verbouwd; wat er al doorheen ging moet er doorheen blijven gaan.
  for (const kind of ['offer_received', 'offer_for_ward', 'committed', 'guardian_left', 'coguardian_left']) {
    const m = push({ kind, ward: KIND, guardian: KIND, candidate: KIND });
    assert.ok(m && m.title && m.body, `${kind} hoort een melding te geven`);
  }
});
