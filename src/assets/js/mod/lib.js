// Gedeeld gereedschap voor de pagina-modules (shaer-bqr).

/**
 * De servergegevens van deze pagina.
 *
 * Een module is een statisch bestand, dus er kan geen EJS in. Wat het script van
 * de server nodig heeft -- vertalingen, ids, instellingen -- zet de pagina in
 * een <script type="application/json"> via partials/page-data.ejs, en dit leest
 * het terug.
 *
 * ELKE KEER OPNIEUW LEZEN en niet eenmalig onthouden: bij een htmx-navigatie
 * wisselt de inhoud terwijl de module blijft leven, dus een gegevensblok dat je
 * bij het laden vasthoudt is een pagina later verouderd.
 *
 * Nooit een uitzondering: een module die valt over ontbrekende gegevens neemt de
 * hele pagina mee. Wat er niet is, is een leeg object.
 */
export function pageData() {
  try {
    var el = document.querySelector('script[type="application/json"][data-page-data]');
    return el ? (JSON.parse(el.textContent) || {}) : {};
  } catch (e) {
    return {};
  }
}

/**
 * Een enkele waarde, met een terugval. Scheelt in elke module hetzelfde
 * gedoe met ontbrekende sleutels.
 */
export function pageValue(key, fallback) {
  var d = pageData();
  return (d && Object.prototype.hasOwnProperty.call(d, key)) ? d[key] : fallback;
}

/**
 * Listeners op document en window overleven een paginawissel; de pagina zelf
 * niet. Een module die per navigatie opnieuw start (export init) registreert
 * zulke listeners hier, en veegt bij elke start de vorige lichting weg --
 * anders stapelen ze, elk met een closure naar elementen die al weg zijn.
 *
 * Listeners op ELEMENTEN hoeven hier niet doorheen: die sterven met hun
 * element bij de swap. Alleen wat het document overleeft, moet geveegd.
 */
export function makeSweeper() {
  let list = [];
  return {
    on(target, ev, fn, opts) { target.addEventListener(ev, fn, opts); list.push([target, ev, fn, opts]); },
    sweep() { for (const [t, ev, fn, opts] of list) t.removeEventListener(ev, fn, opts); list = []; },
  };
}

/**
 * Een tekst veilig in HTML zetten.
 *
 * De modules bouwen op sommige plekken HTML met stringplakwerk. Vroeger ging een
 * vertaling daar door de escapende EJS-tag heen; nu niet meer. Zonder deze functie
 * breekt een apostrof in een vertaling het attribuut af waar hij in staat -- het
 * soort fout dat pas in een andere taal opvalt.
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * De WebAuthn-bibliotheek erbij halen, vanuit JavaScript (shaer-0i6).
 *
 * Hij stond als `<script src>` in paid-gate.ejs en paid-passkey.ejs, en dat
 * werkt alleen bij een volledige laadbeurt. Kom je op zo'n pagina via een link
 * BINNEN de site, dan is het een htmx-fragment met de nonce van een ANDER
 * verzoek, en weigert de CSP hem. Het gevolg was stil: de module laadde wel,
 * vond `window.SimpleWebAuthnBrowser` niet, en de knop deed niets -- op het
 * passkey- en betaalpad.
 *
 * Een dynamische import vanuit deze module mag wel: de shell startte hem met
 * een geldige nonce, en `strict-dynamic` bestaat er juist voor dat vertrouwde
 * scripts verder mogen laden. Het bestand is een UMD-bundel; zonder CommonJS
 * of AMD zet die zichzelf op globalThis, dus na afloop staat de global er.
 *
 * Faalt het laden, dan geeft dit undefined terug en niet een fout: beide
 * aanroepers hebben al een nette terugval voor "geen WebAuthn hier".
 */
export async function loadWebAuthn() {
  if (window.SimpleWebAuthnBrowser) return window.SimpleWebAuthnBrowser;
  try { await import('/assets/vendor/simplewebauthn-browser.umd.min.js'); }
  catch (e) { console.warn('[paid] WebAuthn-bibliotheek laadt niet:', e && e.message); }
  return window.SimpleWebAuthnBrowser;
}
