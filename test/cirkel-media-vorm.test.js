// /cirkel viel om op een media_json die geldig JSON was maar geen array.
//
// Gevonden op 14 augustus 2026: boiert.eu gaf 500 op /cirkel terwijl de
// voorpagina het deed. Van buitenaf uitgebinaird over ?offset= -- rij 19 van de
// eerste 72 brak het -- en de stacktrace bevestigde het:
//
//     TypeError: safeJson(...).map is not a function
//         at coverMedia (src/routes/circle.js:25)
//
// Een remote server stuurde media_json = "[]": een STRING met daarin `[]`.
// JSON.parse geeft dan een string terug, en een string heeft geen .map. De
// catch ving alleen KAPOTTE json, niet geldige json van het verkeerde type.
//
// Exact dezelfde fout stond al beschreven in views/partials/note-body.ejs, waar
// drie vreemde notes de Krant meenamen. Die les was hier nooit toegepast.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const circle = (await import('../src/routes/circle.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'dev', 'Dev', 'u1');

// Een post in de cirkel met precies de vorm die het omver haalde.
const zet = (id, media) => {
  db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, content, url, published, media_json)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'dev', 'https://elders.test/u/a', 'Iemand', '<p><strong>Titel</strong></p>',
         'https://elders.test/n/' + id, '2026-08-13T12:00:00Z', media);
  db.prepare(`INSERT INTO ap_my_reactions (site_slug, target_uri, kind) VALUES (?,?,'boost')`)
    .run('dev', id);
};

const app = express();
app.use((req, res, next) => {
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  next();
});
app.use(circle);
app.use((req, res) => res.status(404).end());
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const poort = server.address().port;
const haal = async (pad) => (await fetch(`http://127.0.0.1:${poort}${pad}`)).status;

test('media_json als STRING met [] erin sloopte de pagina', async () => {
  zet('n-string', '"[]"');
  assert.equal(await haal('/cirkel'), 200, 'geen 500 meer');
  assert.equal(await haal('/cirkel?append=1'), 200, 'ook niet op het append-pad');
});

test('en de andere vormen die geen array zijn ook niet', async () => {
  // Geldig JSON, verkeerd type: een object, een getal, een kale string, null.
  zet('n-obj', '{"url":"https://x/y.jpg"}');
  zet('n-num', '42');
  zet('n-str', '"gewoon tekst"');
  zet('n-null', 'null');
  assert.equal(await haal('/cirkel'), 200);
});

test('een ECHTE array werkt nog gewoon', async () => {
  zet('n-goed', JSON.stringify([{ url: 'https://elders.test/p.jpg', type: 'image/jpeg' }]));
  assert.equal(await haal('/cirkel'), 200);
});

test('en kapotte json blijft ook afgevangen', async () => {
  zet('n-kapot', '{niet eens json');
  assert.equal(await haal('/cirkel'), 200);
});

test.after(() => server.close());
