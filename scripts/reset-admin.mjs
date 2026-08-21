#!/usr/bin/env node
// Break-glass: reset (or set) the password of an admin account. Always works,
// no email required — the self-hoster has shell/server access.
//
// Usage:
//   npm run reset-admin                            # reset the (first) god user, print new password
//   npm run reset-admin -- <user|email>            # reset a specific user, print new password
//   npm run reset-admin -- <user|email> <pw>       # set a chosen password
//   npm run reset-admin -- --instance <slug> [...] # pick an instance (shared code, /var/lib/klonkt)
//
// Run from the project root so DATABASE_PATH/.env is loaded correctly, or name
// the instance with --instance.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wortel = path.join(__dirname, '..');

// De argumenten: --instance mag overal staan, de rest is stelling-afhankelijk.
const argv = process.argv.slice(2);
let slug = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--instance' || a === '-i') { slug = argv[++i] || null; continue; }
  if (a.startsWith('--instance=')) { slug = a.slice('--instance='.length); continue; }
  rest.push(a);
}
const [arg, pwArg] = rest;

if (slug !== null && !slug) {
  console.error('--instance verwacht een slug, bijvoorbeeld: --instance boiert');
  process.exit(1);
}

// WAAR DE CONFIGURATIE VANDAAN KOMT, en waarom dit meer dan één regel is.
//
// Bij één-instantie-per-checkout staat de .env naast de code en vindt dotenv
// hem vanzelf. In de gedeelde opstelling van deploy/klonkt@.service niet: daar
// is de code gedeeld op /opt/klonkt en staat de configuratie per instantie in
// /var/lib/klonkt/<slug>/.env, waar SYSTEMD hem leest via EnvironmentFile.
// Dotenv kijkt in de werkmap en vindt daar niets, dus zonder --instance draait
// dit script met een lege DATABASE_PATH -- en dan wijst hij de verkeerde kant
// op. Vandaar deze schakelaar.
const DATA_ROOT = process.env.KLONKT_DATA_ROOT || '/var/lib/klonkt';
if (slug) {
  const envPad = path.join(DATA_ROOT, slug, '.env');
  if (!fs.existsSync(envPad)) {
    console.error(`Geen .env voor instantie "${slug}" op ${envPad}.`);
    console.error(`Bestaande instanties: ${bestaandeInstanties().join(', ') || '(geen gevonden)'}`);
    console.error('Staat je data ergens anders? Zet KLONKT_DATA_ROOT.');
    process.exit(1);
  }
  // override: dotenv laat een bestaande variabele normaal met rust, maar wie
  // --instance typt heeft die instantie AANGEWEZEN. Een DATABASE_PATH die nog
  // in de shell hangt van een vorige instantie zou anders stilletjes winnen,
  // en dan reset je het wachtwoord van de verkeerde site.
  dotenv.config({ path: envPad, override: true });
} else {
  dotenv.config();
}

function bestaandeInstanties() {
  try {
    return fs.readdirSync(DATA_ROOT).filter((d) => fs.existsSync(path.join(DATA_ROOT, d, '.env')));
  } catch { return []; }
}

// EERST KIJKEN, DAN PAS IMPORTEREN. src/config/database.js maakt zijn map en
// zijn bestand aan zodra hij geladen wordt -- prima bij de eerste start van een
// server, funest hier: sta je in de verkeerde map, dan legt hij een lege
// database neer en klapt daarna op "no such table: users". Dat is een
// stacktrace op de plek waar een aanwijzing hoort te staan. Dus dezelfde
// padkeuze als database.js, maar dan alleen berekend.
const dbPad = process.env.DATABASE_PATH || path.join(wortel, 'storage/database.sqlite');
if (!fs.existsSync(dbPad)) {
  console.error(`Geen database op ${dbPad}.`);
  console.error('');
  console.error('Dit script maakt er met opzet geen aan: een ontbrekende database betekent');
  console.error('bijna altijd dat DATABASE_PATH niet geladen is, niet dat de site leeg is.');
  console.error('');
  if (!slug) {
    const gevonden = bestaandeInstanties();
    if (gevonden.length) {
      console.error(`Gedeelde opstelling? Noem de instantie: npm run reset-admin -- --instance <slug>`);
      console.error(`Gevonden in ${DATA_ROOT}: ${gevonden.join(', ')}`);
    } else {
      console.error('Draai dit vanuit de projectmap, zodat de .env ernaast geladen wordt,');
      console.error('of geef het pad mee: DATABASE_PATH=/pad/naar/database.sqlite npm run reset-admin');
    }
  }
  process.exit(1);
}

const { default: db } = await import('../src/config/database.js');

let user;
try {
  if (arg) {
    user = db.prepare('SELECT * FROM users WHERE username = ? OR LOWER(email) = LOWER(?)').get(arg, arg);
  } else {
    // No arg: pick the admin (god or admin role), otherwise the very first user.
    user =
      db.prepare("SELECT * FROM users WHERE role IN ('god','admin') ORDER BY created_at LIMIT 1").get() ||
      db.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').get();
  }
} catch (e) {
  // Een database zonder users-tabel is geen lege site maar het verkeerde
  // bestand -- of een checkout die nog nooit gestart is.
  if (/no such table/i.test(e.message)) {
    console.error(`De database op ${dbPad} heeft geen users-tabel.`);
    console.error('Dat is een ander bestand dan je site, of een site die nooit gestart is.');
    process.exit(1);
  }
  throw e;
}

if (!user) {
  console.error(arg ? `Geen user gevonden voor "${arg}".` : 'Geen god-user gevonden.');
  console.error(`Gezocht in ${dbPad}.`);
  process.exit(1);
}

if (pwArg && pwArg.length < 8) {
  console.error('Wachtwoord moet minstens 8 tekens zijn.');
  process.exit(1);
}

const newPw = pwArg || crypto.randomBytes(9).toString('base64url');
db.prepare(`
  UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?
`).run(bcrypt.hashSync(newPw, 10), user.id);

console.log(`Wachtwoord gereset voor ${user.username} <${user.email}> (rol: ${user.role}).`);
console.log(`Database: ${dbPad}`);
if (!pwArg) console.log(`Nieuw wachtwoord: ${newPw}`);
console.log('Log nu in via /auth/login en wijzig het eventueel in je account.');
process.exit(0);
