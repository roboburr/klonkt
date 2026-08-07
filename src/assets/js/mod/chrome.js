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

// ── de profielkop ──────────────────────────────────────────────
// Zat inline in partials/profile-header.ejs, en die partial zit IN de
// OOB-chrome -- dus hij kwam bij elke navigatie opnieuw binnen.
(function () {
  if (window.__pcmsFediFollowWired) return;
  window.__pcmsFediFollowWired = true;
  function modal() { return document.querySelector('.pf-follow'); }
  function closeM() { var m = modal(); if (m) m.classList.remove('is-open'); }
  function go() {
    var m = modal(); if (!m) return;
    var inp = m.querySelector('.pf-follow-input'), raw = inp ? inp.value : '';
    // Strip a full @user@host handle (and any scheme/path) down to the server host.
    var server = String(raw || '').trim().replace(/^@?[^@\s]*@/, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    if (!server) { if (inp) inp.focus(); return; }
    try { localStorage.setItem('pcmsFediServer', server); } catch (e) {}
    var actor = location.origin + '/ap/users/' + encodeURIComponent(m.getAttribute('data-actor-slug') || '');
    location.href = 'https://' + server + '/authorize_interaction?uri=' + encodeURIComponent(actor);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.profile-fedi-link');
    if (b) { e.preventDefault();
      var m = modal(); if (!m) return;
      m.setAttribute('data-actor-slug', b.getAttribute('data-fedi-actor-slug') || '');
      var inp = m.querySelector('.pf-follow-input');
      try { if (inp && !inp.value) inp.value = localStorage.getItem('pcmsFediServer') || ''; } catch (e2) {}
      m.classList.add('is-open');
      setTimeout(function () { if (inp) inp.focus(); }, 30);
      return;
    }
    if (e.target.closest && e.target.closest('.pf-follow-go')) { e.preventDefault(); go(); return; }
    if (e.target.closest && e.target.closest('.pf-follow-cancel')) { e.preventDefault(); closeM(); return; }
    var open = document.querySelector('.pf-follow.is-open');
    if (open && e.target === open) closeM(); /* click on backdrop */
  });
  document.addEventListener('keydown', function (e) {
    var m = document.querySelector('.pf-follow.is-open'); if (!m) return;
    if (e.key === 'Escape') { closeM(); }
    else if (e.key === 'Enter' && e.target.closest && e.target.closest('.pf-follow')) { e.preventDefault(); go(); }
  });
})();

/* Profile summary: click the avatar to open a modal with photo + details. */
(function () {
  if (window.__pcmsLightboxWired) return; window.__pcmsLightboxWired = true;
  function close() { var m = document.querySelector('.pf-summary.is-open'); if (m) m.classList.remove('is-open'); }
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.pf-summary-close')) { e.preventDefault(); close(); return; }
    var open = document.querySelector('.pf-summary.is-open');
    if (open && e.target === open) { close(); return; } /* click on backdrop */
    var t = e.target.closest && e.target.closest('.profile-photo[data-pf-summary]');
    if (!t) return;
    e.preventDefault();
    var root = (t.closest && t.closest('#pcms-chrome')) || document;
    var modal = root.querySelector('.pf-summary') || document.querySelector('.pf-summary');
    if (modal) modal.classList.add('is-open');
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
