/**
 * SubscriberService — nieuwsbrief-abonnees per site (premium feature #1).
 *
 * Double opt-in als SMTP er is (status 'pending' → 'confirmed' via confirm-link),
 * anders single opt-in ('confirmed' meteen). Elke abonnee heeft een token dat zowel
 * de confirm- als de unsubscribe-link draagt. Hergebruikt door #2 (download-voor-
 * email) en #8 (notify-me) als gedeelde abonnee-opslag.
 */

import crypto from 'crypto';
import db from '../config/database.js';
import { v4 as uuid } from 'uuid';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Voeg een abonnee toe (of heractiveer een uitgeschreven/bestaande).
 * @returns {{ok:boolean, status?:string, token?:string, created?:boolean, error?:string}}
 *   status 'pending'  → er moet nog bevestigd worden (stuur confirm-mail)
 *   status 'confirmed'→ direct actief (single opt-in)
 */
export function addSubscriber(siteId, email, source = 'widget', { doubleOptin = false } = {}) {
  email = (email || '').trim().toLowerCase();
  if (!siteId) return { ok: false, error: 'no_site' };
  if (!isValidEmail(email)) return { ok: false, error: 'invalid_email' };

  const existing = db.prepare('SELECT * FROM subscribers WHERE site_id = ? AND email = ?').get(siteId, email);
  const status = doubleOptin ? 'pending' : 'confirmed';

  if (existing) {
    // Al actief → niets te doen (idempotent, geen dubbele mail).
    if (existing.status === 'confirmed') return { ok: true, status: 'confirmed', token: existing.token, created: false };
    // Pending of uitgeschreven → opnieuw uitnodigen/activeren met een verse token.
    const token = newToken();
    db.prepare("UPDATE subscribers SET status = ?, token = ?, source = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?")
      .run(status, token, source, status, existing.id);
    return { ok: true, status, token, created: false };
  }

  const token = newToken();
  db.prepare(
    "INSERT INTO subscribers (id, site_id, email, status, source, token, confirmed_at) VALUES (?,?,?,?,?,?, CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END)"
  ).run(uuid(), siteId, email, status, source, token, status);
  return { ok: true, status, token, created: true };
}

export function confirm(token) {
  if (!token) return false;
  const row = db.prepare('SELECT id FROM subscribers WHERE token = ?').get(token);
  if (!row) return false;
  db.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  return true;
}

export function unsubscribe(token) {
  if (!token) return false;
  const row = db.prepare('SELECT id FROM subscribers WHERE token = ?').get(token);
  if (!row) return false;
  db.prepare("UPDATE subscribers SET status = 'unsub' WHERE id = ?").run(row.id);
  return true;
}

/** Bevestigde abonnees (email + token) voor een site — voor het versturen.
 * Optioneel filteren op bron (bv. 'notify' voor show-aankondigingen). */
export function confirmedFor(siteId, source) {
  if (source) {
    return db.prepare("SELECT email, token FROM subscribers WHERE site_id = ? AND status = 'confirmed' AND source = ?").all(siteId, source);
  }
  return db.prepare("SELECT email, token FROM subscribers WHERE site_id = ? AND status = 'confirmed'").all(siteId);
}

export function counts(siteId) {
  const c = (st) => db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE site_id = ? AND status = ?').get(siteId, st).n;
  return { confirmed: c('confirmed'), pending: c('pending'), unsub: c('unsub') };
}
