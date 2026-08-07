// De chrome: alles wat om elke pagina heen staat (shaer-bqr).
//
// Dit stond als inline <script> in de partials. Dat kan niet blijven: de
// CSP-nonce rouleert per verzoek, en de chrome wordt bij ELKE htmx-navigatie
// out-of-band opnieuw ingevoegd. Zo'n script draagt dan een nonce die het
// document niet kent en wordt geweigerd -- dus viel de chrome-JS bij de eerste
// klik binnen de site al weg (shaer-0i6).
//
// Nu een module, geladen door de bootstrap in shell.ejs. Die zit in het
// document zelf, heeft dus wel de goede nonce, en een dynamische import vanuit
// een vertrouwd script is precies waar 'strict-dynamic' voor is.
//
// TWEE REGELS voor alles wat hier bij komt:
//
//   GEDELEGEERD  luister op document, nooit op een element dat er nu staat. De
//                chrome wordt vervangen, dus een vastgehouden verwijzing is na
//                een navigatie een verwijzing naar iets dat weg is.
//   IDEMPOTENT   de module kan een tweede keer geladen worden. Een slot op
//                window voorkomt dat er een tweede stel luisteraars bij komt --
//                dat is hoe de themaknop ooit twee keer vuurde en dus niets deed.
//
// En: GEEN servergegevens in deze code. Interpolatie hoort niet in een statisch
// bestand; wat de server wil meegeven komt via een data-attribuut op een element.

(function () {
  'use strict';
  if (window.__chromeMod) return;
  window.__chromeMod = true;

  // De zoekknop in de bottom-tab opent de overlay. De overlay zelf wordt bij een
  // htmx-navigatie vervangen, dus hem hier vasthouden zou na een klik binnen de
  // site niets meer opleveren: elke keer opnieuw opzoeken.
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('#bottom-tab-search-toggle')) return;
    var o = document.getElementById('search-overlay');
    if (o) {
      o.hidden = false;
      var i = o.querySelector('input');
      if (i) i.focus();
    }
  });
})();
