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
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';

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
 * De handtekening staat hier in `Authorization`, niet in `Signature`.
 *
 * De FEP is er stellig over: "An OpenWebAuth signed request must have an
 * Authorization header starting with the word Signature". De rest van de
 * fediverse (en dus AP.verifyRequest) leest de `Signature`-header, zoals
 * Mastodon die stuurt. Twee gewoontes voor hetzelfde ding.
 *
 * Zonder deze vertaling zou elke ECHTE client -- Hubzilla, (streams), Forte --
 * hier een 401 krijgen terwijl hij alles goed deed, en zou pas de eerste
 * interop-proef dat aan het licht brengen.
 *
 * Geen mutatie van req: verifyRequest leest maar vier velden, dus we geven een
 * kopie mee. Zo blijft wat de rest van de keten ziet ongewijzigd.
 */
function metSignatureHeader(req) {
  const auth = String((req.headers && req.headers.authorization) || '');
  if (req.headers && req.headers.signature) return req;      // al in de gewone vorm
  if (!/^signature\s+/i.test(auth)) return req;              // niets te vertalen
  return {
    method: req.method,
    originalUrl: req.originalUrl,
    rawBody: req.rawBody,
    headers: { ...req.headers, signature: auth.replace(/^signature\s+/i, '') },
  };
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
  try { verified = await AP.verifyRequest(metSignatureHeader(req)); } catch { verified = null; }
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

/**
 * /magic — de HOME-kant: onze gebruiker bewijst zich bij een andere site.
 *
 * Hier zijn de rollen omgedraaid. Een doelsite stuurt onze ingelogde gebruiker
 * hierheen; wij halen daar ondertekend een token op, ontsleutelen het met onze
 * eigen prive-sleutel en sturen hem terug met ?owt=. Dit is de enige plek waar
 * die sleutel nodig is -- en meteen de reden dat alleen een echte instance deze
 * kant kan spelen.
 *
 * WELKE IDENTITEIT? Op Klonkt is de fediverse-identiteit de SITE, niet het
 * account. Wie één site heeft gaat meteen door; wie er meer heeft kiest er een,
 * want ondertekenen en ontsleutelen kunnen alleen met een sleutel die hij ook
 * echt beheert.
 *
 * EN ER IS EEN TUSSENSCHERM, met opzet. De FEP waarschuwt onder "Information
 * leakage": OpenWebAuth geeft een STERKE identiteitsclaim af aan elke site die
 * erom vraagt, desnoods zonder dat je iets merkt. Deze omweg langs je eigen
 * server is het enige moment waarop je kunt zeggen: deze site niet.
 */
function eigenSites(user) {
  if (!user || !user.id) return [];
  return db.prepare('SELECT slug, title FROM sites WHERE owner_id = ? ORDER BY is_primary DESC, created_at ASC')
    .all(user.id);
}

/** De doelsite waar dit heen gaat, alleen om te TONEN. Beslissen doet bdest. */
function doelHost(bdest) { try { return new URL(bdest).host; } catch { return ''; } }

router.get('/magic', (req, res) => {
  const bdest = OWA.fromBdest(req.query && req.query.bdest);
  if (!bdest) return res.status(400).type('text/plain').send('bad bdest');

  // Niet ingelogd? Dan eerst hier inloggen, en daarna terug naar dit scherm --
  // met de bdest nog intact, anders is de hele stroom weg.
  if (!(req.session && req.session.user)) {
    const terug = '/magic?owa=1&bdest=' + encodeURIComponent(String(req.query.bdest));
    return res.redirect('/auth/login?next=' + encodeURIComponent(terug));
  }

  const sites = eigenSites(req.session.user);
  if (!sites.length) return res.status(403).type('text/plain').send('geen eigen actor om mee te tekenen');

  return renderPage(req, res, 'pages/owa-consent', {
    pageTitle: 'Aanmelden bij ' + doelHost(bdest.href),
    bodyClass: 'on-special',
    owaHost: doelHost(bdest.href),
    owaBdest: String(req.query.bdest),
    owaSites: sites,
  });
});

/**
 * De gebruiker zei ja. Nu pas gaan we tekenen.
 *
 * De open-redirect-verdediging van deze kant zit in discoverTokenEndpoint(): de
 * FEP zegt dat we bij een mislukte ontdekking NIET naar bdest mogen doorsturen,
 * want dan is /magic het doorgeefluik. Vandaar dat elke fout hieronder een
 * foutpagina geeft en geen redirect.
 */
router.post('/magic', async (req, res) => {
  const bdest = OWA.fromBdest(req.body && req.body.bdest);
  if (!bdest) return res.status(400).type('text/plain').send('bad bdest');
  if (!(req.session && req.session.user)) return res.status(401).type('text/plain').send('niet ingelogd');

  // De gekozen site moet er een van HEM zijn: anders tekent hij met andermans
  // sleutel, en dat is precies het gat dat je hier niet wilt.
  const sites = eigenSites(req.session.user);
  const gekozen = sites.find((s) => s.slug === String(req.body.slug || '')) || sites[0];
  if (!gekozen) return res.status(403).type('text/plain').send('geen eigen actor');

  const endpoint = await OWA.discoverTokenEndpoint(bdest.href);
  if (!endpoint) return res.status(502).type('text/plain').send('die site biedt geen OpenWebAuth aan');

  try {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const keys = AP.getOrCreateKeys(gekozen.slug);
    const keyId = AP.actorId(base, gekozen.slug) + '#main-key';
    const versleuteld = await OWA.requestToken(endpoint, { keyId, privatePem: keys.private_pem });
    if (!versleuteld) return res.status(502).type('text/plain').send('geen token gekregen');
    const token = OWA.decryptToken(versleuteld, keys.private_pem);
    if (!token) return res.status(502).type('text/plain').send('token onleesbaar');
    const terug = new URL(bdest.href);
    terug.searchParams.set('owt', token);
    return res.redirect(terug.toString());
  } catch (e) {
    console.warn('[owa] /magic mislukte:', e && e.message);
    return res.status(502).type('text/plain').send('aanmelden mislukte');
  }
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
