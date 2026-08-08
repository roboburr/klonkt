// Guardianship Fase 2 (shaer-jdb): gate-verzoeken bereiken een C2S-client.
//
// De gating zelf werkt sinds shaer-hxg. Wat ontbrak was het DOORGEVEN: de
// wachtrij `follows` gaf hardgecodeerd een lege lijst terug ("not built in
// Klonkt yet (Fase 2)") en `outgoing-follows` serveerde alleen de ward-kant.
// Daardoor bleven beide secties in Shaer altijd leeg.
//
// En daaronder zat de echte fout: shaer:direction werd bij het versturen gezet
// en nergens gelezen, dus een UITGAAND verzoek werd opgeslagen als "deze ward
// wil deze ward volgen" met het doel weggegooid.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const G = await import('../src/services/guardianship/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'oma', 'o@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'oma', 'Oma', 'u1');

const WARD = 'https://kind.test/ap/users/kind';
const VREEMDE = 'https://elders.test/users/vreemde';
const DOEL = 'https://muziek.test/users/band';
const ME = 'https://klonkt.test/ap/users/oma';

test('een INKOMEND verzoek komt in de follows-wachtrij', () => {
  G.follows.recordReview('oma', {
    id: 'f-in', wardUri: WARD, follower: VREEMDE, followerHandle: '@vreemde@elders.test',
    direction: 'incoming',
  });
  const c = G.followsCollection(`${ME}/queues/follows`, 'oma', ME);
  assert.equal(c.totalItems, 1, 'deze wachtrij gaf hiervoor altijd een lege lijst terug');
  const it = c.orderedItems[0];
  assert.equal(it.actor, VREEMDE, 'de vreemde is de volger');
  assert.equal(it.object, WARD, 'en de ward is het doel');
  assert.equal(it['shaer:direction'], 'incoming');
});

test('een UITGAAND verzoek komt in de outgoing-wachtrij, met het doel erin', () => {
  // De kern van de bug: hiervoor werd dit als inkomend opgeslagen met ward ==
  // follower, en het doel -- waar het antwoord over gaat -- viel weg.
  G.follows.recordReview('oma', {
    id: 'f-uit', wardUri: WARD, follower: WARD, direction: 'outgoing',
    target: DOEL, targetHandle: '@band@muziek.test',
  });
  const c = G.outgoingFollowsCollection(`${ME}/queues/outgoing-follows`, 'oma', ME);
  const it = c.orderedItems.find((x) => x.id === 'f-uit');
  assert.ok(it, 'een guardian zag hier nooit iets: de wachtrij serveerde alleen de ward-kant');
  assert.equal(it.actor, WARD, 'de ward is hier de volger');
  assert.equal(it.object, DOEL);
  assert.equal(it['shaer:target'], DOEL, 'zonder dit valt er niets te beoordelen');
  assert.equal(it['shaer:targetHandle'], '@band@muziek.test');
  assert.equal(it['shaer:direction'], 'outgoing');
});

test('de twee richtingen lopen niet door elkaar', () => {
  const inn = G.followsCollection(`${ME}/q/f`, 'oma', ME).orderedItems.map((x) => x.id);
  const uit = G.outgoingFollowsCollection(`${ME}/q/o`, 'oma', ME).orderedItems.map((x) => x.id);
  assert.deepEqual(inn, ['f-in']);
  assert.ok(uit.includes('f-uit') && !uit.includes('f-in'));
});

test('bij een remote ward wordt het aantal guardians WEGGELATEN, niet op nul gezet', () => {
  // De guardian-set van een remote ward wordt op diens eigen server bijgehouden.
  // Nul sturen zou lezen als "dit kind heeft geen guardians", en dat is het
  // tegenovergestelde van onbekend.
  const it = G.followsCollection(`${ME}/q/f`, 'oma', ME).orderedItems[0];
  assert.equal(it['shaer:guardianCount'], undefined);
});

test('een oude rij zonder richting telt als inkomend', () => {
  // Bestaande rijen missen de kolom en zijn niet te repareren -- de informatie
  // stond er nooit in. Ze horen terug te vallen op het geval dat ze toen waren.
  db.prepare(`INSERT INTO ap_follow_reviews (id, guardian_slug, ward_uri, follower_uri, direction)
              VALUES ('f-oud','oma',?,?,NULL)`).run(WARD, VREEMDE);
  const inn = G.followsCollection(`${ME}/q/f`, 'oma', ME).orderedItems.map((x) => x.id);
  assert.ok(inn.includes('f-oud'));
});

// ── De drempel voor een volgverzoek (Barts besluit, 8-8) ────────────────

test('een eenvoudige meerderheid: 1 van 2 is voldoende', () => {
  // Barts woorden. Bewust soepeler dan de POORTdrempel: een gate opent een deur
  // voor alles wat daarna komt, een volgverzoek gaat over een persoon en is met
  // ontvolgen terug te draaien.
  assert.equal(G.follows.followThreshold(1), 1);
  assert.equal(G.follows.followThreshold(2), 1);
  assert.equal(G.follows.followThreshold(3), 2);
  assert.equal(G.follows.followThreshold(4), 2);
});

test('en dat is een AANSCHERPING, geen versoepeling', () => {
  // Tot vandaag stond dit op 'any': een enkele ja, hoeveel guardians er ook
  // waren. Bij drie of meer is er nu meer nodig, niet minder.
  assert.ok(G.follows.followThreshold(3) > 1);
  assert.ok(G.follows.followThreshold(5) > 1);
});

test('nul guardians vraagt nog steeds iemand', () => {
  // Een lege set mag nooit "iedereen is het eens" opleveren. Dat is de stille
  // fout waarmee een verzoek zichzelf goedkeurt.
  assert.equal(G.follows.followThreshold(0), 1);
});

test('de drempel voor een POORT blijft strikter', () => {
  // Twee verschillende vragen, twee drempels, en dat verschil is opzet: 2 van 2
  // voor een gate, 1 van 2 voor een volgverzoek.
  assert.equal(G.gated.thresholdFor(2), 2);
  assert.equal(G.follows.followThreshold(2), 1);
});
