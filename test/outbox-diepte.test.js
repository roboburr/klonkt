// De outbox pagineert nu ECHT door (shaer-sk4).
//
// Er stond geen paginering maar een KAP: de route haalde twintig posts uit SQL
// en hield daar twintig items van over. Alles daarvoor was niet op een volgende
// pagina maar helemaal onbereikbaar.
//
// Posts en tracks vlechten op datum, dus een offset over die twee kan niet met
// twee losse queries -- je weet niet hoeveel van elk er in pagina drie horen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'dev', 'Dev', 'u1');

// 45 posts en 5 open tracks, met dagen ertussen zodat de volgorde vaststaat.
const dag = (n) => new Date(Date.UTC(2026, 0, 1, 12) + (n - 1) * 86400000).toISOString();
for (let i = 1; i <= 45; i++) {
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
              VALUES (?,?,?,?,?,?,'published',?)`)
    .run(`p${i}`, 's1', 'u1', `post-${i}`, `Post ${i}`, '<p>x</p>', dag(i));
}
const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, duration, media_id, fedi_open, created_at) VALUES (?,?,?,?,?,1,?)');
for (let i = 1; i <= 5; i++) {
  insM.run(`m${i}`, 's1', `t${i}.mp3`, `audio/t${i}.mp3`, 'audio/mpeg');
  insT.run(`t${i}`, 's1', `Track ${i}`, 100, `m${i}`, dag(20 + i));
}

test('de telling is het GEHEEL, niet de pagina', () => {
  const { totaal } = AP.outboxSlice('s1', { offset: 0, limit: 20 });
  assert.equal(totaal, 50, '45 posts + 5 tracks');
});

test('een pagina haalt uit BEIDE bronnen, gevlochten op datum', () => {
  // Pagina 2 valt precies over de tracks van dag 21..25 heen; met twee losse
  // queries en een offset per tabel zou dat niet kloppen.
  const p2 = AP.outboxSlice('s1', { offset: 20, limit: 20 });
  assert.equal(p2.posts.length + p2.tracks.length, 20);
  assert.ok(p2.tracks.length > 0, 'de tracks zitten midden in de reeks');
  assert.ok(p2.posts.length > 0);
});

test('opeenvolgende paginas overlappen niet en laten niets vallen', () => {
  const zie = new Set();
  let som = 0;
  for (let n = 1; n <= 3; n++) {
    const s = AP.outboxSlice('s1', { offset: (n - 1) * 20, limit: 20 });
    for (const p of s.posts) zie.add('p:' + p.id);
    for (const t of s.tracks) zie.add('t:' + t.id);
    som += s.posts.length + s.tracks.length;
  }
  assert.equal(som, 50, 'drie paginas dekken alles');
  assert.equal(zie.size, 50, 'en niets twee keer');
});

test('de laatste pagina is korter en de pagina erna is leeg', () => {
  assert.equal(AP.outboxSlice('s1', { offset: 40, limit: 20 }).posts.length
             + AP.outboxSlice('s1', { offset: 40, limit: 20 }).tracks.length, 10);
  const voorbij = AP.outboxSlice('s1', { offset: 60, limit: 20 });
  assert.equal(voorbij.posts.length + voorbij.tracks.length, 0);
});

test('de collectie biedt een next zolang er meer is', () => {
  const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const { posts, tracks, totaal } = AP.outboxSlice('s1', { offset: 0, limit: 20 });
  const ob = AP.buildOutbox('https://ons.test', site, posts, tracks, { page: 1, totalItems: totaal, alGesneden: true });
  assert.equal(ob.totalItems, 50);
  assert.equal(ob.orderedItems.length, 20);
  assert.equal(ob.next, 'https://ons.test/ap/users/dev/outbox?page=2',
    'zonder alGesneden zou een volle pagina zichzelf als de enige zien');
});

test('een fans-only post blijft buiten de telling van een vreemde', () => {
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at, fan_only)
              VALUES (?,?,?,?,?,?,'published',?,1)`)
    .run('geheim', 's1', 'u1', 'geheim', 'Geheim', '<p>x</p>', dag(28));
  assert.equal(AP.outboxSlice('s1', { fanOnly: false }).totaal, 50, 'een vreemde telt hem niet mee');
  assert.equal(AP.outboxSlice('s1', { fanOnly: true }).totaal, 51, 'een vriend wel');
});
