// Wie krijgt een post voor alleen de mensen erin, en wie een DM (shaer-ypug).
//
// De outbox voor een 'friend' liet het fan_only-filter weg, en een direct-post
// heeft ook fan_only -- dus elke volger (en guardian) las hem mee. En
// /ap/notes/:id gaf elke rij uit ap_outbox aan iedereen, ongetekend: een DM of
// een 🛟-hulpvraag was te lezen voor wie het id had. De regels nu:
//
//   - een direct-post: de eigen app en de verhuisbestemming (die IS de maker),
//     verder niemand -- en hij is niet meer als vriendenpost geadresseerd;
//   - een DM: alleen wie hem kreeg, ondertekend; in de outbox en als losse note;
//   - een vriendenantwoord: de ouder-auteur en de volgers;
//   - een bewerking van een direct-post gaat niet naar de volgers.
//
// Ondertekenen wordt hier gestubd (AP.verifyRequest), zoals in de andere
// AP-tests: wat hier getoetst wordt is wat de route met een geverifieerde actor
// DOET, niet de handtekening zelf (die heeft signature-verification.test.js).
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
// De volger-inbox mag door de SSRF-poort zonder DNS; de fetch zelf is gestubd.
process.env.AP_ALLOW_HOSTS = 'volger.example';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;

const VOLGER = 'https://volger.example/users/v';
const OMA = 'https://elders.example/users/oma';
const OPA = 'https://elders.example/users/opa';
const OUDER = 'https://ouder.example/users/schrijver';
const DOEL = 'https://nieuw.example/ap/users/ik';
const VREEMDE = 'https://vreemd.example/users/x';

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'ik', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
const token = 'test-token-outbox-direct-' + 'c'.repeat(24);
db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
  .run(crypto.createHash('sha256').update(token).digest('base64url'), 'shaer', 'u1', 'ik', 'c2s');
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)').run('ik', VOLGER, 'https://volger.example/inbox');

const zetPost = db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, fan_only, ap_visibility, published_at)
  VALUES (?, 's1', ?, 'u1', '', ?, 'published', 'post', ?, ?, ?)`);
zetPost.run('p-open', 'n-open', '<p>openbaar</p>', 0, 'public', '2026-11-01T00:00:00Z');
zetPost.run('p-vriend', 'n-vriend', '<p>vrienden</p>', 1, 'friends', '2026-11-02T00:00:00Z');
zetPost.run('p-direct', 'n-direct', '<p>alleen erin</p>', 1, 'direct', '2026-11-03T00:00:00Z');

const zetSent = db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, visibility, to_actors, help_request, created_at)
  VALUES (@id, 'ik', '', NULL, @in_reply_to, @to_actor, NULL, @content, @visibility, @to_actors, @help, @created_at)`);
const sent = (r) => zetSent.run({ in_reply_to: null, to_actor: null, visibility: null, to_actors: null, help: null, created_at: '2026-11-10 10:00:00', ...r });
sent({ id: 'dm-oma', content: '<p>Hulp nodig</p>', visibility: 'direct', to_actors: JSON.stringify([OMA]), help: 1, created_at: '2026-11-04 10:00:00' });
sent({ id: 'dm-opa', content: '<p>Voor opa</p>', visibility: 'direct', to_actors: JSON.stringify([OPA]), created_at: '2026-11-05 10:00:00' });
sent({ id: 'r-vriend', content: '<p>antwoord voor vrienden</p>', visibility: 'friends', to_actor: OUDER, in_reply_to: 'https://ouder.example/notes/1' });
sent({ id: 'r-open', content: '<p>gewoon antwoord</p>', to_actor: OUDER, in_reply_to: 'https://ouder.example/notes/2' });

// "Ondertekend als X": de keyId zegt wie, de stub gelooft hem.
AP.verifyRequest = async (req) => {
  const m = String(req.headers.signature || '').match(/keyId="([^"#]+)/);
  return m ? { id: m[1] } : null;
};
const als = (actor) => ({ Signature: `keyId="${actor}#main-key",signature="x"` });
const BEARER = { Authorization: `Bearer ${token}` };

const express = (await import('express')).default;
const app = express();
app.use((await import('../src/routes/activitypub.js')).default);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
server.unref();
after(() => server.close());

const get = (pad, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${pad}`,
  { headers: { Accept: 'application/activity+json', ...headers }, redirect: 'manual' });
const outbox = async (headers = {}) => {
  const r = await get('/ap/users/ik/outbox', headers);
  assert.equal(r.status, 200);
  const body = await r.json();
  const items = body.orderedItems || (body.first && body.first.orderedItems) || [];
  return { ids: items.map((i) => String(i.object && i.object.id || '').split('/').pop()), items, cache: r.headers.get('cache-control') || '' };
};

test('ongetekend: alleen het openbare', async () => {
  const { ids } = await outbox();
  assert.deepEqual(ids, ['p-open']);
});

test('een volger krijgt de vriendenpost, niet de direct-post en geen DM', async () => {
  const { ids } = await outbox(als(VOLGER));
  assert.ok(ids.includes('p-vriend'));
  assert.ok(!ids.includes('p-direct'), 'een volger is geen deelnemer');
  assert.ok(!ids.some((i) => i.startsWith('dm-')));
});

test('wie een DM kreeg, vindt hem in de outbox -- alleen de zijne', async () => {
  const { ids, cache } = await outbox(als(OMA));
  assert.ok(ids.includes('dm-oma'));
  assert.ok(!ids.includes('dm-opa'), 'niet die van een ander');
  assert.ok(!ids.includes('p-vriend') && !ids.includes('p-direct'), 'en verder niets wat hij niet al mocht');
  assert.match(cache, /private/, 'een persoonlijke outbox hoort in geen gedeelde cache');
});

test('de eigen app krijgt ook de direct-post, maar geen DM in zijn feed', async () => {
  const { ids } = await outbox(BEARER);
  assert.ok(ids.includes('p-vriend') && ids.includes('p-direct'));
  assert.ok(!ids.some((i) => i.startsWith('dm-')), 'de berichten hebben hun eigen plek');
});

test('de verhuisbestemming krijgt de direct-post, geadresseerd als direct', async () => {
  db.prepare('UPDATE sites SET moved_to = ? WHERE slug = ?').run(DOEL, 'ik');
  try {
    const { ids, items } = await outbox(als(DOEL));
    assert.ok(ids.includes('p-direct'));
    const n = items.find((i) => i.object.id.endsWith('/p-direct')).object;
    assert.ok(!n.to.includes(PUBLIC) && !(n.cc || []).includes(PUBLIC), 'niet openbaar');
    assert.ok(![...n.to, ...(n.cc || [])].some((u) => /\/followers$/.test(u)), 'en niet aan de volgers');
    assert.equal(AP.noteVisibility(n), 'direct', 'zodat de andere kant hem als direct binnenhaalt');
    assert.equal((await get('/ap/notes/p-direct', als(DOEL))).status, 200, 'ook als losse note');
  } finally {
    db.prepare('UPDATE sites SET moved_to = NULL WHERE slug = ?').run('ik');
  }
  assert.equal((await get('/ap/notes/p-direct', als(VOLGER))).status, 404);
  assert.equal((await get('/ap/notes/p-direct')).status, 404);
});

test('een DM als losse note: alleen voor wie hem kreeg, en voor de eigen app', async () => {
  assert.equal((await get('/ap/notes/dm-oma')).status, 404, 'ongetekend');
  assert.equal((await get('/ap/notes/dm-oma', { Accept: 'text/html' })).status, 404, 'ook geen doorverwijzing voor een browser');
  assert.equal((await get('/ap/notes/dm-oma', als(OPA))).status, 404, 'een ander');
  assert.equal((await get('/ap/notes/dm-oma', als(VOLGER))).status, 404, 'een volger');
  const oma = await get('/ap/notes/dm-oma', als(OMA));
  assert.equal(oma.status, 200);
  assert.match((await oma.json()).content, /Hulp nodig/);
  assert.equal((await get('/ap/notes/dm-oma', BEARER)).status, 200);
});

test('een vriendenantwoord: de ouder-auteur en de volgers; een gewoon antwoord: iedereen', async () => {
  assert.equal((await get('/ap/notes/r-vriend')).status, 404);
  assert.equal((await get('/ap/notes/r-vriend', als(VREEMDE))).status, 404);
  assert.equal((await get('/ap/notes/r-vriend', als(OUDER))).status, 200);
  assert.equal((await get('/ap/notes/r-vriend', als(VOLGER))).status, 200);
  assert.equal((await get('/ap/notes/r-open')).status, 200);
});

test('mayReadSentNote: de matrix', () => {
  const rij = (r) => ({ site_slug: 'ik', to_actor: null, to_actors: null, visibility: null, ...r });
  assert.equal(AP.mayReadSentNote(rij({}), null), true);
  assert.equal(AP.mayReadSentNote(rij({ visibility: 'direct', to_actors: JSON.stringify([OMA]) }), OMA), true);
  assert.equal(AP.mayReadSentNote(rij({ visibility: 'direct', to_actors: JSON.stringify([OMA]) }), null), false);
  assert.equal(AP.mayReadSentNote(rij({ visibility: 'direct', to_actors: 'geen json' }), OMA), false);
  assert.equal(AP.mayReadSentNote(rij({ visibility: 'direct', to_actor: OMA }), OMA), true);
  assert.equal(AP.mayReadSentNote(rij({ visibility: 'friends', to_actor: OUDER }), VOLGER), true);
  assert.equal(AP.mayReadSentNote(rij({ visibility: 'friends', to_actor: OUDER }), VREEMDE), false);
});

test('een bewerking van een direct-post gaat niet naar de volgers', async () => {
  // Wat de web-editor doorgeeft: zijn eigen object, zonder ap_visibility.
  const posts = [];
  const echt = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') posts.push(String(url));
    return new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const site = db.prepare("SELECT * FROM sites WHERE slug = 'ik'").get();
    // De bezorging zelf wordt niet afgewacht door deliverUpdate; even laten lopen.
    const even = async () => { for (let i = 0; i < 50 && !posts.length; i++) await new Promise((r) => setTimeout(r, 20)); };
    await AP.deliverUpdate(site, { id: 'p-direct', slug: 'n-direct', content: '<p>bewerkt</p>', fan_only: 1, published_at: '2026-11-03T00:00:00Z' });
    await AP.deliverCreate(site, { id: 'p-direct', slug: 'n-direct', content: '<p>bewerkt</p>', fan_only: 1, published_at: '2026-11-03T00:00:00Z' });
    await even();
    assert.deepEqual(posts, [], 'geen enkele inbox');
    // Tegenproef: een vriendenpost gaat wel naar de volger. Anders zou de
    // test hierboven ook groen zijn als er nooit iets bezorgd werd.
    await AP.deliverUpdate(site, { id: 'p-vriend', slug: 'n-vriend', content: '<p>bewerkt</p>', fan_only: 1, published_at: '2026-11-02T00:00:00Z' });
    await even();
    assert.ok(posts.some((u) => u.startsWith('https://volger.example/')), `bezorgd: ${posts.join(', ') || 'niets'}`);
  } finally {
    globalThis.fetch = echt;
  }
});
