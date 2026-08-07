// Het hulpscherm in beheer (pages/admin-help.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

(function () {
  var q = document.getElementById('hb-q');
  var items = [].slice.call(document.querySelectorAll('.hb-item'));
  var empty = document.getElementById('hb-empty');
  var count = document.getElementById('hb-count');
  if (!q) return;
  // Bewaar de originele tekst per item (voor highlight-reset).
  items.forEach(function (it) { it._txt = it.textContent.toLowerCase(); });
  function run() {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    items.forEach(function (it) {
      var hit = !term || it._txt.indexOf(term) >= 0;
      it.classList.toggle('hb-hidden', !hit);
      if (hit) shown++;
    });
    empty.hidden = shown !== 0;
    count.textContent = term ? (shown + ' onderwerp' + (shown === 1 ? '' : 'en') + ' gevonden') : '';
  }
  q.addEventListener('input', run);
})();
