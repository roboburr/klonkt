// Het registratieformulier (pages/auth-register.ejs) -- verplaatst uit inline script, shaer-bqr.
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
  var u = document.getElementById('setup-username'), out = document.getElementById('setup-handle');
  if (!u || !out) return;
  function upd() {
    var v = (u.value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'username';
    out.textContent = '@' + v + '@' + location.host;
  }
  u.addEventListener('input', upd);
  upd();
})();
}
