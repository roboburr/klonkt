/**
 * De wardmodus: een besloten Klonkt waarvan alleen het profiel openbaar is
 * (Robins ontwerp, 30-9).
 *
 * AAN ZOLANG DE SITE GUARDIANS HEEFT, en dat wordt niet opgeslagen maar
 * afgeleid. listGuardians telt alleen GEACCEPTEERDE guardianships: de modus gaat
 * aan zodra een koppeling rond is (niet bij een voorstel), en uit zodra de set
 * leeg is -- en de set leegmaken is emancipatie (FEP-633c 3.4). Dat is precies
 * waar het ontwerp de terugweg naar een gewone Klonkt legt. Een schakelaar zou
 * een tweede waarheid naast de guardianship zijn, die kan vergeten worden of
 * uit de pas kan lopen.
 *
 * WAT EEN BEZOEKER ZIET: de voorpagina wordt het profiel (naam, foto, bio,
 * links), en verder niets. Elke andere pagina stuurt terug naar dat profiel;
 * feeds, zoeken en alles wat geen pagina is geeft 404. STANDAARD DICHT: wat hier
 * niet op de lijst staat komt er niet langs, zodat een nieuwe route niet vanzelf
 * een kind openzet.
 *
 * WAT GEWOON DOORGAAT, en waarom:
 *   - de federatie (ActivityPub, WebFinger, OAuth voor de Shaer-app) en /media,
 *     /assets, /og: die hangen in server.js VOOR deze poort. Het kind post en
 *     volgt via Shaer, en de volgpoort van de guardians regelt wie er meeleest;
 *   - inloggen, het account, beheer en het guardianpaneel: die hebben hun eigen
 *     bewaking, en de ward moet erbij kunnen;
 *   - /audio/stream/: bewaakt elk bestand zelf, en een track die de ward op de
 *     fediverse opende moet daar speelbaar blijven.
 *
 * WIE ALLES ZIET: de ward zelf (eigenaar), en wie de site mag beheren of
 * bekijken (god, kijker, sitebeheer) -- dezelfde grens als elders.
 */

import * as Guardianship from '../services/guardianship/index.js';
import PermissionsService from '../services/PermissionsService.js';
import { parseProfileLinks } from '../services/PlatformIcons.js';
import { renderPage } from './render.js';

// Wat een bezoeker in de wardmodus WEL bereikt. Een map telt met alles eronder.
const OPEN_DIRS = ['/auth', '/account', '/admin', '/guardian', '/audio/stream', '/lang',
  // De federatie hangt in server.js al VOOR deze poort en komt hier dus nooit
  // langs. Ze staan er toch, voor als iemand de volgorde ooit omgooit: dan zou
  // een ward stil van de fediverse verdwijnen, en precies dat mag een
  // opruimactie niet kunnen veroorzaken.
  '/ap', '/.well-known', '/nodeinfo', '/oauth'];
const OPEN_FILES = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico', '/sw.js', '/robots.txt']);

function isOpenPath(p) {
  if (OPEN_FILES.has(p)) return true;
  return OPEN_DIRS.some((d) => p === d || p.startsWith(d + '/'));
}

/** Heeft deze site guardians? Dan is het een ward, en staat de modus aan. */
export function isWardSite(site) {
  if (!site || !site.slug) return false;
  try { return Guardianship.listGuardians(site.slug).length > 0; } catch { return false; }
}

/** Ziet deze gebruiker de hele site, ook in de wardmodus? */
export function seesWholeSite(user, site) {
  if (!user) return false;
  if (user.role === 'god' || user.role === 'kijker') return true;
  try { return !!PermissionsService.canAdminSite(user, site); } catch { return false; }
}

/** De fediverse-handle van de site: @slug@host. */
function handleOf(req, site) {
  let host = '';
  try { host = new URL(process.env.PUBLIC_BASE_URL || '').host; } catch { /* terugval hieronder */ }
  if (!host) host = req.get('host') || '';
  return host ? `@${site.slug}@${host}` : `@${site.slug}`;
}

function renderWardProfile(req, res) {
  const site = res.locals.site;
  return renderPage(req, res, 'pages/ward-profile', {
    pageTitle: site.profile_name || site.title || site.slug,
    bodyClass: 'on-ward-profile',
    wardHandle: handleOf(req, site),
    wardLinks: parseProfileLinks(site.profile_links),
  });
}

export function wardProfileGate(req, res, next) {
  const site = res.locals.site;
  res.locals.wardProfile = false;
  if (!isWardSite(site)) return next();
  if (seesWholeSite(req.session && req.session.user, site)) return next();

  // Vanaf hier: een bezoeker van een ward-site. De views lezen deze vlag om
  // niets aan te bieden wat toch dicht is (de zoekknop bijvoorbeeld).
  res.locals.wardProfile = true;
  const p = req.path;
  if (isOpenPath(p)) return next();

  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && p === '/') return renderWardProfile(req, res);

  const base = res.locals.siteUrlBase || '';
  if (isRead && req.get('hx-request') === 'true') {
    // Een htmx-navigatie zou het profiel als brokstuk in de pagina zetten.
    // HX-Redirect laat de browser echt naar het profiel gaan.
    res.set('HX-Redirect', base + '/');
    return res.status(204).end();
  }
  if (isRead && req.accepts(['html', 'json']) === 'html') return res.redirect(302, base + '/');
  return res.status(404).end();
}

export default { wardProfileGate, isWardSite, seesWholeSite };
