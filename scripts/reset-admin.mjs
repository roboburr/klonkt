#!/usr/bin/env node
// Break-glass: reset (of zet) het wachtwoord van een beheerder. Werkt altijd,
// zonder e-mail — de self-hoster heeft immers shell-/servertoegang.
//
// Gebruik:
//   npm run reset-admin                       # reset de (eerste) god-user, print nieuw wachtwoord
//   npm run reset-admin -- <user|email>       # reset specifieke user, print nieuw wachtwoord
//   npm run reset-admin -- <user|email> <pw>  # zet een gekozen wachtwoord
//
// Draai dit vanuit de projectroot zodat DATABASE_PATH/.env correct geladen wordt.

import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../src/config/database.js';

const arg = process.argv[2];
const pwArg = process.argv[3];

let user;
if (arg) {
  user = db.prepare('SELECT * FROM users WHERE username = ? OR LOWER(email) = LOWER(?)').get(arg, arg);
} else {
  // Geen arg: pak de beheerder (god of admin), anders de allereerste user.
  user =
    db.prepare("SELECT * FROM users WHERE role IN ('god','admin') ORDER BY created_at LIMIT 1").get() ||
    db.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').get();
}

if (!user) {
  console.error(arg ? `Geen user gevonden voor "${arg}".` : 'Geen god-user gevonden.');
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
if (!pwArg) console.log(`Nieuw wachtwoord: ${newPw}`);
console.log('Log nu in via /auth/login en wijzig het eventueel in je account.');
process.exit(0);
