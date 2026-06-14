// E-mail versturen (wachtwoord-reset). Optioneel: alleen actief als de self-hoster
// SMTP heeft ingesteld. Niet ingesteld? Dan valt de reset terug op de CLI
// (`npm run reset-admin`) — zie README.
//
// Config via env:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS
//   SMTP_FROM (afzender; default = SMTP_USER)

import nodemailer from 'nodemailer';

const HOST = process.env.SMTP_HOST || '';
const PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.SMTP_FROM || USER;

export function mailerConfigured() {
  return !!(HOST && USER && PASS);
}

let _transport = null;
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465, // 465 = impliciete TLS; 587 = STARTTLS
      auth: { user: USER, pass: PASS },
    });
  }
  return _transport;
}

export async function sendMail({ to, subject, text, html }) {
  if (!mailerConfigured()) throw new Error('SMTP niet geconfigureerd');
  return transport().sendMail({ from: FROM, to, subject, text, html });
}
