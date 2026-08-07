// De downloadpagina -- verplaatst uit inline script, shaer-bqr.
//
// Inline script wordt door de CSP geweigerd zodra deze pagina via een link
// BINNEN de site binnenkomt (shaer-0i6). Wat de server meegeeft komt uit
// pageData(); interpolatie kan niet in een statisch bestand.

import { pageData } from './lib.js';

// Element-bedrading leeft zo lang als de pagina; de bootstrap roept init()
// aan bij elke paginawissel waarop deze module actief is (shaer-5s1).
export function init() { run(); }

function run() {
        // Auto-start de download (zelfde-origin attachment-link).
        setTimeout(function(){ try { window.location.href = (pageData().fileUrl || ''); } catch(e){} }, 600);
}
