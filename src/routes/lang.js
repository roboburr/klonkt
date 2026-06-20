// Taalkeuze van de bezoeker: /lang/:code zet de interface-taal in de sessie en
// stuurt terug naar waar je vandaan kwam. (Content blijft in de taal van de auteur.)
import express from 'express';
import { SUPPORTED } from '../services/i18n.js';

const router = express.Router();

router.get('/lang/:code', (req, res) => {
  const code = SUPPORTED.includes(req.params.code) ? req.params.code : 'nl';
  if (req.session) req.session.lang = code;
  // Veilige terug-URL: alleen een intern pad (geen open redirect).
  let back = (typeof req.query.r === 'string') ? req.query.r : '';
  if (!back.startsWith('/') || back.startsWith('//')) {
    try {
      const u = new URL(req.get('referer') || '');
      back = u.pathname + (u.search || '');
    } catch { back = '/'; }
  }
  res.redirect(back || '/');
});

export default router;
