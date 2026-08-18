// De eigenaarspoort (Robins wens, 18-8): met approve_followers aan wordt een
// inkomende Follow NIET auto-geaccepteerd maar vastgehouden tot de eigenaar
// beslist op /connect — zodat niemand een klonkt ongevraagd aan een hub of
// ander verzamelplatform kan hangen. Zonder de instelling verandert er niets.
//
// De fetch is gestubd: het gaat om de poort, niet om echte HTTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const APmod = await import('../src/services/ActivityPubService.js');
const AP = APmod.default;
const G = await import('../src/services/guardianship/index.js');

db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES ('u1','u1','u1@t','x','god')").run();
db.prepare("INSERT INTO sites (id, slug, title, owner_id, is_public, approve_followers) VALUES ('s1','dev','Dev','u1',1,1)").run();
db.prepare("INSERT INTO sites (id, slug, title, owner_id, is_public, approve_followers) VALUES ('s2','open','Open','u1',1,0)").run();

// IP-literal: safeFetch slaat dan de DNS-lookup over en de stub vangt de rest.
const HUB = 'https://203.0.113.77/ap/actor';
const echteFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  id: HUB, type: 'Application', preferredUsername: 'hub', inbox: `${HUB}/inbox`,
}), { status: 200, headers: { 'content-type': 'application/activity+json' } });
after(() => { globalThis.fetch = echteFetch; });

const follow = (slug) => AP.handleInbox({
  body: {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${HUB}#follow-${slug}`, type: 'Follow', actor: HUB,
    object: `https://klonkt.test/ap/users/${slug}`,
  },
  headers: {}, get: () => undefined, socket: {},
}, slug, { id: HUB });

const volgers = (slug) =>
  db.prepare('SELECT COUNT(*) c FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(slug, HUB).c;

test('approve_followers aan: de Follow wacht op de eigenaar', async () => {
  await follow('dev');
  assert.equal(volgers('dev'), 0, 'geen auto-accept');
  const wachtend = G.follows.listForWard('dev');
  assert.equal(wachtend.length, 1);
  assert.equal(wachtend[0].follower_uri, HUB);
  assert.equal(wachtend[0].status, 'pending');
});

test('goedkeuren: volger erbij, wachtrij leeg', async () => {
  const pending = G.follows.listForWard('dev')[0];
  await AP.acceptGatedFollow(pending);
  G.follows.remove(pending.id);
  assert.equal(volgers('dev'), 1);
  assert.equal(G.follows.listForWard('dev').length, 0);
});

test('zonder de instelling blijft auto-accept gewoon werken', async () => {
  await follow('open');
  assert.equal(volgers('open'), 1);
});

test('de actor adverteert manuallyApprovesFollowers eerlijk', () => {
  const dicht = db.prepare("SELECT * FROM sites WHERE slug = 'dev'").get();
  const open = db.prepare("SELECT * FROM sites WHERE slug = 'open'").get();
  const build = APmod.buildActor || AP.buildActor;
  assert.equal(build('https://klonkt.test', dicht).manuallyApprovesFollowers, true);
  assert.equal(build('https://klonkt.test', open).manuallyApprovesFollowers, false);
});
