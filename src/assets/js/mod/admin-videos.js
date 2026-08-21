// Video's in beheer -- verplaatst uit inline script, shaer-bqr.
//
// Inline script wordt door de CSP geweigerd zodra deze pagina via een link
// BINNEN de site binnenkomt (shaer-0i6). Servergegevens komen uit pageData();
// interpolatie kan niet in een statisch bestand.

import { pageData } from './lib.js';

(function () {
  if (window.__videosWired) return; window.__videosWired = true;
  // Gedelegeerd op document, dus dit overleeft elke paginawissel -- ook op
  // pagina's waar [data-copy] iets ANDERS betekent (audio en playlists: een
  // shortcode, geen pad). Zonder deze wacht kaapt dit daar de kopieerklik en
  // plakt er een origin voor (shaer-5s1). T per klik gelezen, want pageData
  // wisselt mee met de pagina.
  function active() { return (document.body.getAttribute('data-js') || '').split(/\s+/).indexOf('admin-videos') !== -1; }
  document.addEventListener('click', function (e) {
    if (!active()) return;
    var T = pageData();
    var c = e.target.closest('[data-copy]');
    if (c) {
      var u = location.origin + c.getAttribute('data-copy');
      var done = function () { var o = c.textContent; c.textContent = '✓'; setTimeout(function () { c.textContent = o === '✓' ? T.copy : o; }, 1200); };
      if (navigator.clipboard) navigator.clipboard.writeText(u).then(done).catch(function () { window.prompt('URL', u); });
      else window.prompt('URL', u);
      return;
    }
    var d = e.target.closest('[data-del]');
    if (d) {
      if (!window.confirm(T.delC)) return;
      fetch('/admin/media/videos/delete', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: d.getAttribute('data-del') }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.ok) { var card = d.closest('.media-card'); if (card) card.remove(); } })
        .catch(function () {});
    }
  });
})();
