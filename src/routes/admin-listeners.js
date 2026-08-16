/**
 * GET /admin/listeners — wie je BIBLIOTHEEK volgt (shaer-0nh).
 *
 * Een eigen tab in Mediabeheer, want dit is een eigen soort relatie: deze
 * accounts hangen aan /ap/users/<slug>/library en niet aan de actor. Ze krijgen
 * de muziek en met opzet niet de gewone posts -- wie zich op een platenkast
 * abonneert heeft niet om de Krant gevraagd.
 *
 * Dat verschil hoort ZICHTBAAR te zijn. Stonden ze tussen de gewone volgers,
 * dan zou niemand later begrijpen waarom ze andere dingen krijgen.
 */
import express from 'express';
import { requireGod } from '../middleware/auth.js';
import { renderPage } from '../middleware/render.js';
import { audioEnabled } from '../config/features.js';
import { luisteraars } from '../services/music/index.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');
  renderPage(req, res, 'pages/admin-listeners', {
    pageTitleKey: 'admin.b_listeners',
    bodyClass: 'on-admin',
    audioOn: audioEnabled(),
    luisteraars: luisteraars.lijst(site.slug),
  });
});

export default router;
