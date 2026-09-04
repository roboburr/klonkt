// De passkey-ontgrendeling -- verplaatst uit inline script, shaer-bqr.
//
// Inline script wordt door de CSP geweigerd zodra deze pagina via een link
// BINNEN de site binnenkomt (shaer-0i6). Servergegevens komen uit pageData();
// interpolatie kan niet in een statisch bestand.

import { pageData, loadWebAuthn } from './lib.js';

// Element-bedrading leeft zo lang als de pagina; de bootstrap roept init()
// aan bij elke paginawissel waarop deze module actief is (shaer-5s1).
//
// EERST de bibliotheek, dan pas bedraden (shaer-0i6): die stond als
// `<script src>` in de pagina en overleefde een htmx-navigatie niet. Wacht
// run() daar niet op, dan ziet hij de global nog niet staan en zet hij de
// knop uit terwijl er niets aan de hand is.
export async function init() { await loadWebAuthn(); run(); }

function run() {
(function () {
  var _d = pageData();
  var options = _d.options || {};
  var blob = _d.blob || "";
  var I = _d.i18n || {};
  var postUrl = _d.postUrl || "";
  var btn = document.getElementById('pk-go');
  var status = document.getElementById('pk-status');
  function say(msg, err) { status.hidden = false; status.textContent = msg; status.classList.toggle('is-err', !!err); }

  if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) {
    btn.disabled = true;
    say(I.unsupported, true);
    return;
  }
  btn.addEventListener('click', function () {
    btn.disabled = true;
    say(I.follow);
    window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options })
      .then(function (response) {
        return fetch('/paid/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: response, blob: blob }),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { say(I.done); setTimeout(function () { location.href = postUrl; }, 900); }
        else { btn.disabled = false; say(I.failed.replace('{err}', (j && j.error) || '?'), true); }
      })
      .catch(function (e) { btn.disabled = false; say(e && e.name === 'NotAllowedError' ? I.cancelled : I.error, true); });
  });
})();
}
