// De outbox vertelt de discografie mee (shaer-0nh, stap 4).
//
// Tracks verschijnen als Create(Audio) in de outbox, door de posts heen op
// datum. NIET als bezorging naar volgers: Mastodon neemt Audio aan als
// statustype, dus bij een album-post zou dezelfde muziek twee keer in hun
// tijdlijn komen -- een keer als bijlage bij de Note, en dan nog los.
//
// En de deur blijft dicht: een geblokkeerde bezoeker krijgt een lege outbox,
// ook nu daar tracks in kunnen zitten.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');
const site = () => db.prepare("SELECT s.*, (SELECT slug FROM sites WHERE is_primary = 1) AS primary_slug FROM sites s WHERE s.id = 's1'").get();

db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1)')
  .run('m1', 's1', 'open.mp3', 'audio/open.mp3', 'audio/mpeg');
db.prepare('INSERT INTO audio_tracks (id, site_id, title, duration, media_id, fedi_open, created_at) VALUES (?,?,?,?,?,1,?)')
  .run('t1', 's1', 'Het nummer', 100, 'm1', '2026-03-01 12:00:00');
db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1)')
  .run('m2', 's1', 'dicht.mp3', 'audio/dicht.mp3', 'audio/mpeg');
db.prepare('INSERT INTO audio_tracks (id, site_id, title, duration, media_id, fedi_open) VALUES (?,?,?,?,?,0)')
  .run('t2', 's1', 'Achter de poort', 90, 'm2');

const POST_OUD = { id: 'p1', slug: 'p1', title: 'Oud', content: '<p>oud</p>', status: 'published', published_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' };
const POST_NIEUW = { id: 'p2', slug: 'p2', title: 'Nieuw', content: '<p>nieuw</p>', status: 'published', published_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' };

test('een track staat als Create(Audio) in de outbox', () => {
  const ob = AP.buildOutbox(BASE, site(), [], AP.siteOpenTracks('s1'));
  assert.equal(ob.totalItems, 1);
  const c = ob.orderedItems[0];
  assert.equal(c.type, 'Create');
  assert.equal(c.object.type, 'Audio', 'het blijft een Audio, geen Note');
  assert.equal(c.object.id, 'https://test.example/ap/users/band/tracks/t1');
  assert.equal(c.id, 'https://test.example/ap/users/band/tracks/t1#create',
    'stabiel id: twee keer ophalen is niet twee keer nieuws');
  assert.deepEqual(c.to, ['https://www.w3.org/ns/activitystreams#Public']);
});

test('posts en tracks staan door elkaar op datum, nieuwste eerst', () => {
  const ob = AP.buildOutbox(BASE, site(), [POST_NIEUW, POST_OUD], AP.siteOpenTracks('s1'));
  assert.equal(ob.totalItems, 3);
  assert.deepEqual(ob.orderedItems.map((c) => c.object.type), ['Note', 'Audio', 'Note'],
    'juni-post, maart-track, januari-post');
});

test('een gesloten track staat er niet in, en lekt ook zijn titel niet', () => {
  const ob = AP.buildOutbox(BASE, site(), [], AP.siteOpenTracks('s1'));
  assert.ok(!JSON.stringify(ob).includes('Achter de poort'));
  assert.ok(!JSON.stringify(ob).includes('dicht.mp3'));
});

test('zonder tracks-argument blijft de outbox precies zoals hij was', () => {
  // De bouwer haalt NIETS zelf op: dat is wat de blocked-tak in de route
  // beschermt. Zou hij dat wel doen, dan leverde hij dwars door een dichte
  // deur heen.
  const ob = AP.buildOutbox(BASE, site(), [POST_NIEUW]);
  assert.equal(ob.totalItems, 1);
  assert.equal(ob.orderedItems[0].object.type, 'Note');
});

test('de deur dicht: een lege outbox blijft leeg, ook met muziek in de kast', () => {
  const ob = AP.buildOutbox(BASE, site(), [], []);
  assert.equal(ob.totalItems, 0);
  assert.deepEqual(ob.orderedItems, []);
});
