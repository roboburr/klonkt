/**
 * Show agenda (premium feature #8) — admin side.
 *
 *   GET  /admin/shows           -> list + add form
 *   POST /admin/shows           -> add show (optional notify email to subscribers)
 *   POST /admin/shows/:id/delete
 *
 * Premium + site manager. Notify email requires SMTP; without SMTP the show is
 * simply saved (no email sent).
 */

import express from 'express';
import db from '../config/database.js';
import { v4 as uuid } from 'uuid';
import { renderPage } from '../middleware/render.js';
import { requireSiteManager } from '../middleware/auth.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { mailerConfigured, sendMail } from '../config/mailer.js';
import { confirmedFor, counts } from '../services/SubscriberService.js';
import { getSetting, setSetting } from '../services/SettingsService.js';
import { t, resolveLang } from '../services/i18n.js';

const router = express.Router();

function esc(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fullUrl(req, p) {
  const base = (process.env.PUBLIC_BASE_URL || ('https://' + (req.get('host') || ''))).replace(/\/$/, '');
  return base + (req.res.locals.siteUrlBase || '') + p;
}
function premiumGate(req, res, next) {
  if (!premiumUnlocked()) {
    const lang = resolveLang(req, { defaultLang: getSetting('default_lang') });
    return res.status(403).send(t(lang, 'aset.premium_gate', { feature: t(lang, 'admin.t_shows') }));
  }
  next();
}
function render(req, res, extra = {}) {
  const site = res.locals.site;
  const shows = db.prepare('SELECT * FROM shows WHERE site_id = ? ORDER BY date DESC, time DESC').all(site.id);
  renderPage(req, res, 'pages/admin-shows', {
    pageTitleKey: 'admin.t_shows', bodyClass: 'on-admin',
    shows, smtp: mailerConfigured(), notifyCount: confirmedFor(site.id, 'notify').length,
    agendaEnabled: getSetting('agenda_enabled') === '1',
    ...extra,
  });
}

router.get('/', requireSiteManager, premiumGate, (req, res) => {
  if (!res.locals.site) return res.status(404).send('Geen site.');
  render(req, res);
});

router.post('/', requireSiteManager, premiumGate, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Geen site.');
  const b = req.body || {};
  const date = (b.date || '').trim();
  const city = (b.city || '').trim();
  if (!date || !city) return render(req, res, { msg: 'Datum en plaats zijn verplicht.', msgKind: 'bad' });
  let ticket = (b.ticket_url || '').trim();
  if (ticket && !/^https?:\/\//i.test(ticket)) ticket = '';

  db.prepare(`INSERT INTO shows (id, site_id, date, time, city, venue, country, ticket_url, notes)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    uuid(), site.id, date, (b.time || '').trim() || null, city, (b.venue || '').trim() || null,
    (b.country || '').trim() || null, ticket || null, (b.notes || '').trim() || null,
  );

  let sent = 0;
  if (b.notify && mailerConfigured()) {
    const subs = confirmedFor(site.id, 'notify');
    const where = city + (b.venue ? ' — ' + b.venue : '');
    for (const s of subs) {
      const unsub = fullUrl(req, '/nieuwsbrief/uitschrijven/' + s.token);
      try {
        await sendMail({
          to: s.email,
          subject: 'Nieuwe show: ' + where + ' (' + date + ')',
          text: (site.title || '') + ' speelt op ' + date + ' in ' + where + '.' + (ticket ? ('\nTickets: ' + ticket) : '') + '\n\nUitschrijven: ' + unsub,
          html: '<p><strong>' + esc(site.title) + '</strong> speelt op <strong>' + esc(date) + '</strong> in ' + esc(where) + '.</p>' +
                (ticket ? ('<p><a href="' + ticket + '">Tickets</a></p>') : '') +
                '<p style="color:#888;font-size:12px"><a href="' + unsub + '">Uitschrijven</a></p>',
        });
        sent++;
      } catch { /* skip */ }
    }
  }
  render(req, res, { msg: 'Show toegevoegd.' + (sent ? (' Notify gestuurd naar ' + sent + ' abonnee(s).') : ''), msgKind: 'ok' });
});

router.post('/toggle', requireSiteManager, premiumGate, (req, res) => {
  // Show the agenda on the site (Agenda button in the pill + /shows page).
  setSetting('agenda_enabled', req.body.enabled ? '1' : '0');
  res.redirect((res.locals.siteUrlBase || '') + '/admin/shows');
});

router.post('/:id/delete', requireSiteManager, premiumGate, (req, res) => {
  const site = res.locals.site;
  if (site) db.prepare('DELETE FROM shows WHERE id = ? AND site_id = ?').run(req.params.id, site.id);
  res.redirect((res.locals.siteUrlBase || '') + '/admin/shows');
});

export default router;
