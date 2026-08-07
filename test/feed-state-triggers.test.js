// De feed-wekkers mogen alleen op echte inhoud afgaan.
//
// ap_interactions draagt naast replies ook likes en announces, en die schrijven een
// LEGE object_uri. Zonder een WHEN op kind bumpte elke inkomende like de rev, werd
// elke long-poll-wachter gewekt, en kreeg die de hele collectie opnieuw terwijl er
// niets aan veranderd was: precies de kosten die de 304 moest wegnemen. Bovendien
// belandde er een rij op de lege string in ap_feed_state, die feedChangesSince
// vervolgens als sleutel uitdeelt.
//
// Bij ap_timeline is hier wel op gelet (de UPDATE OF sluit liked en boosted uit).
// Deze test legt vast dat het bij ap_interactions ook zo blijft.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

const mod = await import('../src/config/database.js');
const db = mod.default;

before(() => {
  const stil = console.log;
  console.log = () => {};          // het schema-initialisatielogboek is hier ruis
  try { mod.initializeDatabase(); } finally { console.log = stil; }

  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'u1', 'u1@test', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'me', 'Mijn site', 'u1');
  db.prepare('INSERT INTO posts (id, site_id, slug, author_id, title, content, status) VALUES (?,?,?,?,?,?,?)')
    .run('p1', 's1', 't', 'u1', 'T', 'C', 'published');
});

const rev = () => db.prepare('SELECT n FROM ap_feed_rev').get().n;
const sleutels = () => db.prepare('SELECT object_uri FROM ap_feed_state').all().map((r) => r.object_uri);
const voegToe = (kind, uri) => db
  .prepare('INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri) VALUES (?,?,?,?)')
  .run(kind, 'p1', uri, `https://elders.example/${kind}`);

test('een like wekt geen wachters', () => {
  const voor = rev();
  voegToe('like', '');
  assert.equal(rev(), voor, 'een like verandert de collectie niet, dus hoeft niemand te worden gewekt');
});

test('een boost wekt geen wachters', () => {
  const voor = rev();
  voegToe('announce', '');
  assert.equal(rev(), voor);
});

test('er staat nooit een rij op de lege sleutel', () => {
  assert.ok(!sleutels().includes(''), 'een lege object_uri als sleutel wordt door feedChangesSince uitgedeeld');
});

test('een reply wekt de wachters wel', () => {
  const voor = rev();
  voegToe('reply', 'https://elders.example/note/9');
  assert.equal(rev(), voor + 1);
  assert.ok(sleutels().includes('https://elders.example/note/9'));
});

test('een verdwenen reply wekt de wachters ook', () => {
  const voor = rev();
  db.prepare("DELETE FROM ap_interactions WHERE kind = 'reply'").run();
  assert.equal(rev(), voor + 1, 'anders blijft een verwijderd antwoord bij de client staan');
});

test('de permalink-lookup van reacties gebruikt een index', () => {
  // canonicalReactionUri zoekt op (slug, url). Viel dat terug op idx_ap_timeline_slug,
  // dan was het een scan van elke rij van die slug, per reactie, en de reactie-migratie
  // erfde dat in haar re-key-join die synchroon voor listen draait.
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM ap_timeline WHERE slug=? AND url=?')
    .all('x', 'y').map((r) => r.detail).join(' ');
  assert.match(plan, /USING INDEX idx_ap_timeline_url/, `verwachtte de url-index, kreeg: ${plan}`);
  assert.doesNotMatch(plan, /SCAN ap_timeline/);
});
