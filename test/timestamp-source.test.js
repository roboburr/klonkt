// De BRON schrijft nog maar een spelling, en wat er al stond is omgezet
// (shaer-a937, de duurzame helft).
//
// De leeskant wikkelt inmiddels alles in isoSql, dus een gemengde kolom sorteert
// toch goed. Dat is het vangnet, niet de oplossing: zolang er twee vormen
// binnenkomen blijft elke NIEUWE query die iemand schrijft een kans om het
// opnieuw fout te doen. Deze toets bewaakt dat er niets nieuws bijkomt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

test('een rij die de APP wegschrijft draagt ISO', async () => {
  // Door de echte schrijfweg (tlStmts), niet met een eigen INSERT: een toets
  // die zijn eigen ISO invoegt bewijst alleen dat de kolom tekst opslaat, en
  // kan per definitie niet falen op wat hier veranderd is.
  const AP = (await import('../src/services/ActivityPubService.js')).default;
  AP.upsertBoostedNote('kid', {
    object_uri: 'https://a.example/n/vers', actor_uri: 'https://a.example/u',
    actor_name: 'A', content: '<p>vers</p>', media: '[]',
  });
  const r = db.prepare("SELECT created_at FROM ap_timeline WHERE id = 'https://a.example/n/vers'").get();
  assert.ok(r, 'de rij hoort er te zijn');
  assert.match(r.created_at, ISO, 'een verse rij hoort ISO te dragen, niet de SQL-notatie');
});

test('geen enkele schrijfweg naar die tabellen schrijft nog CURRENT_TIMESTAMP', async () => {
  // Op de BRON getoetst en niet op gedrag: de fout is dat iemand later een
  // INSERT toevoegt met de oude vorm, en dat merk je pas als de volgorde in de
  // app scheef staat. De tabellen hieronder zijn degene waar de menging in zat.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const wortel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

  const bestanden = [];
  (function loop(map) {
    for (const naam of fs.readdirSync(map, { withFileTypes: true })) {
      const p = path.join(map, naam.name);
      if (naam.isDirectory()) loop(p);
      else if (naam.name.endsWith('.js')) bestanden.push(p);
    }
  })(wortel);

  const TABELLEN = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(ap_timeline|ap_mentions|ap_interactions|ap_outbox)\b/i;
  const fout = [];
  for (const p of bestanden) {
    if (p.endsWith(path.join('config', 'database.js'))) continue;   // daar staat het schema zelf
    const bron = fs.readFileSync(p, 'utf8');
    // Per statement kijken: een bestand mag elders best CURRENT_TIMESTAMP
    // gebruiken voor een tabel die hier niet over gaat.
    for (const stuk of bron.split(/db\.prepare\(/)) {
      if (TABELLEN.test(stuk) && /CURRENT_TIMESTAMP/.test(stuk.split(')')[0] + stuk.slice(0, 600))) {
        fout.push(path.relative(wortel, p));
      }
    }
  }
  assert.deepEqual([...new Set(fout)], [],
    'schrijf hier strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\'), anders komt de menging terug');
});

test('de migratie zet oude SQL-rijen om en laat de rest met rust', () => {
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, content, created_at)
              VALUES ('reply','p1','https://a.example/n/oud','https://a.example/u','<p>oud</p>','2026-08-06 09:02:01')`).run();
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, content, created_at)
              VALUES ('reply','p1','https://a.example/n/iso','https://a.example/u','<p>iso</p>','2026-08-06T02:08:01.000Z')`).run();
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, content, created_at)
              VALUES ('reply','p1','https://a.example/n/raar','https://a.example/u','<p>raar</p>','geen datum')`).run();

  { const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }

  const lees = (uri) => db.prepare('SELECT created_at FROM ap_interactions WHERE object_uri = ?').get(uri).created_at;
  assert.equal(lees('https://a.example/n/oud'), '2026-08-06T09:02:01Z', 'de SQL-vorm is omgezet');
  assert.equal(lees('https://a.example/n/iso'), '2026-08-06T02:08:01.000Z', 'een ISO-stempel blijft ongemoeid');
  assert.equal(lees('https://a.example/n/raar'), 'geen datum', 'een onleesbare stempel wordt niet weggegooid');

  // Idempotent: nog een keer draaien verandert niets meer.
  { const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
  assert.equal(lees('https://a.example/n/oud'), '2026-08-06T09:02:01Z', 'tweede keer draaien laat het staan');
});
