// Ouder dan wat je hebt (shaer-ewrt).
//
// De inbox-lezing gaf vier poten van de nieuwste zestig en daaronder niets: een
// 'load more' in de app had geen adres. Deze toetsen leggen vast dat er nu een
// weg naar beneden is, dat die over ALLE poten samen loopt (een pagina is
// compleet voor zijn periode), dat er niets dubbel komt of tussenuit valt --
// ook niet bij berichten in dezelfde seconde -- en dat de volle lezing verder
// niet verandert.
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
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'lezer', 'Lezer', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'stil', 'Stil', 'u1');

// Een minuut per stap terug vanaf het middaguur, zodat de volgorde vastligt.
const stempel = (min) => new Date(Date.UTC(2026, 9, 1, 12, 0) - min * 60_000).toISOString();
const post = (id, min, slug = 'lezer') => db.prepare(
  `INSERT INTO ap_timeline (id, slug, author_uri, author_name, author_handle, content, published)
   VALUES (?, ?, 'https://elders/u/til', 'Til', '@til@elders', '<p>post</p>', ?)`).run(id, slug, stempel(min));
const bericht = (uri, min) => db.prepare(
  `INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, content, published)
   VALUES ('lezer', ?, 'https://elders/u/oma', 'Oma', '<p>hoi</p>', ?)`).run(uri, stempel(min));
// Zoals SQLite's CURRENT_TIMESTAMP het schrijft: met een spatie en zonder Z.
// De unie moet die vorm naast de ISO-vorm van de andere poten goed sorteren.
const verstuurd = (id, min) => db.prepare(
  `INSERT INTO ap_outbox (id, site_slug, post_id, to_actor, to_actors, content, visibility, created_at)
   VALUES (?, 'lezer', 'p1', 'https://elders/u/oma', ?, '<p>terug</p>', 'direct', ?)`)
  .run(id, JSON.stringify(['https://elders/u/oma']), stempel(min).replace('T', ' ').replace(/\.\d+Z$/, ''));

// 90 posts, om de drie minuten een bericht, om de vijf een eigen antwoord.
for (let i = 0; i < 90; i++) post(`https://elders/n/${i}`, i * 2);
for (let i = 0; i < 40; i++) bericht(`https://elders/m/${i}`, i * 3 + 1);
for (let i = 0; i < 30; i++) verstuurd(`mijn-${i}`, i * 5 + 2);
// Drie in DEZELFDE seconde, precies op een plek waar een paginagrens kan
// vallen. Met 'stamp < before' zouden die stil overgeslagen worden.
for (const x of ['a', 'b', 'c']) post(`https://elders/n/zelfde-${x}`, 61);
const ALLES = 90 + 40 + 30 + 3;

const crypto = await import('crypto');
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const tokens = {};
for (const slug of ['lezer', 'stil']) {
  tokens[slug] = `test-token-${slug}-` + 'f'.repeat(24);
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(tokens[slug]).digest('base64url'), 'c', 'u1', slug, 'read write');
}
const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const poort = server.address().port;
server.unref();

const haal = async (url, slug = 'lezer') => {
  const r = await fetch(url.replace('https://klonkt.test', `http://127.0.0.1:${poort}`),
    { headers: { Authorization: `Bearer ${tokens[slug]}` } });
  assert.equal(r.status, 200, `${url} gaf ${r.status}`);
  return r.json();
};
const wortel = (slug = 'lezer') => haal(`http://127.0.0.1:${poort}/ap/users/${slug}/inbox`, slug);
const idVan = (item) => (item.object && item.object.id) || item.id;

test('de pagina\'s lopen over alle poten samen, zonder gat en zonder dubbel', () => {
  const gezien = [];
  let before = null;
  for (let ronde = 0; ronde < 20; ronde++) {
    const p = AP.inboxPage('lezer', { before, limit: 25 });
    gezien.push(...p.rows);
    if (!p.more) break;
    before = p.oldest;
  }
  assert.equal(gezien.length, ALLES, 'elke rij precies een keer');
  assert.equal(new Set(gezien.map((r) => `${r.leg}|${r.ref}`)).size, ALLES, 'niets dubbel');
  for (let i = 1; i < gezien.length; i++) {
    assert.ok(gezien[i - 1].stamp >= gezien[i].stamp, `aflopend op ${i}: ${gezien[i - 1].stamp} vóór ${gezien[i].stamp}`);
  }
  // De poten zijn door elkaar gevlochten, niet achter elkaar geplakt.
  const eerste25 = new Set(gezien.slice(0, 25).map((r) => r.leg));
  assert.deepEqual([...eerste25].sort(), ['message', 'sent', 'timeline']);
  // De drie van dezelfde seconde zijn er alle drie.
  assert.equal(gezien.filter((r) => r.ref.includes('zelfde-')).length, 3);
});

test('de wortel blijft wat hij was, met een next erbij', async () => {
  const w = await wortel();
  assert.equal(w.type, 'OrderedCollection', 'de app leest een Page als verschil; dit mag geen Page worden');
  assert.equal(w.first, undefined, 'geen first: dan zou een paginalezer de hele inbox opnieuw doorlopen');
  assert.ok(w['shaer:cursor'], 'de wachtlus heeft zijn cursor nog');
  // Per poot de nieuwste zestig, zoals altijd: 60 posts + 40 berichten + 30 eigen.
  assert.equal(w.orderedItems.length, 60 + 40 + 30);
  assert.ok(w.next && w.next.includes('/inbox?before='), 'en de weg naar beneden');
});

test('next volgen geeft het oudere, als pagina, tot hij op is', async () => {
  const w = await wortel();
  const ids = new Set(w.orderedItems.map(idVan));
  let url = w.next;
  let paginas = 0;
  let nieuw = 0;
  let vorigeOudste = null;
  while (url && paginas < 10) {
    const p = await haal(url);
    paginas++;
    assert.equal(p.type, 'OrderedCollectionPage');
    assert.ok(p.partOf.endsWith('/ap/users/lezer/inbox'));
    assert.equal(p.id, url, 'de pagina noemt zichzelf zoals je hem vroeg');
    // Ouder dan de vorige pagina, nooit nieuwer.
    const stempels = p.orderedItems.map((x) => x.published).filter(Boolean);
    if (vorigeOudste) assert.ok(stempels.every((s) => Date.parse(s) <= Date.parse(vorigeOudste)));
    vorigeOudste = stempels.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b), stempels[0]);
    for (const it of p.orderedItems) if (!ids.has(idVan(it))) { ids.add(idVan(it)); nieuw++; }
    url = p.next;
  }
  assert.equal(url, undefined, 'de laatste pagina heeft geen next');
  // Wat de wortel niet had: de dertig oudste posts (en de drie van dezelfde
  // seconde, die daar tussen zitten).
  assert.equal(nieuw, ALLES - (60 + 40 + 30));
  assert.ok(ids.has('https://elders/n/89'), 'de allereerste post is bereikbaar');
});

test('de kaarten op een pagina hebben dezelfde vorm als in de volle lezing', async () => {
  const w = await wortel();
  const p = await haal(w.next);
  const kaart = p.orderedItems.find((x) => x.object && x.object.id && x.object.id.startsWith('https://elders/n/'));
  assert.ok(kaart, 'er staat een post op');
  assert.equal(kaart.type, 'Create');
  assert.equal(kaart.object.attributedTo.name, 'Til', 'met byline, net als bovenin');
  const eigen = p.orderedItems.find((x) => String(x.id).endsWith('#create') && x.actor && x.actor.endsWith('/lezer'));
  if (eigen) assert.ok(eigen.object.attributedTo, 'een eigen antwoord draagt de eigen byline');
});

test('een kleine inbox heeft geen next', async () => {
  post('https://elders/n/stil-1', 1, 'stil');
  const w = await wortel('stil');
  assert.equal(w.orderedItems.length, 1);
  assert.equal(w.next, undefined, 'niets ouder, dus geen knop');
});

test('limit reist mee in next', async () => {
  const p = await haal(`http://127.0.0.1:${poort}/ap/users/lezer/inbox?before=${encodeURIComponent(AP.inboxPage('lezer', { limit: 10 }).oldest)}&limit=10`);
  assert.equal(p.orderedItems.length, 10);
  assert.ok(p.next.endsWith('&limit=10'), 'anders wordt de tweede pagina stilletjes de standaard');
});

// ── Een greep uit je geschiedenis (inbox-zero) ─────────────────────────────

test('een willekeurige pagina begint bij een post, en loopt van daar gewoon door', () => {
  // Alle tijdlijnrijen op volgorde, zoals de unie ze ziet.
  const posts = AP.inboxPage('lezer', { limit: 500 }).rows.filter((r) => r.leg === 'timeline');
  for (const k of [0, 1, 40, posts.length - 1]) {
    const p = AP.inboxRandomPage('lezer', { limit: 10, rnd: () => k / posts.length });
    const eerstePost = p.rows.find((r) => r.leg === 'timeline');
    assert.equal(eerstePost.ref, posts[k].ref, `anker ${k} is de eerste post van de pagina`);
    // En het is een echte pagina: met zijn start opnieuw gevraagd geeft hij hetzelfde.
    if (p.start) assert.deepEqual(AP.inboxPage('lezer', { before: p.start, limit: 10 }).rows, p.rows);
  }
  // Een lege geschiedenis is geen fout.
  assert.deepEqual(AP.inboxRandomPage('niemand', { limit: 10 }).rows, []);
});

test('?random=1 geeft een pagina die zichzelf naar zijn echte begin noemt', async () => {
  for (let i = 0; i < 5; i++) {
    const p = await haal(`http://127.0.0.1:${poort}/ap/users/lezer/inbox?random=1&limit=15`);
    assert.equal(p.type, 'OrderedCollectionPage');
    assert.ok(p.partOf.endsWith('/ap/users/lezer/inbox'));
    assert.ok(p.orderedItems.length > 0);
    assert.ok(p.orderedItems.some((x) => x.object && String(x.object.id).startsWith('https://elders/n/')), 'er zit een post in');
    if (p.id.includes('?before=')) {
      const zelfde = await haal(p.id);
      assert.deepEqual(zelfde.orderedItems.map(idVan), p.orderedItems.map(idVan), 'het id is een adres, niet een toevalstreffer');
      assert.ok(p.id.endsWith('&limit=15'));
    }
  }
});
