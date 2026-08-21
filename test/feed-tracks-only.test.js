// /tracks.xml -- de hele site als muziekkanaal (Robins vraag, 10-8).
//
// Hij vroeg naar een "hele site, open tracks"-library voor Funkwhale. Als
// AS2-object helpt dat daar niet: een Funkwhale-kanaal wijst nergens naar een
// library. Maar de vorm waarin Funkwhale een kanaal WEL uitgeeft is RSS met
// iTunes en een enclosure per item, en dat doet Klonkt al -- alleen droeg die
// feed ook gewone posts, en een muziekkanaal met blogberichten ertussen is er
// geen. Vandaar een tweede ingang op dezelfde bouwer.
//
// Per ITEM lezen en niet met een patroon over het hele document: dat laatste
// telt een titel in de kanaalkop net zo hard mee als een titel in een item, en
// dan meet de test iets anders dan hij beweert.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const feed = (await import('../src/routes/feed.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'zanger', 'zanger@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, excerpt, content, status, published_at)
            VALUES (?,?,?,?,?,?,?,'published',?)`)
  .run('p1', 's1', 'u1', 'een-blog', 'Een blogbericht', 'kort', '<p>x</p>', '2026-01-01T00:00:00Z');

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open, created_at) VALUES (?,?,?,?,?,?,?,?)');
insM.run('m1', 's1', 'open.mp3', 'audio/open.mp3', 'audio/mpeg', 4210688);
insM.run('m2', 's1', 'dicht.mp3', 'audio/dicht.mp3', 'audio/mpeg', 999);
insT.run('t1', 's1', 'Het open nummer', 'De Band', 203, 'm1', 1, '2026-03-01 12:00:00');
insT.run('t2', 's1', 'Achter de poort', 'De Band', 100, 'm2', 0, '2026-04-01 12:00:00');

const app = express();
app.use((req, res, next) => {
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  next();
});
app.use(feed);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const poort = server.address().port;
const haal = async (pad) => (await fetch(`http://127.0.0.1:${poort}${pad}`)).text();

/** Splitsen op <item>-grenzen en dan per item op tagniveau lezen, in plaats
 *  van een patroon over het hele document laten lopen: dat laatste telt een
 *  titel in de kop net zo hard mee als een titel in een item. */
function items(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
}
function tekst(blok, tag) {
  const m = blok.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

const muziek = await haal('/tracks.xml');
const alles = await haal('/feed.xml');

test('de muziekfeed draagt ALLEEN tracks, geen blogberichten', () => {
  const it = items(muziek);
  assert.equal(it.length, 1, 'een open track, en de post hoort er niet in');
  assert.equal(tekst(it[0], 'title'), 'Het open nummer');
  assert.ok(!muziek.includes('Een blogbericht'), 'de post staat er niet in');
});

test('en de gewone feed draagt ze allebei nog steeds', () => {
  const it = items(alles);
  assert.equal(it.length, 2, 'de sitefeed verandert niet: post en track');
  assert.ok(alles.includes('Een blogbericht'));
});

test('een gesloten track blijft ook hier weg -- dicht is dicht', () => {
  assert.ok(!muziek.includes('Achter de poort'));
  assert.ok(!muziek.includes('dicht.mp3'));
});

test('elke item heeft de enclosure die een podcast-lezer zoekt', () => {
  const enc = muziek.match(/<enclosure[^>]*>/g) || [];
  assert.equal(enc.length, 1);
  assert.match(enc[0], /url="[^"]*\/audio\/stream\/open\.mp3"/);
  assert.match(enc[0], /length="4210688"/);
  assert.match(enc[0], /type="audio\/mpeg"/);
});

test('de self-link wijst naar ZICHZELF en niet naar de sitefeed', () => {
  // Anders stuurt een lezer die de feed opnieuw ophaalt zichzelf naar de
  // gemengde variant, en staan de blogberichten er alsnog in.
  assert.match(muziek, /<atom:link href="[^"]*\/tracks\.xml" rel="self"/);
  assert.ok(!/<atom:link href="[^"]*\/feed\.xml" rel="self"/.test(muziek));
  assert.match(alles, /<atom:link href="[^"]*\/feed\.xml" rel="self"/);
});

test('en hij heet anders, want twee gelijknamige feeds zijn niet te scheiden', () => {
  assert.ok(muziek.includes('De Band — muziek'));
  assert.ok(alles.includes('<title>De Band</title>'));
});

test('de iTunes-categorie staat er, want er is echt muziek', () => {
  assert.match(muziek, /<itunes:category text="Music" \/>/);
  assert.match(muziek, /<itunes:duration>203<\/itunes:duration>/);
});

test.after(() => server.close());
