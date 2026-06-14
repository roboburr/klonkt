/**
 * Hub-hoofdpagina — alleen in hub-modus. In plaats van de primaire PrutFolio te
 * tonen, rendert '/' hier een bedrijfs-overview: de laatste posts van ALLE
 * gebruikers samengevat + een lijst van de PrutFolio's.
 *
 * In solo-modus doet dit niets (next()) en rendert posts.js de enige site.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { getTenancy, getSetting } from '../services/SettingsService.js';

const router = express.Router();

router.get('/', (req, res, next) => {
  if (getTenancy() !== 'hub') return next();
  // Als resolveSite een specifieke site adresseerde (/user/:slug of /sites/:slug),
  // is req.url naar '/' herschreven — dan NIET de overview tonen maar de site zelf
  // laten renderen door posts.js. siteUrlBase is dan gezet.
  if (res.locals.siteUrlBase) return next();

  // Laatste gepubliceerde posts over álle sites heen.
  const posts = db.prepare(`
    SELECT p.title, p.slug, p.excerpt, p.published_at, p.created_at,
           p.cover_image_url, p.type,
           s.slug AS site_slug, s.title AS site_title, s.profile_photo AS site_photo,
           u.username AS author_username
    FROM posts p
    JOIN sites s ON s.id = p.site_id
    LEFT JOIN users u ON u.id = p.author_id
    WHERE p.status = 'published'
    ORDER BY COALESCE(p.published_at, p.created_at) DESC
    LIMIT 24
  `).all();

  // De hoofd-/labelsite (oudste = de bedrijfs-/hoofdaccount) is GEEN artiest;
  // die tonen we apart bovenaan, niet in de Artiesten-roster.
  const mainSite = db.prepare(`
    SELECT s.id, s.slug, s.title, s.tagline, s.profile_photo, s.accent,
           u.avatar_url AS owner_avatar,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id AND status = 'published') AS post_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    ORDER BY s.created_at ASC
    LIMIT 1
  `).get() || null;
  const mainId = mainSite ? mainSite.id : '';

  // Uitgelichte PrutFolio's voor de home-roster: meest-actief eerst (aantal
  // gepubliceerde posts), dan nieuwste. Excl. de hoofdsite. Beperkt tot
  // HOME_ROSTER_LIMIT zodat de home schaalt — volledige lijst staat op /leden.
  const HOME_ROSTER_LIMIT = 24;
  const artists = db.prepare(`
    SELECT s.slug, s.title, s.tagline, s.profile_photo, s.accent,
           u.avatar_url AS owner_avatar,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id AND status = 'published') AS post_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    WHERE s.id != @mainId
    ORDER BY post_count DESC, s.created_at DESC
    LIMIT @limit
  `).all({ mainId, limit: HOME_ROSTER_LIMIT });
  const totalArtists = db.prepare('SELECT COUNT(*) AS c FROM sites WHERE id != ?').get(mainId).c;

  // De hub-pagina is GENERIEK (van geen enkele user) — branding komt uit globale
  // instellingen die de admin in Beheer beheert, niet uit een site.
  const hub = {
    title: getSetting('hub_title') || 'Overzicht',
    tagline: getSetting('hub_tagline') || '',
    intro: getSetting('hub_intro') || '',
    heroImage: getSetting('hub_hero_image') || '',
  };

  renderPage(req, res, 'pages/hub-home', {
    pageTitle: hub.title,
    socialDescr: hub.intro || hub.tagline || '',
    bodyClass: 'on-home on-hub',
    hub,
    mainSite,
    artists,
    totalArtists,
    rosterLimit: HOME_ROSTER_LIMIT,
    posts,
  });
});

export default router;
