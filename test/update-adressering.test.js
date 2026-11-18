// Een Update is geadresseerd zoals de Note erin (shaer-otwu).
//
// deliverUpdate zette hard to: [Public] op de activiteit, ook als de Note een
// vriendenpost was. Bezorgd werd alleen aan de volgers, maar de envelop zei
// "openbaar" -- en een relay die volgt stuurt alles met Public verder.
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
// De volger-inbox mag door de SSRF-poort zonder DNS; de fetch zelf is gestubd.
process.env.AP_ALLOW_HOSTS = 'volger.example';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const VOLGERS = 'https://klonkt.test/ap/users/ik/followers';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'ik', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)').run('ik', 'https://volger.example/users/v', 'https://volger.example/inbox');
const site = db.prepare("SELECT * FROM sites WHERE slug = 'ik'").get();

const bezorgd = [];
const echt = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if ((opts.method || 'GET') === 'POST') bezorgd.push(JSON.parse(opts.body));
  return new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } });
};
after(() => { globalThis.fetch = echt; });

// deliverUpdate wacht de bezorging zelf niet af.
const update = async (post) => {
  bezorgd.length = 0;
  await AP.deliverUpdate(site, { slug: 'n-' + post.id, content: '<p>bewerkt</p>', published_at: '2026-11-02T00:00:00Z', ...post });
  for (let i = 0; i < 50 && !bezorgd.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(bezorgd.length, 1, 'precies een bezorging aan de volger');
  return bezorgd[0];
};
const overal = (a) => [...(a.to || []), ...(a.cc || [])];

test('een vriendenpost: de Update noemt nergens Public', async () => {
  const u = await update({ id: 'p-vriend', fan_only: 1, ap_visibility: 'friends' });
  assert.equal(u.type, 'Update');
  assert.ok(!overal(u).includes(PUBLIC), `envelop: ${JSON.stringify({ to: u.to, cc: u.cc })}`);
  assert.ok(!overal(u.object).includes(PUBLIC), 'en de Note ook niet');
  assert.deepEqual(u.to, [VOLGERS]);
});

test('envelop en brief zijn gelijk geadresseerd, voor elke zichtbaarheid', async () => {
  for (const post of [
    { id: 'p-open', fan_only: 0, ap_visibility: 'public' },
    { id: 'p-stil', fan_only: 0, ap_visibility: 'quiet' },
    { id: 'p-vriend2', fan_only: 1, ap_visibility: 'friends' },
  ]) {
    const u = await update(post);
    assert.deepEqual(u.to, u.object.to, `${post.id}: to`);
    assert.deepEqual(u.cc, u.object.cc, `${post.id}: cc`);
    assert.equal(AP.noteVisibility(u), AP.noteVisibility(u.object), `${post.id}: zichtbaarheid`);
  }
});

test('een openbare post blijft gewoon openbaar', async () => {
  const u = await update({ id: 'p-open2', fan_only: 0, ap_visibility: 'public' });
  assert.ok(u.to.includes(PUBLIC));
});
