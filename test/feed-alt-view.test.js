// De tweede weergave van een site: Lezen, Tijdlijn, of allebei (mobiel/desktop).
//
// Tijdlijn was geen KEUZE meer sinds Lezen hem verving, maar de renderkant is
// nooit weggehaald: home.ejs stuurt alle drie de secties mee en de CSS kiest op
// body[data-feed-view]. Dit maakt er weer een instelling van.
//
// Deze tests gaan door de ECHTE routes heen, en niet langs de SQL met een
// handgemaakte rij. Reden: bij het bouwen zette ik een waarde in de INSERT
// zonder de kolom (te weinig vraagtekens) en een kolom in de UPDATE zonder de
// waarde -- waarbij alles erna een plek opschuift en show_search de waarde van
// feed_alt_view kreeg. Geen van beide had een test langs de zijkant gevangen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'baas', 'b@t.nl', 'x', 'god');

const express = (await import('express')).default;
const router = (await import('../src/routes/admin-sites.js')).default;
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.session = { user: { id: 'u1', role: 'god' } }; next(); });
app.use('/admin/sites', router);

const server = app.listen(0);
server.unref();   // houdt de suite niet in leven als een test halverwege stopt
const poort = server.address().port;
// MET EEN TIJDSLIMIET, en dat is geen voorzorg maar een gemeten noodzaak: gaat er
// in de route iets mis (een SQL-fout door een scheve parameterlijst), dan vangt
// express dat in een async-handler niet af en komt er NOOIT een antwoord. Zonder
// limiet hangt de hele suite dan op 124 in plaats van te falen -- precies wat er
// gebeurde toen ik de controleproef deed. Een test die op de fout die hij moet
// vangen blijft hangen, meldt niets.
const post = async (pad, velden) => {
  try {
    return await fetch(`http://127.0.0.1:${poort}${pad}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(velden).toString(),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    assert.fail(`de route antwoordde niet op ${pad} (${e.name}) -- vrijwel altijd een `
      + 'worp in de handler, en bij dit formulier meestal een kolommenlijst die niet '
      + 'meer bij de waarden past');
  }
};
const siteVan = (slug) => db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);

test('de kolom bestaat en staat standaard op Lezen', async () => {
  const r = await post('/admin/sites/create', { slug: 'proef', title: 'Proef' });
  assert.ok(r.status === 302 || r.status === 200, 'aanmaken mag niet stranden, kreeg ' + r.status);
  const s = siteVan('proef');
  assert.ok(s, 'de site hoort aangemaakt te zijn');
  assert.equal(s.feed_alt_view, 'reader', 'een verse site biedt Lezen aan');
});

test('opslaan zet de tweede weergave, en raakt zijn buren niet', async () => {
  // show_search is de kolom die in de UPDATE direct NA feed_alt_view komt. Zette
  // je de kolom er wel bij en de waarde niet, dan kwam de checkbox-waarde in
  // feed_alt_view terecht en schoof al het andere op. Daarom staat hij hier.
  await post('/admin/sites/proef/save', {
    title: 'Proef', feed_alt_view: 'timeline', feed_view_default: 'reader',
    feed_view_switch: '1', show_search: '1', show_archive_link: '1',
  });
  const s = siteVan('proef');
  assert.equal(s.feed_alt_view, 'timeline');
  assert.equal(s.show_search, 1, 'de buurkolom mag niet meeschuiven');
  assert.equal(s.show_archive_link, 1, 'en die erachter ook niet');
  assert.equal(s.feed_view_switch, 1);
});

test('de standaardweergave volgt de tweede weergave, niet een vaste naam', () => {
  // Hier hing het scheef: het aanmaakpad schreef 'reader' en het opslaanpad
  // 'timeline', voor precies dezelfde keuze. De waarde betekende dus niet wat
  // er stond, en de client vertaalde dat stil terug.
  const s = siteVan('proef');
  assert.equal(s.feed_view_default, 'timeline',
    'kiest de site Tijdlijn, dan opent hij daar ook in');
});

test('Grid als standaard blijft Grid, wat de tweede weergave ook is', async () => {
  await post('/admin/sites/proef/save', { title: 'Proef', feed_alt_view: 'auto', feed_view_default: 'grid' });
  const s = siteVan('proef');
  assert.equal(s.feed_alt_view, 'auto');
  assert.equal(s.feed_view_default, 'grid');
});

test('onzin in het formulier valt terug op Lezen', async () => {
  await post('/admin/sites/proef/save', { title: 'Proef', feed_alt_view: 'iets-anders', feed_view_default: 'reader' });
  assert.equal(siteVan('proef').feed_alt_view, 'reader');
});

// closeAllConnections EERST: fetch houdt de verbinding open (keep-alive), en dan
// wacht server.close() tot in de eeuwigheid. Bij een geslaagde run valt dat niet
// op; valt er een test om, dan hangt de hele suite. Zo overkwam het me bij de
// controleproef -- de test die de fout moest aantonen, hing erop.
// ── Elk bericht een eigen scherm in Lezen (Robin, 20-8) ─────────────────────
// Zelfde reden als hierboven om door de ECHTE route te gaan: dit voegt een
// kolom toe aan dezelfde UPDATE, en juist daar ging het eerder mis.
test('de nieuwe kolom staat standaard uit', () => {
  const s = siteVan('proef');
  assert.equal(s.reader_full_page, 0, 'bestaande sites veranderen niet van gedrag');
});

test('aanzetten werkt, en de buren schuiven niet mee', async () => {
  await post('/admin/sites/proef/save', {
    title: 'Proef', feed_alt_view: 'timeline', feed_view_default: 'grid',
    feed_view_switch: '1', reader_full_page: '1', show_search: '1', show_archive_link: '1',
  });
  const s = siteVan('proef');
  assert.equal(s.reader_full_page, 1);
  // De kolommen rond de nieuwe in de UPDATE. Zet je de kolom er wel bij en de
  // waarde niet, dan schuift alles erna een plek op en is dit het eerste dat
  // omvalt.
  assert.equal(s.feed_alt_view, 'timeline', 'de kolom ervoor');
  assert.equal(s.show_search, 1, 'de kolom erna');
  assert.equal(s.show_archive_link, 1, 'en die daarachter');
  assert.equal(s.feed_view_switch, 1);
});

test('en weer uit', async () => {
  await post('/admin/sites/proef/save', { title: 'Proef', feed_alt_view: 'reader', feed_view_default: 'reader' });
  assert.equal(siteVan('proef').reader_full_page, 0, 'een niet-aangevinkt vakje zet hem uit');
});

test.after(() => { server.closeAllConnections?.(); server.close(); });
