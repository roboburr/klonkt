// Een Move is een Move: de guardian blijft dezelfde guardian.
//
// Toezicht is een gewone Follow (FEP-633c §5), en die verhuisde al mee. Maar de
// guardianship-RELATIE bleef aan de oude URI hangen. Dat gaf de vervelendste
// toestand van allemaal: de guardian ziet de posts van het kind gewoon
// binnenkomen, terwijl alles dat op other_uri matcht omvalt. Half een vangnet
// ziet eruit als een heel vangnet, en dan merk je het pas als het nodig is.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{
  const stil = console.log;
  console.log = () => {};
  try { dbMod.initializeDatabase(); } finally { console.log = stil; }
}
const AP = await import('../src/services/ActivityPubService.js');

const OUD = 'https://oud.example/ap/users/kind';
const NIEUW = 'https://nieuw.example/ap/users/kind';

// De guardian zijn WIJ: een lokale site die het kind volgt en de relatie draagt.
function zetKlaar({ status = 'accepted' } = {}) {
  db.prepare('DELETE FROM ap_following').run();
  db.prepare('DELETE FROM ap_guardianships').run();
  db.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'u1', 'u1@test', 'x', 'god');
  db.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'voogd', 'De voogd', 'u1');
  db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, status, auto_boost)
              VALUES (?,?,?,?,?)`).run('voogd', OUD, '@kind@oud.example', 'accepted', 1);
  db.prepare(`INSERT INTO ap_guardianships (slug, other_uri, role, status)
              VALUES (?,?,?,?)`).run('voogd', OUD, 'guardian', status);
}

const relatie = () => db.prepare('SELECT other_uri, role, status FROM ap_guardianships').all();

// Geen netwerk: de Move-afhandeling accepteert injecteerbare functies.
const stubs = {
  verifiedActor: OUD,
  fetchActorFn: async (uri) => ({ id: uri, inbox: `${uri}/inbox`, alsoKnownAs: [OUD] }),
  followFn: async () => true,
  unfollowFn: async () => true,
};
const move = { type: 'Move', actor: OUD, object: OUD, target: NIEUW };

beforeEach(() => zetKlaar());

test('na een Move wijst de guardianship naar het NIEUWE adres', async () => {
  const stil = console.log; console.log = () => {};
  try { await AP.handleMoveInbox(move, stubs); } finally { console.log = stil; }

  const r = relatie();
  assert.equal(r.length, 1, 'de relatie mag niet verdubbelen of verdwijnen');
  assert.equal(r[0].other_uri, NIEUW, 'anders ziet de guardian de posts wel, maar valt de gate om');
  assert.equal(r[0].role, 'guardian', 'de rol verandert niet: hij is dezelfde guardian');
  assert.equal(r[0].status, 'accepted');
});

test('de Follow verhuist mee, met de uitgelicht-stand', async () => {
  const gevolgd = [];
  const stil = console.log; console.log = () => {};
  try {
    await AP.handleMoveInbox(move, {
      ...stubs,
      followFn: async (site, uri, boost) => { gevolgd.push([uri, boost]); return true; },
    });
  } finally { console.log = stil; }
  assert.deepEqual(gevolgd, [[NIEUW, true]]);
});

test('een niet-geverifieerde Move raakt de guardianship niet aan', async () => {
  const stil = console.warn; console.warn = () => {};
  try {
    // verifiedActor wijst niet naar de oude actor: dit is niet zijn Move.
    await AP.handleMoveInbox(move, { ...stubs, verifiedActor: 'https://iemand.anders/ap/users/x' });
  } finally { console.warn = stil; }
  assert.equal(relatie()[0].other_uri, OUD,
    'anders kan een vreemde het kind bij zijn guardians weghalen door een Move te sturen');
});

test('een relatie die nog niet geaccepteerd is blijft staan', async () => {
  zetKlaar({ status: 'pending' });
  const stil = console.log; console.log = () => {};
  try { await AP.handleMoveInbox(move, stubs); } finally { console.log = stil; }
  assert.equal(relatie()[0].other_uri, OUD,
    'een verzoek dat nog loopt gaat over de OUDE actor; dat verhuizen zou een niet-bestaande relatie meenemen');
});

// De VOLGORDE, niet de uitkomst. De tests hierboven slagen ook als de relatie pas
// na de follows wordt bijgewerkt, en juist dat ging mis bij Robins verhuizing:
//
//   [AP] outgoing Follow beta → .../robo (gated, awaiting guardians)
//
// Beta is zelf een ward, dus zijn uitgaande follow naar de verhuisde guardian werd
// gepoort omdat het nieuwe adres nog niet in zijn guardian-lijst stond. Beide
// richtingen bleven hangen op een goedkeuring die niemand hoefde te geven.
test('de guardianship is al bijgewerkt VOORDAT de follow uitgaat', async () => {
  let standTijdensFollow = null;
  const stil = console.log; console.log = () => {};
  try {
    await AP.handleMoveInbox(move, {
      ...stubs,
      followFn: async () => {
        // Op dit moment moet de gate aan de andere kant ons al kennen.
        standTijdensFollow = db.prepare('SELECT other_uri FROM ap_guardianships').get().other_uri;
        return true;
      },
    });
  } finally { console.log = stil; }

  assert.equal(standTijdensFollow, NIEUW,
    'staat de relatie hier nog op het oude adres, dan gate\'t de ward de follow van zijn eigen guardian');
});

test('een Move naar een geblokkeerde bestemming verandert niets', async () => {
  db.prepare('INSERT INTO ap_blocks (slug, target, kind) VALUES (?,?,?)').run('voogd', NIEUW, 'actor');
  const stil = console.log; console.log = () => {};
  try { await AP.handleMoveInbox(move, stubs); } finally { console.log = stil; }
  db.prepare('DELETE FROM ap_blocks').run();
  assert.equal(relatie()[0].other_uri, OUD, 'geblokkeerd is geblokkeerd, ook voor een guardianship');
});
