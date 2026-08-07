// Betaalde posts in beheer (pages/admin-paid.ejs) -- verplaatst uit inline script, shaer-bqr.
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
  var field = document.getElementById('pd-redirect');
  var btn = document.getElementById('pd-copy');
  if (!field || !btn) return;
  field.addEventListener('focus', function () { field.select(); });
  btn.addEventListener('click', function () {
    field.select();
    var done = function () { var t = btn.textContent; btn.textContent = document.getElementById('pd-copy').getAttribute('data-copied'); setTimeout(function () { btn.textContent = t; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(field.value).then(done, function () { try { document.execCommand('copy'); done(); } catch (e) {} }); }
    else { try { document.execCommand('copy'); done(); } catch (e) {} }
  });
})();
}
