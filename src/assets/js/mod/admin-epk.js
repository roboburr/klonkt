// Het EPK-scherm in beheer (pages/admin-epk.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

// Element-bedrading leeft zo lang als de pagina; de bootstrap roept init()
// aan bij elke paginawissel waarop deze module actief is (shaer-5s1).
export function init() { run(); }

function run() {
(function () {
  var box = document.querySelector('.epk-track-pick');
  if (!box) return;
  var max = parseInt(box.dataset.max, 10) || 5;
  function sync() {
    var checks = box.querySelectorAll('input[type=checkbox]');
    var n = box.querySelectorAll('input[type=checkbox]:checked').length;
    checks.forEach(function (c) { c.disabled = (!c.checked && n >= max); });
  }
  box.addEventListener('change', sync);
  sync();
})();
}
