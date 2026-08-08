// Een Accept op onze Follow moet de volgrelatie openzetten -- ook als de
// tegenpartij ons follow-id niet teruggeeft.
//
// Aanleiding: Funkwhale (audio.pepemoss.com, 7 augustus). Wij stuurden een
// Follow met id `<actor>#follow-<ts>-<rnd>`; de Accept kwam terug met een door
// Funkwhale zelf verzonnen id in onze namespace, `<actor>#follows/<uuid>`.
// Matchen op follow_id raakte niets, de rij bleef op 'pending', en de logregel
// riep toch 'accepted'. De relatie kwam nooit tot stand en er kwam dus ook
// nooit muziek binnen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'dev', 'Dev', 'u1');

const REMOTE = 'https://audio.example/federation/actors/kanaal';
const ONS_ID = 'https://test.example/ap/users/dev#follow-1786161977286-bb2de32f';

function zetPending(followId = ONS_ID, actor = REMOTE) {
  db.prepare('DELETE FROM ap_following').run();
  db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, name, icon, url, inbox, follow_id, status, auto_boost, created_at)
              VALUES (?,?,?,?,?,?,?,?,'pending',0,CURRENT_TIMESTAMP)`)
    .run('dev', actor, '@kanaal@audio.example', 'Kanaal', null, null, actor + '/inbox', followId);
}
const status = (actor = REMOTE) =>
  (db.prepare('SELECT status FROM ap_following WHERE slug = ? AND actor_uri = ?').get('dev', actor) || {}).status;

// handleInbox draait de handtekeningcontrole; die is hier niet het onderwerp.
// De Accept-tak krijgt een geverifieerde actor mee, precies zoals in bedrijf.
const accept = (object) => AP.handleInbox({
  body: { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Accept', actor: REMOTE, object },
  headers: {}, get: () => undefined, socket: {},
}, 'dev', { id: REMOTE });

test('de gewone weg: de Accept geeft ONS follow-id terug', async () => {
  zetPending();
  await accept({ id: ONS_ID, type: 'Follow', actor: 'https://test.example/ap/users/dev', object: REMOTE });
  assert.equal(status(), 'accepted');
});

test('de Funkwhale-vorm: een zelfverzonnen id in onze namespace', async () => {
  zetPending();
  await accept({
    id: 'https://test.example/ap/users/dev#follows/19fd8b00-8f66-4362-b233-542eadfa40fc',
    type: 'Follow', actor: 'https://test.example/ap/users/dev', object: REMOTE,
  });
  assert.equal(status(), 'accepted', 'de terugval op (site, actor) hoort dit op te vangen');
});

test('een Accept als kale string blijft werken', async () => {
  zetPending();
  await accept(ONS_ID);
  assert.equal(status(), 'accepted');
});

test('een Accept van een ANDERE actor raakt onze rij niet', async () => {
  zetPending();
  await AP.handleInbox({
    body: { type: 'Accept', actor: 'https://elders.example/users/vreemd', object: { id: 'https://elders.example/x', type: 'Follow' } },
    headers: {}, get: () => undefined, socket: {},
  }, 'dev', { id: 'https://elders.example/users/vreemd' });
  assert.equal(status(), 'pending', 'alleen de ondertekenaar zelf kan zijn eigen follow openzetten');
});

test('een al geaccepteerde rij wordt niet opnieuw geraakt door een vreemde Accept', async () => {
  zetPending();
  db.prepare('UPDATE ap_following SET status = ?').run('accepted');
  await accept({ id: 'https://test.example/ap/users/dev#follows/anders', type: 'Follow', object: REMOTE });
  assert.equal(status(), 'accepted');
});
