/**
 * Nieuwsbrief — publieke kant (premium feature #1).
 *
 *   GET  /nieuwsbrief                      -> aanmeldformulier (premium; anders 404)
 *   POST /nieuwsbrief                      -> aanmelden (double opt-in als SMTP er is)
 *   GET  /nieuwsbrief/bevestigen/:token    -> opt-in bevestigen
 *   GET  /nieuwsbrief/uitschrijven/:token  -> uitschrijven (ALTIJD toegestaan)
 *
 * In hub-modus loopt dit via /user/:slug/nieuwsbrief (resolveSite zet siteUrlBase).
 * Confirm-/unsub-links in de mail zijn absoluut (PUBLIC_BASE_URL + siteUrlBase).
 */

import express from 'express';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { mailerConfigured, sendMail } from '../config/mailer.js';
import { addSubscriber, confirm, unsubscribe } from '../services/SubscriberService.js';

const router = express.Router();

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fullUrl(req, siteUrlBase, p) {
  const base = (process.env.PUBLIC_BASE_URL || ('https://' + (req.get('host') || ''))).replace(/\/$/, '');
  return base + (siteUrlBase || '') + p;
}
function show(req, res, state, extra = {}) {
  renderPage(req, res, 'pages/newsletter', {
    pageTitle: 'Nieuwsbrief' + (res.locals.site ? ' — ' + res.locals.site.title : ''),
    bodyClass: 'on-newsletter',
    nlState: state,
    ...extra,
  });
}

router.get('/nieuwsbrief', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  if (!res.locals.site) return next();
  const fan = req.session && req.session.user;
  const prefill = (fan && fan.email && fan.email.includes('@')) ? fan.email : '';
  show(req, res, 'form', { nlPrefill: prefill });
});

router.post('/nieuwsbrief', async (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const email = (req.body.email || '').trim();
  const doubleOptin = mailerConfigured();
  const r = addSubscriber(site.id, email, 'widget', { doubleOptin });
  if (!r.ok) return show(req, res, r.error === 'invalid_email' ? 'invalid' : 'error', { nlPrefill: email });

  if (r.status === 'pending') {
    // Double opt-in: stuur de bevestigingsmail.
    const link = fullUrl(req, res.locals.siteUrlBase, '/nieuwsbrief/bevestigen/' + r.token);
    const unsub = fullUrl(req, res.locals.siteUrlBase, '/nieuwsbrief/uitschrijven/' + r.token);
    try {
      await sendMail({
        to: email,
        subject: 'Bevestig je inschrijving — ' + (site.title || 'nieuwsbrief'),
        text: 'Bevestig je inschrijving op de nieuwsbrief van ' + (site.title || '') + ':\n' + link +
              '\n\nNiet aangevraagd? Negeer deze mail. Uitschrijven: ' + unsub,
        html: '<p>Bevestig je inschrijving op de nieuwsbrief van <strong>' + esc(site.title) + '</strong>:</p>' +
              '<p><a href="' + link + '">Inschrijving bevestigen</a></p>' +
              '<p style="color:#888;font-size:12px">Niet aangevraagd? Negeer deze mail. ' +
              '<a href="' + unsub + '">Uitschrijven</a></p>',
      });
    } catch (e) {
      return show(req, res, 'smtperror');
    }
    return show(req, res, 'check', { nlEmail: email });
  }
  return show(req, res, 'done', { nlEmail: email });
});

router.get('/nieuwsbrief/bevestigen/:token', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const ok = confirm(req.params.token);
  show(req, res, ok ? 'confirmed' : 'badtoken');
});

// Uitschrijven mag altijd (ook als de premium-laag later uit zou gaan): een abonnee
// moet zich altijd kunnen afmelden. Niet premium-gated.
router.get('/nieuwsbrief/uitschrijven/:token', (req, res) => {
  const ok = unsubscribe(req.params.token);
  show(req, res, ok ? 'unsubbed' : 'badtoken');
});

export default router;
