// Taalkeuze van de bezoeker: /lang/:code zet de interface-taal in de sessie en
// stuurt terug naar waar je vandaan kwam. (Content blijft in de taal van de auteur.)
import express from 'express';
import { SUPPORTED } from '../services/i18n.js';
import db from '../config/database.js';

const router = express.Router();

router.get('/lang/:code', (req, res) => {
  const code = SUPPORTED.includes(req.params.code) ? req.params.code : 'nl';
  if (req.session) req.session.lang = code;
  // Ingelogd? Bewaar de keuze ook op het account zodat 'ie meereist over
  // apparaten/sessies (niet alleen deze sessie-cookie).
  if (req.session && req.session.user && req.session.user.id) {
    try {
      db.prepare('UPDATE users SET lang = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(code, req.session.user.id);
      req.session.user.lang = code;
    } catch { /* lang-kolom ontbreekt op een oude DB → sessie-only, geen breuk */ }
  }
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
