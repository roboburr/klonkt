/**
 * Nieuwsbrief — beheerkant (premium feature #1).
 *
 *   GET  /admin/newsletter        -> opstellen + abonnee-aantallen + historie
 *   POST /admin/newsletter/send   -> verstuur naar alle BEVESTIGDE abonnees (SMTP)
 *
 * Premium-gated + site-beheerder. Versturen vereist ingestelde SMTP; zonder SMTP
 * worden aanmeldingen wél verzameld (single opt-in), alleen versturen kan dan niet.
 */

import express from 'express';
import db from '../config/database.js';
import { v4 as uuid } from 'uuid';
import { renderPage } from '../middleware/render.js';
import { requireSiteManager } from '../middleware/auth.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { mailerConfigured, sendMail } from '../config/mailer.js';
import { confirmedFor, counts } from '../services/SubscriberService.js';

const router = express.Router();

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fullUrl(req, p) {
  const base = (process.env.PUBLIC_BASE_URL || ('https://' + (req.get('host') || ''))).replace(/\/$/, '');
  return base + (res_siteUrlBase(req)) + p;
}
function res_siteUrlBase(req) {
  return req.res && req.res.locals ? (req.res.locals.siteUrlBase || '') : '';
}

function premiumGate(req, res, next) {
  if (!premiumUnlocked()) {
    return res.status(403).send('Nieuwsbrief is premium — koppel Patreon in Beheer → Instellingen.');
  }
  next();
}

function renderCompose(req, res, extra = {}) {
  const site = res.locals.site;
  const c = counts(site.id);
  const history = db.prepare(
    'SELECT subject, sent_at, recipient_count FROM newsletters WHERE site_id = ? ORDER BY sent_at DESC LIMIT 10'
  ).all(site.id);
  const subscribeUrl = fullUrl(req, '/nieuwsbrief');
  renderPage(req, res, 'pages/admin-newsletter', {
    pageTitle: 'Nieuwsbrief',
    bodyClass: 'on-admin',
    nlCounts: c,
    nlHistory: history,
    nlSubscribeUrl: subscribeUrl,
    nlSmtp: mailerConfigured(),
    ...extra,
  });
}

router.get('/', requireSiteManager, premiumGate, (req, res) => {
  if (!res.locals.site) return res.status(404).send('Geen site.');
  renderCompose(req, res);
});

router.post('/send', requireSiteManager, premiumGate, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Geen site.');
  if (!mailerConfigured()) return renderCompose(req, res, { nlMsg: 'SMTP is niet ingesteld — versturen kan nog niet.', nlMsgKind: 'bad' });

  const subject = (req.body.subject || '').trim();
  const body = (req.body.body || '').trim();
  if (!subject || !body) return renderCompose(req, res, { nlMsg: 'Onderwerp en bericht zijn verplicht.', nlMsgKind: 'bad', nlSubject: subject, nlBody: body });

  const subs = confirmedFor(site.id);
  const bodyHtml = esc(body).replace(/\n/g, '<br>');
  let sent = 0;
  for (const s of subs) {
    const unsub = fullUrl(req, '/nieuwsbrief/uitschrijven/' + s.token);
    try {
      await sendMail({
        to: s.email,
        subject,
        text: body + '\n\n—\nUitschrijven: ' + unsub,
        html: '<div>' + bodyHtml + '</div>' +
              '<hr style="margin-top:24px;border:none;border-top:1px solid #ddd">' +
              '<p style="color:#888;font-size:12px">Je ontvangt dit omdat je je aanmeldde voor de nieuwsbrief van ' +
              esc(site.title) + '. <a href="' + unsub + '">Uitschrijven</a>.</p>',
      });
      sent++;
    } catch (e) { /* sla deze ontvanger over, ga door */ }
  }
  db.prepare('INSERT INTO newsletters (id, site_id, subject, body, recipient_count) VALUES (?,?,?,?,?)')
    .run(uuid(), site.id, subject, body, sent);

  renderCompose(req, res, { nlMsg: 'Verstuurd naar ' + sent + ' van ' + subs.length + ' abonnee(s).', nlMsgKind: 'ok' });
});

export default router;
