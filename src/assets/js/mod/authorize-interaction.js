// Interactie autoriseren (pages/authorize-interaction.ejs) -- verplaatst uit inline script, shaer-bqr.
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
      // Element-vlag, geen window-vlag: na een swap is de knop een NIEUW element
      // en moet hij opnieuw bedraad; een window-vlag zou dat voorgoed blokkeren.
      var a = document.getElementById('fedi-bm-btn'); if (!a || a.__wired) return; a.__wired = true;
      a.setAttribute('href', "javascript:void(window.open('" + location.origin + "/authorize_interaction?uri='+encodeURIComponent(window.location.href)))");
      a.addEventListener('click', function (e) { e.preventDefault(); a.classList.add('nudge'); setTimeout(function(){ a.classList.remove('nudge'); }, 600); });
    })();
    

// ── volgend blok ──

      (function () {
        if (window.__fediEditWired) return; window.__fediEditWired = true;
        document.addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('.fedi-edit-btn');
          if (!b) return;
          var li = b.closest('.fedi-manage-item'); if (!li) return;
          var form = li.querySelector('.fedi-edit-form'); if (!form) return;
          var open = form.classList.toggle('is-open');
          b.classList.toggle('is-open', open);
          b.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) { var ed = form.querySelector('.re-editor') || form.querySelector('textarea'); if (ed) ed.focus(); }
        });
      })();
      

// ── volgend blok ──

/* Waarderen en boosten ter plekke staat sinds de herbouw van de kaart in
   chrome.js: de kaart staat nu ook in de zoekbalk, op elke pagina. */
}
