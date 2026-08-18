/**
 * Wat mag DEZE bezoeker van DIT bericht zien?
 *
 * De vraag stond tot nu toe alleen in de postroute, en daar werd hij beantwoord
 * door een ANDERE PAGINA te renderen: paid-gate of fan-gate in plaats van het
 * bericht. Dat werkt zolang een bericht een pagina is. Zodra de tijdlijn hele
 * berichten toont, moet hetzelfde besluit een STUK opleveren dat tussen de
 * andere berichten past -- en twee plekken die allebei zelf beslissen wie wat
 * mag zien, zijn een lek dat wacht op een gelegenheid.
 *
 * Dus één functie, en de route en de tijdlijn lezen er allebei uit. Deze module
 * bepaalt alleen WAT er mag; hoe het eruitziet is aan de sjablonen.
 */
import PermissionsService from './PermissionsService.js';

/**
 * De teaser van een betaald bericht: nooit meer dan de eerste alinea.
 *
 * Stond als paidTeaser() in routes/posts.js. Hier neergezet omdat de tijdlijn
 * hem ook nodig heeft, en een tweede kopie vroeg of laat meer prijsgeeft dan
 * deze -- precies de fout die je bij een betaalmuur niet wilt maken.
 */
export function paidTeaser(post, max = 280) {
  if (post && post.excerpt && String(post.excerpt).trim()) return String(post.excerpt).trim();
  const html = String((post && post.content) || '');
  const firstP = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [null, html])[1] || '';
  const text = firstP.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;
}

/**
 * Het besluit, als één waarde.
 *
 *   'full'      → de hele inhoud
 *   'paid'      → betaalmuur: teaser + ontgrendelknop
 *   'fan'       → alleen voor fans: teaser + inloggen
 *   'forbidden' → niet gepubliceerd en jij mag het niet bewerken
 *
 * De VOLGORDE is niet vrijblijvend. Betaald wordt vóór fan-only getoetst, want
 * een bericht dat allebei is gaat open met een passkey en niet met een
 * Klonkt-login; andersom belandt een anonieme supporter op het inlogscherm en
 * ziet hij de ontgrendelknop nooit. Die regel stond als commentaar in de route
 * en verhuist hier mee, want hij hoort bij het besluit en niet bij de pagina.
 *
 * @param post     de rij uit `posts`
 * @param viewer   { user, site, unlockedSlug, isFollower } -- unlockedSlug is de
 *                 slug uit een vers ?u=-bewijs van /paid/unlock, al geverifieerd
 *                 door de aanroeper; isFollower komt uit OpenWebAuthService en
 *                 zegt dat een bewezen fedi-actor deze site volgt. Deze module
 *                 doet geen crypto en raakt de database niet aan: ophalen doet
 *                 de aanroeper, beslissen doet deze.
 */
export function postAccess(post, { user = null, site = null, unlockedSlug = null, isFollower = false } = {}) {
  if (!post) return 'forbidden';

  const canEdit = !!(user && PermissionsService.canEditPost(user, post, site));

  // Een concept is van de maker. Dit stond vóór beide poorten in de route en
  // hoort dat te blijven: over een ongepubliceerd bericht valt niets te kopen
  // en niets te ontgrendelen.
  if (post.status !== 'published' && !canEdit) return 'forbidden';

  // De eigenaar/redacteur ziet altijd zijn eigen werk, betaald of niet.
  if (canEdit) return 'full';

  if (post.paid && String(unlockedSlug || '') !== String(post.slug)) return 'paid';
  // `fan_only` betekende altijd al "mijn volgers op de fediverse", maar de poort
  // vroeg om een lokaal account -- de verkeerde vraag, die juist de mensen
  // buitensloot voor wie hij openstond. `isFollower` is het antwoord op de
  // ECHTE vraag: een bezoeker die via OpenWebAuth bewees @iemand@ergens te zijn
  // en die deze site volgt. Wie dat bewijs levert, komt binnen.
  //
  // Het lokale account blijft er ook door, zoals het altijd deed: dat is een
  // andere manier om te weten wie iemand is, niet een mindere.
  if (post.fan_only && !user && !isFollower) return 'fan';
  return 'full';
}

/** Handig voor sjablonen: mag de bezoeker de echte inhoud zien? */
export function canReadBody(post, viewer) { return postAccess(post, viewer) === 'full'; }

/**
 * Eén bericht, klaar voor de tijdlijn.
 *
 * DE HELE REDEN DAT DIT EEN FUNCTIE IS: het lijf wordt alleen GERENDERD als het
 * ook getoond mag worden. Een sjabloon dat zelf `<% if (access === 'full') %>`
 * doet krijgt de volledige tekst tóch mee in het model, en dan is het één
 * vergeten conditie -- of één `?partial=1` die net iets anders samenstelt --
 * tussen een betaalmuur en de tekst erachter. Hier komt hij niet eens mee.
 *
 * `renderBody` wordt ingespoten (posts.js levert renderPostBodyHtml), zodat
 * deze module niets van routes of sjablonen hoeft te weten.
 */
export function postEntry(post, viewer, { renderBody } = {}) {
  const access = postAccess(post, viewer);
  const full = access === 'full';
  return {
    slug: post && post.slug,
    title: (post && post.title) || '',
    access,
    // Alleen bij een gesloten poort een teaser, en nooit allebei: de teaser is
    // de vervanging van het lijf, niet een voorproefje ernaast.
    teaser: full || access === 'forbidden' ? null : paidTeaser(post),
    content_html: full && typeof renderBody === 'function' ? renderBody(post) : null,
  };
}

export default { postAccess, canReadBody, paidTeaser, postEntry };
