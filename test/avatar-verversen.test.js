// Naam en avatar in de volgers- en gevolgdlijst blijven bij (shaer-xc4g).
//
// Aanleiding (Bart, 19-11): Hotel (@hotelbreakfast@mastodon.social) viel in de
// hemel terug op een 'H'. Klonkt bewaarde de avatar van toen Hotel ons ging
// volgen; Hotel wisselde van avatar, mastodon.social gooide het oude bestand
// weg (403), en wij serveerden de dode URL in de followers-collectie.
//
//   1. Een actor die zijn eigen profiel bijwerkt (Update van een Person),
//      ververst naam en avatar overal waar we hem bewaren. Alleen over zichzelf.
//   2. Wie ons volgt maar die wij niet volgen, stuurt ons die Update niet: oude
//      rijen worden dus af en toe en begrensd opnieuw opgehaald.
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
// De verversing haalt actor-documenten op; die host mag door de SSRF-poort,
// en fetch zelf is gestubd.
process.env.AP_ALLOW_HOSTS = 'elders.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;

const HOTEL = 'https://elders.example/users/hotel';      // volgt ons, wij hem niet
const GEVOLGD = 'https://elders.example/users/gevolgd'; // wij volgen hem
const OUD = 'https://elders.example/avatars/oud.png';
const NIEUW = 'https://elders.example/avatars/nieuw.png';

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'ik', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
const token = 'test-token-avatar-' + 'd'.repeat(24);
db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
  .run(crypto.createHash('sha256').update(token).digest('base64url'), 'shaer', 'u1', 'ik', 'c2s');

const herstel = () => {
  db.prepare('DELETE FROM ap_followers').run();
  db.prepare('DELETE FROM ap_following').run();
  db.prepare(`INSERT INTO ap_followers (slug, actor_uri, inbox, name, handle, icon) VALUES ('ik', ?, ?, 'Hotel', '@hotel@elders.example', ?)`)
    .run(HOTEL, `${HOTEL}/inbox`, OUD);
  db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, name, icon, inbox, status) VALUES ('ik', ?, '@gevolgd@elders.example', 'Gevolgd', ?, ?, 'accepted')`)
    .run(GEVOLGD, OUD, `${GEVOLGD}/inbox`);
};
const rij = (tabel, uri) => db.prepare(`SELECT name, icon, display_at FROM ${tabel} WHERE actor_uri = ?`).get(uri);
const persoon = (id, extra = {}) => ({ id, type: 'Person', preferredUsername: id.split('/').pop(), name: 'Nieuwe naam', icon: { type: 'Image', url: NIEUW }, ...extra });
const binnen = (act, signer) => AP.handleInbox(
  { body: act, ip: '1.2.3.4', protocol: 'https', get: () => 'klonkt.test', headers: {} }, null, { id: signer });

test('een Update van je eigen profiel ververst naam en avatar, als volger en als gevolgde', async () => {
  herstel();
  for (const wie of [HOTEL, GEVOLGD]) {
    const status = await binnen({ type: 'Update', actor: wie, object: persoon(wie) }, wie);
    assert.equal(status, 202);
  }
  assert.equal(rij('ap_followers', HOTEL).icon, NIEUW);
  assert.equal(rij('ap_followers', HOTEL).name, 'Nieuwe naam');
  assert.ok(rij('ap_followers', HOTEL).display_at);
  assert.equal(rij('ap_following', GEVOLGD).icon, NIEUW);
});

test('alleen over jezelf: een ander profiel aanleveren verandert niets', async () => {
  herstel();
  await binnen({ type: 'Update', actor: GEVOLGD, object: persoon(HOTEL) }, GEVOLGD);
  assert.equal(rij('ap_followers', HOTEL).icon, OUD);
  assert.equal(rij('ap_followers', HOTEL).name, 'Hotel');
});

test('wie zijn avatar weghaalt, krijgt geen oude terug', async () => {
  herstel();
  await binnen({ type: 'Update', actor: HOTEL, object: persoon(HOTEL, { icon: undefined }) }, HOTEL);
  assert.equal(rij('ap_followers', HOTEL).icon, null);
});

test('refreshStaleDisplays: oud wordt opgehaald, vers niet; weg wacht een week, een storing niet', async () => {
  herstel();
  const ANDER = 'https://elders.example/users/weg';
  const STORING = 'https://elders.example/users/storing';
  const VERS = 'https://elders.example/users/vers';
  const ins = db.prepare(`INSERT INTO ap_followers (slug, actor_uri, inbox, name, icon, display_at) VALUES ('ik', ?, ?, 'x', ?, ?)`);
  ins.run(ANDER, `${ANDER}/inbox`, OUD, null);
  ins.run(STORING, `${STORING}/inbox`, OUD, null);
  ins.run(VERS, `${VERS}/inbox`, OUD, new Date().toISOString().slice(0, 19).replace('T', ' '));
  const gehaald = [];
  const r = await AP.refreshStaleDisplays('ik', {
    get: async (slug, uri, onStatus) => {
      gehaald.push(uri);
      if (uri === ANDER) { onStatus(410); return null; }
      if (uri === STORING) return null;
      onStatus(200);
      return persoon(uri);
    },
  });
  assert.equal(rij('ap_followers', HOTEL).icon, NIEUW, 'de oude rij is ververst');
  assert.equal(rij('ap_following', GEVOLGD).icon, NIEUW, 'ook wie we volgen');
  assert.ok(!gehaald.includes(VERS), 'een verse rij wordt niet opgehaald');
  assert.equal(rij('ap_followers', ANDER).icon, OUD, 'weg: niets overschreven');
  assert.ok(rij('ap_followers', ANDER).display_at, 'maar wel een week met rust');
  assert.equal(rij('ap_followers', STORING).display_at, null, 'een storing probeert het de volgende keer weer');
  assert.equal(r.ververst, 2);
});

test('een document dat niet van die actor is, telt niet', async () => {
  herstel();
  await AP.refreshStaleDisplays('ik', { get: async (slug, uri) => persoon('https://elders.example/users/iemand-anders') });
  assert.equal(rij('ap_followers', HOTEL).icon, OUD);
});

test('de vriendenlijst van de app zet de verversing in gang, hooguit eens per uur', async () => {
  herstel();
  const gehaald = [];
  const echt = globalThis.fetch;
  globalThis.fetch = async (url) => {
    gehaald.push(String(url));
    return new Response(JSON.stringify(persoon(String(url))), { status: 200, headers: { 'Content-Type': 'application/activity+json' } });
  };
  const express = (await import('express')).default;
  const app = express();
  app.use((await import('../src/routes/activitypub.js')).default);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  after(() => server.close());
  try {
    const vraag = () => echt(`http://127.0.0.1:${server.address().port}/ap/users/ik/followers`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/activity+json', Prefer: 'return=representation' },
    });
    const eerste = await vraag();
    assert.equal(eerste.status, 200);
    for (let i = 0; i < 50 && rij('ap_followers', HOTEL).icon !== NIEUW; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(rij('ap_followers', HOTEL).icon, NIEUW, 'na de eerste vraag ververst');
    const aantal = gehaald.length;
    db.prepare('UPDATE ap_followers SET display_at = NULL').run();
    await vraag();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(gehaald.length, aantal, 'binnen het uur niet nog eens');
  } finally {
    globalThis.fetch = echt;
  }
});
