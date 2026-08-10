// De badge: ongelezen per gesprek (shaer-frontend-3tx).
//
// Twee dingen liggen hier vast. Een COUNT en geen bijgehouden getal -- bij een
// verwijdering klopt het dan vanzelf weer, waar een teller zou blijven staan.
// En Read als GEBEURTENIS: markeren is optellend, dus een toestel dat een week
// uit stond kan je gelezen berichten niet terugzetten op ongelezen.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'kind', 'Kind', 'u1');

const OMA = 'https://elders/u/oma';
const OOM = 'https://elders/u/oom';
const arrived = (uri, from, stamp, wave = 0) => db.prepare(
  `INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, content, published, wave)
   VALUES ('kind', ?, ?, 'iemand', '<p>hoi</p>', ?, ?)`).run(uri, from, stamp, wave);

arrived('https://elders/n/1', OMA, '2026-08-01T10:00:00Z');
arrived('https://elders/n/2', OMA, '2026-08-01T11:00:00Z');
arrived('https://elders/n/3', OMA, '2026-08-01T12:00:00Z');
arrived('https://elders/n/w', OOM, '2026-08-01T09:00:00Z', 1);

test('alles is ongelezen tot je iets gelezen hebt', () => {
  const u = AP.unreadPerConversation('kind');
  assert.equal(u.get(OMA).n, 3);
  assert.equal(u.get(OOM).n, 1);
  // Een zwaai telt apart: dat is een zetje van een guardian, geen gesprek.
  assert.equal(u.get(OOM).wave, true);
  assert.equal(u.get(OMA).wave, false);
});

test('lezen tot het tweede bericht laat er een over', () => {
  AP.markRead('kind', 'https://elders/n/2');
  assert.equal(AP.unreadPerConversation('kind').get(OMA).n, 1);
  assert.equal(AP.unreadPerConversation('kind').get(OOM).n, 1, 'een ander gesprek raakt het niet');
});

test('een oud toestel kan gelezen berichten niet terugzetten', () => {
  // Precies het geval waar Read-als-gebeurtenis voor is: markeren is
  // optellend, dus dit doet niets.
  AP.markRead('kind', 'https://elders/n/1');
  assert.equal(AP.unreadPerConversation('kind').get(OMA).n, 1, 'nog steeds een');
});

test('alles gelezen is geen rij, niet een nul', () => {
  AP.markRead('kind', 'https://elders/n/3');
  assert.equal(AP.unreadPerConversation('kind').get(OMA), undefined);
});

test('een verwijdering laat het getal vanzelf kloppen', () => {
  // Waar een bijgehouden teller zou blijven staan: badge zegt 1, er is niets.
  arrived('https://elders/n/4', OMA, '2026-08-01T13:00:00Z');
  assert.equal(AP.unreadPerConversation('kind').get(OMA).n, 1);
  db.prepare("DELETE FROM ap_mentions WHERE object_uri = ?").run('https://elders/n/4');
  assert.equal(AP.unreadPerConversation('kind').get(OMA), undefined);
});

test('een onbekende note markeert niets, en dat is geen fout', () => {
  assert.equal(AP.markRead('kind', 'https://elders/n/bestaat-niet'), null);
});
