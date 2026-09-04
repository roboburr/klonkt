// Gemengde tijdstempels sorteren chronologisch (shaer-a937).
//
// Deze database draagt twee spellingen: '2026-08-06 09:02:01' van
// CURRENT_TIMESTAMP en '2026-08-06T02:08:01.000Z' van toISOString(). SQLite
// vergelijkt TEKST, en op positie 10 staat een 'T' (0x54) tegenover een spatie
// (0x20) -- dus binnen dezelfde dag wint de ISO-vorm altijd, hoe laat hij ook
// is. Gemeten op de live database van sound-fabrics: een antwoord van 02:08
// stond boven likes van 09:02 diezelfde dag, zichtbaar onder elke post met
// reacties EN likes.
//
// De toets zet de twee vormen bewust door elkaar met de ISO-rij VROEGER op de
// dag: precies de stand waarin een ongenormaliseerde sortering omvalt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');
db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
            VALUES ('p1','s1','u1','post','Post','<p>x</p>','published','2026-08-01T00:00:00Z')`).run();

// SQL-notatie om 09:02, ISO om 02:08 -- dezelfde dag. Chronologisch hoort de
// SQL-rij bovenaan; op tekst gesorteerd wint de ISO-rij.
const LAAT_SQL = '2026-08-06 09:02:01';
const VROEG_ISO = '2026-08-06T02:08:01.000Z';

const insI = db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, content, published, created_at)
                         VALUES (?,?,?,?,?,?,?,?)`);
insI.run('reply', 'p1', 'https://elders.example/n/vroeg', 'https://elders.example/u/a', 'A', '<p>vroeg</p>', VROEG_ISO, VROEG_ISO);
insI.run('reply', 'p1', 'https://elders.example/n/laat', 'https://elders.example/u/b', 'B', '<p>laat</p>', null, LAAT_SQL);

const insT = db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, content, published, created_at)
                         VALUES (?,?,?,?,?,?,?)`);
insT.run('https://elders.example/t/vroeg', 'kid', 'https://elders.example/u/a', 'A', '<p>vroeg</p>', VROEG_ISO, VROEG_ISO);
insT.run('https://elders.example/t/laat', 'kid', 'https://elders.example/u/b', 'B', '<p>laat</p>', null, LAAT_SQL);

const insM = db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, content, published, created_at)
                         VALUES (?,?,?,?,?,?,?)`);
insM.run('kid', 'https://elders.example/m/vroeg', 'https://elders.example/u/a', 'A', '<p>vroeg</p>', VROEG_ISO, VROEG_ISO);
insM.run('kid', 'https://elders.example/m/laat', 'https://elders.example/u/b', 'B', '<p>laat</p>', null, LAAT_SQL);

/** Het nieuwste eerst: hoort de LAAT-rij (09:02) te zijn, niet de ISO van 02:08. */
const nieuwsteIs = (rijen, veld, verwacht) => {
  assert.ok(rijen.length >= 2, 'beide rijen horen terug te komen');
  assert.match(String(rijen[0][veld]), verwacht,
    `de rij van 09:02 hoort bovenaan; kreeg ${rijen[0][veld]} -- dan sorteert de tekst en niet de tijd`);
};

test('de tijdlijn zet 09:02 boven 02:08, ook in twee spellingen', () => {
  nieuwsteIs(AP.getTimeline('kid', 10, 0), 'id', /laat/);
});

test('de reacties onder een post ook -- de fout die gemeten werd', () => {
  nieuwsteIs(AP.getReplyMessages('kid', 10), 'object_uri', /laat/);
});

test('en de berichten', () => {
  nieuwsteIs(AP.getDirectMessages('kid', 10), 'object_uri', /laat/);
});

test('een onleesbare stempel valt niet weg, en bederft de rest niet', () => {
  // strftime geeft NULL op iets dat het niet als tijd herkent; de COALESCE valt
  // dan terug op de rauwe waarde. WAAR die rij landt is onbepaald -- als tekst
  // staat 'geen datum' nu eenmaal boven '2026-...' -- en dat is de goede ruil:
  // data die je niet begrijpt bewaar je. Wat hier telt is dat de rij blijft
  // bestaan en dat de twee ECHTE spellingen onderling nog kloppen.
  insT.run('https://elders.example/t/kapot', 'kid', 'https://elders.example/u/c', 'C', '<p>kapot</p>', 'geen datum', 'geen datum');
  const rijen = AP.getTimeline('kid', 10, 0);
  assert.equal(rijen.length, 3, 'de rij met de onleesbare stempel valt niet weg');
  const ids = rijen.map((r) => r.id).filter((id) => !/kapot/.test(id));
  assert.match(ids[0], /laat/, 'onder de leesbare rijen staat 09:02 nog steeds boven 02:08');
});
