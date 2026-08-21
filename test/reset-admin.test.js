// reset-admin is het noodpad: geen e-mail, geen sessie, alleen shell-toegang.
// Juist daarom hoort hier de GESLAAGDE weg getest te worden en niet alleen de
// weigering -- een break-glass die stilletjes de verkeerde database opent doet
// precies wat hij niet mag: hij lijkt te werken.
//
// Deze tests starten het script als los proces, want de fout die we in
// augustus vonden zat in de volgorde van imports: src/config/database.js maakt
// zijn bestand aan zodra hij geladen wordt. Dat is alleen zichtbaar als je het
// echt draait, niet als je functies importeert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const wortel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(wortel, 'scripts/reset-admin.mjs');

/** Een database met één god-user erin, op een weggooiplek. */
function maakSite(dir, username = 'baas') {
  fs.mkdirSync(dir, { recursive: true });
  const pad = path.join(dir, 'database.sqlite');
  const D = new Database(pad);
  D.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT, email TEXT, role TEXT,
    password_hash TEXT, reset_token TEXT, reset_token_expires TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
  )`);
  D.prepare('INSERT INTO users (username, email, role, password_hash) VALUES (?,?,?,?)')
    .run(username, `${username}@voorbeeld.nl`, 'god', bcrypt.hashSync('oudwachtwoord', 4));
  D.close();
  return pad;
}

function draai(args, env = {}) {
  // Een lege waarde WIST de variabele hier, in plaats van hem leeg te zetten:
  // dotenv kijkt of de sleutel bestaat, niet of hij gevuld is, dus een lege
  // DATABASE_PATH zou een .env-waarde tegenhouden en de test iets anders laten
  // meten dan ze denkt te meten.
  const kind = { ...process.env, ...env };
  for (const [k, v] of Object.entries(kind)) if (v === '' || v === undefined) delete kind[k];
  try {
    return { code: 0, uit: execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env: kind, cwd: wortel, stdio: 'pipe',
    }) };
  } catch (e) {
    return { code: e.status ?? 1, uit: (e.stdout || '') + (e.stderr || '') };
  }
}

test('reset-admin zet echt een nieuw wachtwoord (de geslaagde weg)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reset-'));
  const pad = maakSite(path.join(tmp, 'data'));

  const r = draai([], { DATABASE_PATH: pad });
  assert.equal(r.code, 0, r.uit);
  assert.match(r.uit, /Wachtwoord gereset voor baas/);
  assert.match(r.uit, /Nieuw wachtwoord: (\S+)/);
  // Het pad hoort in de uitvoer: bij meerdere datamappen is "welke database"
  // de enige vraag die ertoe doet.
  assert.match(r.uit, new RegExp(`Database: ${pad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // En het wachtwoord dat hij toont, werkt ook echt.
  const nieuw = r.uit.match(/Nieuw wachtwoord: (\S+)/)[1];
  const D = new Database(pad, { readonly: true });
  const u = D.prepare('SELECT password_hash FROM users WHERE username = ?').get('baas');
  assert.equal(bcrypt.compareSync(nieuw, u.password_hash), true, 'het getoonde wachtwoord moet geldig zijn');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('een zelfgekozen wachtwoord wordt gezet, en te kort wordt geweigerd', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reset-'));
  const pad = maakSite(path.join(tmp, 'data'));

  assert.equal(draai(['baas', 'kort'], { DATABASE_PATH: pad }).code, 1);
  const r = draai(['baas', 'eenlangwachtwoord'], { DATABASE_PATH: pad });
  assert.equal(r.code, 0, r.uit);

  const D = new Database(pad, { readonly: true });
  const u = D.prepare('SELECT password_hash FROM users WHERE username = ?').get('baas');
  assert.equal(bcrypt.compareSync('eenlangwachtwoord', u.password_hash), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--instance leest de .env van die instantie, zoals systemd dat doet', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reset-'));
  // De opstelling uit deploy/klonkt@.service nagebouwd: gedeelde code, en de
  // configuratie per instantie onder de dataroot.
  const dataRoot = path.join(tmp, 'var-lib-klonkt');
  const pad = maakSite(path.join(dataRoot, 'boiert'), 'opie');
  fs.writeFileSync(path.join(dataRoot, 'boiert', '.env'), `DATABASE_PATH=${pad}\n`);

  const r = draai(['--instance', 'boiert'], { KLONKT_DATA_ROOT: dataRoot, DATABASE_PATH: '' });
  assert.equal(r.code, 0, r.uit);
  assert.match(r.uit, /Wachtwoord gereset voor opie/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('zonder database maakt hij er GEEN aan, maar noemt het pad', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reset-'));
  const pad = path.join(tmp, 'nergens', 'database.sqlite');

  const r = draai([], { DATABASE_PATH: pad });
  assert.equal(r.code, 1);
  assert.match(r.uit, /Geen database op/);
  assert.match(r.uit, new RegExp(pad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // De kern van de fix: geen lege database achterlaten waar je toevallig stond.
  assert.equal(fs.existsSync(pad), false, 'er mag niets aangemaakt zijn');
  assert.equal(fs.existsSync(path.dirname(pad)), false, 'ook de map niet');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('een database zonder users-tabel is het verkeerde bestand, geen lege site', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reset-'));
  const pad = path.join(tmp, 'vreemd.sqlite');
  const D = new Database(pad); D.exec('CREATE TABLE iets (a INTEGER)'); D.close();

  const r = draai([], { DATABASE_PATH: pad });
  assert.equal(r.code, 1);
  assert.match(r.uit, /geen users-tabel/);
  assert.doesNotMatch(r.uit, /SqliteError/, 'een aanwijzing, geen stacktrace');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('een onbekende instantie noemt wat er wel is', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reset-'));
  const dataRoot = path.join(tmp, 'var-lib-klonkt');
  maakSite(path.join(dataRoot, 'boiert'));
  fs.writeFileSync(path.join(dataRoot, 'boiert', '.env'), 'DATABASE_PATH=/dev/null\n');

  const r = draai(['--instance', 'bestaatniet'], { KLONKT_DATA_ROOT: dataRoot });
  assert.equal(r.code, 1);
  assert.match(r.uit, /Geen \.env voor instantie "bestaatniet"/);
  assert.match(r.uit, /boiert/, 'noemt de instanties die er wel zijn');
  fs.rmSync(tmp, { recursive: true, force: true });
});
