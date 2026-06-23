// Send email (password reset, newsletter, notify). Optional: only active
// when SMTP is configured — via Admin → Settings (app_settings) OR env vars.
//
// Config source (in this order): app_settings (set via the UI), otherwise env:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM (default = USER)
// Not configured → sending falls back to CLI (reset-admin) / is skipped.

import nodemailer from 'nodemailer';
import { getSetting } from '../services/SettingsService.js';

function cfg() {
  const host = getSetting('smtp_host', '') || process.env.SMTP_HOST || '';
  const port = parseInt(getSetting('smtp_port', '') || process.env.SMTP_PORT || '587', 10) || 587;
  const user = getSetting('smtp_user', '') || process.env.SMTP_USER || '';
  const pass = getSetting('smtp_pass', '') || process.env.SMTP_PASS || '';
  const from = getSetting('smtp_from', '') || process.env.SMTP_FROM || user;
  return { host, port, user, pass, from };
}

export function mailerConfigured() {
  const c = cfg();
  return !!(c.host && c.user && c.pass);
}

// Status for the UI (without leaking the password).
export function mailerStatus() {
  const c = cfg();
  return {
    configured: mailerConfigured(),
    host: c.host,
    port: c.port,
    user: c.user,
    from: c.from,
    passSet: !!c.pass,
    // source: useful to show that env vars are still active
    fromEnv: !getSetting('smtp_host', '') && !!process.env.SMTP_HOST,
  };
}

// Cache the transport, but rebuild it whenever the config changes (UI edit without restart).
let _transport = null, _key = null;
function transport() {
  const c = cfg();
  const key = [c.host, c.port, c.user, c.pass].join('|');
  if (!_transport || _key !== key) {
    _transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.port === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: c.user, pass: c.pass },
    });
    _key = key;
  }
  return _transport;
}

export async function sendMail({ to, subject, text, html }) {
  if (!mailerConfigured()) throw new Error('SMTP not configured');
  const c = cfg();
  return transport().sendMail({ from: c.from, to, subject, text, html });
}
