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
