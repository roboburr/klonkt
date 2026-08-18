/**
 * OpenWebAuth (FEP-61cf), de drie plekken waar de stroom ons raakt.
 *
 *   POST /owa/login   de bezoeker geeft zijn adres, wij sturen hem naar huis
 *   ALL  /owa/token   zijn server vraagt ondertekend om een token (stap 2/3)
 *   GET  /owa/logout  weer anoniem
 *
 * Plus de middleware onderaan, die op ELK verzoek naar `?owt=` en `?zid=` kijkt.
 *
 * Zie OpenWebAuthService voor de stroom als geheel en voor de drie aanvallen
 * die de FEP beschrijft.
 */
import express from 'express';
import * as AP from '../services/ActivityPubService.js';
import * as OWA from '../services/OpenWebAuthService.js';

const router = express.Router();

/** Waar de bezoeker weer uitkomt. Altijd binnen onze eigen origin. */
function returnUrlFor(req, path) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  // Alleen een pad, nooit iets wat de bezoeker meegaf als volledige URL: dat is
  // hoe een aanmeldformulier een open redirect wordt.
  let p = String(path || '/');
  if (!p.startsWith('/') || p.startsWith('//')) p = '/';
  return base + p;
}

/**
 * Stap 2/3: de home instance vraagt ondertekend om een token.
 *
 * GET EN POST, want de FEP zegt dat sommige home instances een POST met een
 * willekeurig lijf sturen.
 *
 * De verificatie is niet nieuw geschreven: AP.verifyRequest() doet dit al voor
 * de inbox, inclusief het vastpinnen van de sleutel op de herkomst van de actor
 * (anders host je een document met andermans id naast je eigen sleutel), een
 * replay-venster op Date, en een verplichte digest zodra er een lijf is. Eén
 * implementatie van "is deze aanvraag echt van wie hij zegt".
 */
router.all('/owa/token', async (req, res) => {
  let verified = null;
  try { verified = await AP.verifyRequest(req); } catch { verified = null; }
  if (!verified || !verified.id) {
    return res.status(401).json({ success: false });
  }
  const pem = verified.publicKey && verified.publicKey.publicKeyPem;
  if (!pem) return res.status(400).json({ success: false });

  try {
    const token = OWA.issueToken(verified.id);
    // Versleuteld met ZIJN publieke sleutel: alleen de server die de bijbehorende
    // prive-sleutel heeft kan hem lezen. Daarmee bewijst de teruggave dat de
    // ondertekenaar ook echt die actor beheert, en niet alleen zijn document kent.
    return res.json({ success: true, encrypted_token: OWA.encryptTokenFor(token, pem) });
  } catch (e) {
    console.warn('[owa] token uitgeven mislukte:', e && e.message);
    return res.status(500).json({ success: false });
  }
});

/**
 * Stap 1: de bezoeker typt zijn adres en wij sturen hem naar zijn eigen server.
 *
 * We slaan hier NIETS op over wie hij zegt te zijn. Dat is opzet: pas het
 * ingewisselde token bepaalt de identiteit (zie de impersonatie-aanval in de
 * FEP). Een `zid`/handle is niet meer dan een routeringshint.
 */
router.post('/owa/login', async (req, res) => {
  const terug = returnUrlFor(req, req.body && req.body.next);
  const found = await OWA.discoverRedirectEndpoint(req.body && req.body.handle);
  if (!found) {
    const u = new URL(terug);
    u.searchParams.set('owa_error', '1');
    return res.redirect(u.toString());
  }
  return res.redirect(OWA.buildRedirect(found.endpoint, terug));
});

/** Weer anoniem. Raakt een eventuele lokale sessie niet aan. */
router.get('/owa/logout', (req, res) => {
  if (req.session) delete req.session.owa;
  res.redirect(returnUrlFor(req, req.query && req.query.next));
});

/**
 * Op elk verzoek: is er een token ingewisseld, of wil iemand de stroom starten?
 *
 * `owt` BEPAALT de identiteit. `zid` start hooguit de stroom en wordt verder
 * genegeerd -- dat onderscheid IS de impersonatie-verdediging uit de FEP.
 */
export function owaMiddleware(req, res, next) {
  if (req.method !== 'GET' || !req.query) return next();

  if (req.query.owt) {
    let actor = null;
    try { actor = OWA.redeemToken(req.query.owt); } catch { actor = null; }
    if (actor) req.session.owa = { actor, at: Date.now() };
    // Het token uit de URL halen: hij is toch al opgebruikt, en zo blijft hij
    // niet in de geschiedenis, de titelbalk of een gedeelde link staan.
    const u = new URL(req.originalUrl, process.env.PUBLIC_BASE_URL || 'https://localhost');
    u.searchParams.delete('owt');
    u.searchParams.delete('zid');
    return res.redirect(u.pathname + (u.search || ''));
  }

  if (req.query.zid && !OWA.guestActor(req)) {
    const u = new URL(req.originalUrl, process.env.PUBLIC_BASE_URL || 'https://localhost');
    u.searchParams.delete('zid');
    const terug = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') + u.pathname + (u.search || '');
    // Geen await in een middleware-keten die verder synchroon is: bij een fout
    // gaat de bezoeker gewoon door naar de pagina, alleen zonder inlog.
    OWA.discoverRedirectEndpoint(req.query.zid)
      .then((found) => {
        if (found) return res.redirect(OWA.buildRedirect(found.endpoint, terug));
        return res.redirect(terug);
      })
      .catch(() => res.redirect(terug));
    return;
  }

  return next();
}

export default router;
