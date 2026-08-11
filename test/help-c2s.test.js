// Een hulpvraag oppikken en afsluiten vanuit de app (shaer-lgo, Barts melding 8-8).
//
// De apps lazen hulpvragen uit de FEED en kregen de staat niet mee. Ze wisten dus
// niet of er al iemand op af was, en een afgehandeld verzoek bleef gewoon staan.
//
// Wat hier bewaakt wordt: de app loopt door dezelfde markering en dezelfde staat
// als het paneel. Twee berekeningen zouden twee guardians een ander beeld geven
// van hetzelfde kind -- en bij een reddingsboei is dat het gevaarlijkste dat er
// mis kan gaan.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://oma.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');
const queues = await import('../src/services/guardianship/queues.js');
const rel = await import('../src/services/guardianship/relations.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'oma', 'Oma', 'u1');
const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const user = { id: 'u1', username: 'u1' };
const KIND = 'https://elders.test/ap/users/kind';
const BOEI = 'https://elders.test/ap/notes/boei-1';
rel.commitWardForGuardian('oma', KIND, { handle: '@kind' });
db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_handle, content, help_request)
            VALUES (?,?,?,?,?,1)`).run('oma', BOEI, KIND, '@kind', '<p>help</p>');

const marker = (kind) => ({
  type: 'Create',
  object: {
    type: 'Note',
    content: '<p>.</p>',
    to: [KIND],
    [kind === 'handled' ? 'shaer:helpHandled' : 'shaer:helpPickup']: BOEI,
  },
});

test('een verse hulpvraag staat OPEN', () => {
  const h = queues.helpItemsFor('oma').find((x) => x.object_uri === BOEI);
  assert.equal(h.state.open, true);
  assert.equal(h.state.handled, null);
});

test('oppikken vanuit de app landt in dezelfde staat als het paneel', async () => {
  await AP.ingestOutboxActivity(site(), user, marker('pickup'));
  const h = queues.helpItemsFor('oma').find((x) => x.object_uri === BOEI);
  assert.equal(h.state.pickedUpBy.length, 1);
  // Nog steeds open: oppikken is geen afhandelen. De faalstand hier is
  // "iedereen denkt dat het geregeld is", en die is gevaarlijker dan geen
  // markering.
  assert.equal(h.state.open, true);
});

test('onze EIGEN markering draagt onze eigen handle', () => {
  // "Door wie" was de hele vraag van deze bead. Een binnengekomen markering
  // draagt de handle van de afzender wel; onze eigen rij stond op null en viel
  // op het scherm terug op de kale URI. Gezien op 11-8 in de echte data naast
  // een rij van boiert.eu, die zijn handle wel had.
  const coll = queues.helpCollection('https://x/queues/help', 'oma');
  const item = coll.orderedItems.find((i) => i.id === BOEI);
  assert.deepEqual(item['shaer:pickedUpBy'], ['@oma@oma.test'],
    'een handle en geen URI');
});

test('en de apps krijgen te horen HOE OUD dat oppakken is', () => {
  // Barts besluit: opgepikt vervalt niet maar veroudert zichtbaar -- het
  // verschil tussen "er is iemand mee bezig" en "er was ooit iemand mee bezig".
  // Het paneel toonde dat al uit dezelfde staat; de apps kregen het veld niet,
  // dus daar zag een oppak van vijf minuten eruit als een van vijf dagen.
  const coll = queues.helpCollection('https://x/queues/help', 'oma');
  const item = coll.orderedItems.find((i) => i.id === BOEI);
  assert.ok(item['shaer:oldestPickupAt'], 'het veld staat er');
  assert.ok(!Number.isNaN(Date.parse(item['shaer:oldestPickupAt'])), 'en is een leesbaar tijdstip');
  // Een TIJDSTIP en geen leeftijd: een leeftijd maakt elk antwoord anders en
  // dan kan de ETag nooit gelijk zijn. De client rekent zelf terug.
  assert.equal(typeof item['shaer:oldestPickupAt'], 'string');
});

test('afsluiten vanuit de app sluit hem ook echt', async () => {
  await AP.ingestOutboxActivity(site(), user, marker('handled'));
  const h = queues.helpItemsFor('oma').find((x) => x.object_uri === BOEI);
  assert.equal(h.state.open, false);
  assert.ok(h.state.handled, 'met wie het deed erbij');
});

test('de collectie voor de apps draagt de staat plat mee', () => {
  // Een app hoeft hem niet af te leiden, en kan hem dus ook niet anders
  // afleiden dan het paneel.
  const coll = queues.helpCollection('https://x/queues/help', 'oma');
  const item = coll.orderedItems.find((i) => i.id === BOEI);
  assert.equal(item['shaer:open'], false);
  assert.ok(item['shaer:handledBy']);
  assert.equal(item['shaer:helpRequest'], true);
  // En de ouderdom is WEG zodra hij is afgehandeld: hoe lang er iemand naar
  // keek is dan geen informatie meer, en zou als "er wacht nog iets" lezen.
  assert.equal(item['shaer:oldestPickupAt'], undefined);
});

test('een note zonder markering blijft een gewoon bericht', async () => {
  const uit = await AP.ingestOutboxActivity(site(), user, {
    type: 'Create', object: { type: 'Note', content: '<p>hoi</p>', to: [KIND] },
  });
  assert.notEqual(uit.status, 400);
});

test('OPEN vragen worden nooit afgekapt, hoeveel het er ook zijn', () => {
  // Barts punt (8-8): ik noemde tientallen hulpvragen bij een guardian een
  // randgeval, maar voor een jeugdzorgmedewerker is dat een caseload en dus een
  // gewone dinsdag. De gebruiker die dit het hardst nodig heeft was precies
  // degene voor wie het brak.
  //
  // Zonder deze regel viel een oudere vraag buiten de queue, vond de app geen
  // staat, en toonde hem -- terecht, want bij twijfel OPEN -- alsof er nog
  // iemand op moest.
  for (let i = 0; i < 120; i++) {
    db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_handle, content, help_request)
                VALUES (?,?,?,?,?,1)`).run('oma', `https://elders.test/ap/notes/veel-${i}`, KIND, '@kind', '<p>help</p>');
  }
  const open = queues.helpItemsFor('oma').filter((h) => h.state.open);
  assert.equal(open.length, 120, 'alle 120 open vragen komen mee');
});

test('de collectie zegt dat je uit afwezigheid mag concluderen', () => {
  // Zonder die vlag mag een app niets afleiden uit een ontbrekende staat, en
  // valt hij terug op bij-twijfel-open. Dat is de veilige kant, maar dan komt
  // een afgehandelde vraag terug in het zicht.
  const coll = queues.helpCollection('https://x/queues/help', 'oma');
  assert.equal(coll['shaer:openComplete'], true);
});
