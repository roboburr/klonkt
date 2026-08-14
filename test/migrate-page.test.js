// Alle migratie-opties op één pagina (Robin, 14-8), en wat daarbij stuk kon.
//
// Aliassen en verhuizen stonden op de site-bewerkpagina, tussen de kleuren en
// de feedinstellingen. Dat is de verkeerde plek: het zijn stap 1 en stap 4 van
// een verhuizing, en het scherm eromheen gaat over hoe je site eruitziet.
//
// De verplaatsing had een stille valkuil: de opslagroute van dat scherm schreef
// ap_aliases uit het formulier. Verdwijnt het veld, dan is de waarde leeg, en
// dan wist je je claim op je oude account door je accentkleur te wijzigen. De
// Move weigert daarna met no_backreference en je snapt niet waarom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ik.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }

test('het site-bewerkscherm draagt geen alias- of verhuisformulier meer', () => {
  const ejs = fs.readFileSync('src/views/pages/admin-site-edit.ejs', 'utf8');
  assert.ok(!/name="ap_aliases"/.test(ejs), 'het aliasveld hoort bij Migreren');
  assert.ok(!/name="move_target"/.test(ejs), 'en de verhuisknop ook');
  assert.match(ejs, /\/admin\/migrate/, 'maar er staat wel een wegwijzer, anders zoekt iemand zich rot');
});

test('de migrate-pagina draagt ze allebei wel', () => {
  const ejs = fs.readFileSync('src/views/pages/admin-migrate.ejs', 'utf8');
  assert.match(ejs, /name="ap_aliases"/);
  assert.match(ejs, /name="move_target"/);
  // De verhuisknop post naar de BESTAANDE route: een tweede implementatie van
  // een onomkeerbare actie is precies wat je niet wilt.
  assert.match(ejs, /action="\/admin\/sites\/<%= site\.slug %>\/move"/);
  assert.match(ejs, /name="next" value="\/admin\/migrate"/, 'en komt terug waar je vandaan kwam');
});

test('de volgorde op de pagina volgt de verhuizing: claimen eerst, aankondigen laatst', () => {
  const ejs = fs.readFileSync('src/views/pages/admin-migrate.ejs', 'utf8');
  const alias = ejs.indexOf('name="ap_aliases"');
  const halen = ejs.indexOf('/admin/migrate/pull');
  const move = ejs.indexOf('name="move_target"');
  assert.ok(alias > -1 && halen > -1 && move > -1);
  assert.ok(alias < halen, 'claimen staat boven ophalen: zonder claim geeft de bron niets');
  assert.ok(halen < move, 'aankondigen staat onderaan: dat is de onomkeerbare stap');
});

test('een alias overleeft het opslaan van je uiterlijk', async () => {
  // De valkuil. Geen HTTP nodig: dit gaat om de regel dat een ontbrekend veld
  // "niet aanraken" betekent en niet "leegmaken".
  db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES ('u1','u','u@t','x','god')").run();
  db.prepare("INSERT INTO sites (id,slug,title,owner_id,ap_aliases) VALUES ('s1','ik','Ik','u1',?)")
    .run(JSON.stringify(['https://oud.example/ap/users/robo']));

  const site = db.prepare("SELECT id, ap_aliases FROM sites WHERE slug = 'ik'").get();
  const formulierZonderVeld = { title: 'Ik', accent: '#c33' };      // zoals het nu binnenkomt
  const apAliasesJson = Object.prototype.hasOwnProperty.call(formulierZonderVeld, 'ap_aliases')
    ? null : (site.ap_aliases || null);
  db.prepare('UPDATE sites SET ap_aliases = ? WHERE slug = ?').run(apAliasesJson, 'ik');

  const na = db.prepare("SELECT ap_aliases FROM sites WHERE slug = 'ik'").get();
  assert.deepEqual(JSON.parse(na.ap_aliases), ['https://oud.example/ap/users/robo'],
    'je claim op je oude account mag niet sneuvelen op een kleurwijziging');
});
