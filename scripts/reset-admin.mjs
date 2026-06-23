#!/usr/bin/env node
// Break-glass: reset (or set) the password of an admin account. Always works,
// no email required — the self-hoster has shell/server access.
//
// Usage:
//   npm run reset-admin                       # reset the (first) god user, print new password
//   npm run reset-admin -- <user|email>       # reset a specific user, print new password
//   npm run reset-admin -- <user|email> <pw>  # set a chosen password
//
// Run from the project root so DATABASE_PATH/.env is loaded correctly.

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
  // No arg: pick the admin (god or admin role), otherwise the very first user.
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
