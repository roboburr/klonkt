/**
 * Show-agenda + notify-me (premium feature #8) — publieke kant.
 *
 *   GET  /shows         -> komende optredens + "houd me op de hoogte"-formulier
 *   POST /shows/notify  -> aanmelden voor show-aankondigingen (subscribers, source
 *                          'notify'; double opt-in als SMTP er is)
 *
 * De notify-bevestiging/uitschrijving hergebruikt de generieke subscriber-links
 * (/nieuwsbrief/bevestigen|uitschrijven/:token). Hub: /user/:slug/shows.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { mailerConfigured, sendMail } from '../config/mailer.js';
import { addSubscriber } from '../services/SubscriberService.js';
import { getSetting } from '../services/SettingsService.js';

const router = express.Router();

// Agenda is opt-in: pas bereikbaar als de beheerder 'm heeft ingeschakeld.
function agendaOn() { return getSetting('agenda_enabled') === '1'; }

function esc(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fullUrl(req, p) {
  const base = (process.env.PUBLIC_BASE_URL || ('https://' + (req.get('host') || ''))).replace(/\/$/, '');
  return base + (req.res.locals.siteUrlBase || '') + p;
}
function upcoming(siteId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT * FROM shows WHERE site_id = ? AND date >= ? ORDER BY date ASC, time ASC').all(siteId, today);
}

router.get('/shows', (req, res, next) => {
  if (!premiumUnlocked() || !agendaOn()) return next();
  const site = res.locals.site;
  if (!site) return next();
  renderPage(req, res, 'pages/shows', {
    pageTitle: 'Agenda — ' + (site.title || ''),
    bodyClass: 'on-shows',
    shows: upcoming(site.id),
    notifyState: req.query.ok ? 'done' : (req.query.check ? 'check' : null),
  });
});

router.post('/shows/notify', async (req, res, next) => {
  if (!premiumUnlocked() || !agendaOn()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const email = (req.body.email || '').trim();
  const doubleOptin = mailerConfigured();
  const r = addSubscriber(site.id, email, 'notify', { doubleOptin });
  if (!r.ok) {
    return renderPage(req, res, 'pages/shows', {
      pageTitle: 'Agenda', bodyClass: 'on-shows', shows: upcoming(site.id),
      notifyState: 'error', notifyMsg: r.error === 'invalid_email' ? 'Controleer je e-mailadres.' : 'Er ging iets mis.',
    });
  }
  if (r.status === 'pending') {
    const link = fullUrl(req, '/nieuwsbrief/bevestigen/' + r.token);
    const unsub = fullUrl(req, '/nieuwsbrief/uitschrijven/' + r.token);
    try {
      await sendMail({
        to: email,
        subject: 'Bevestig — show-updates van ' + (site.title || ''),
        text: 'Bevestig dat je show-aankondigingen wilt ontvangen: ' + link + '\n\nUitschrijven: ' + unsub,
        html: '<p>Bevestig dat je show-aankondigingen van <strong>' + esc(site.title) + '</strong> wilt ontvangen:</p>' +
              '<p><a href="' + link + '">Bevestigen</a></p><p style="color:#888;font-size:12px"><a href="' + unsub + '">Uitschrijven</a></p>',
      });
    } catch { return res.redirect((res.locals.siteUrlBase || '') + '/shows'); }
    return res.redirect((res.locals.siteUrlBase || '') + '/shows?check=1');
  }
  res.redirect((res.locals.siteUrlBase || '') + '/shows?ok=1');
});

export default router;
