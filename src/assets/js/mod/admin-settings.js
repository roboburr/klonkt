// Instellingen in beheer (pages/admin-settings.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

    (function () {
      var f = document.getElementById('mode-form');
      if (!f || f.__age18wired) return; f.__age18wired = true;
      f.addEventListener('submit', function (e) {
        var sel = f.querySelector('input[name=mode]:checked');
        if (sel && sel.value === 'cirkels' && f.getAttribute('data-was-cirkels') === '0') {
          if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
        }
      });
    })();
    
