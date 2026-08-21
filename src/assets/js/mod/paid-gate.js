// De betaalmuur -- verplaatst uit inline script, shaer-bqr.
//
// Inline script wordt door de CSP geweigerd zodra deze pagina via een link
// BINNEN de site binnenkomt (shaer-0i6). Servergegevens komen uit pageData();
// interpolatie kan niet in een statisch bestand.

import { pageData } from './lib.js';

// Element-bedrading leeft zo lang als de pagina; de bootstrap roept init()
// aan bij elke paginawissel waarop deze module actief is (shaer-5s1).
export function init() { run(); }

function run() {
(function () {
  var _d = pageData();
  var base = _d.base || "";
  var slug = _d.slug || "";
  var hasPatron = !!_d.hasPatron;
  var I = _d.i18n || {};
  var btn = document.getElementById('pg-unlock');
  var status = document.getElementById('pg-status');
  function say(msg, err) { status.hidden = false; status.textContent = msg; status.classList.toggle('is-err', !!err); }
  function toLink() { location.href = base + '/paid/link?post=' + encodeURIComponent(slug); }

  // No WebAuthn here: an assertion is impossible. With a Patreon page there is
  // already a "Word supporter" button, so hide the (dead) unlock button rather
  // than turn it into a second "Word supporter". Without one, this IS the button.
  if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) {
    if (hasPatron) { btn.style.display = 'none'; }
    else { btn.textContent = I.join; btn.addEventListener('click', toLink); }
    return;
  }

  btn.addEventListener('click', function () {
    btn.disabled = true;
    say(I.confirm);
    fetch(base + '/paid/challenge?post=' + encodeURIComponent(slug))
      .then(function (r) { if (!r.ok) throw { link: true }; return r.json(); })
      .then(function (data) {
        return window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: data.options })
          .then(function (response) {
            return fetch(base + '/paid/unlock', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ response: response, blob: data.blob }),
            });
          });
      })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.j && res.j.ok && res.j.redirect) {
          // Reload the real post page via the one-shot unlock capability, so it
          // renders through its normal template (layout, styles, audio).
          location.href = res.j.redirect;
        } else if (res.status === 403) {
          toLink();   // no valid passkey yet (or lapsed tier): link via Patreon
        } else {
          btn.disabled = false; say(I.failed, true);
        }
      })
      .catch(function (e) {
        if (e && e.link) { toLink(); return; }
        if (e && e.name === 'NotAllowedError') { toLink(); return; }   // cancelled / no passkey -> link
        btn.disabled = false; say(I.error, true);
      });
  });
})();
}
