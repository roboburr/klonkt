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

// ── de topnav ──────────────────────────────────────────────────
// Zat inline in partials/topnav.ejs. De zoekteksten komen nu van het
// overlay-element (data-i18n) in plaats van uit interpolatie.
(function() {
  // Wired ONCE. This chrome (topnav) is re-inserted out-of-band during htmx navigation
  // → without this guard the script would stack EXTRA listeners on every navigation,
  // causing the theme toggle to fire 2× (or more) = no net change ("toggle stops working").
  // Everything below uses event delegation on body/document, so it also works for
  // buttons that appear after this run (OOB).
  if (window.__pcmsChromeWired) return;
  window.__pcmsChromeWired = true;

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('pcms-theme', next); } catch (e) {}
  }
  function overlay() { return document.getElementById('search-overlay'); }
  function openSearch() { var o = overlay(); if (o) { o.hidden = false; var i = o.querySelector('input'); if (i) i.focus(); } }
  function closeSearch() { var o = overlay(); if (o) { o.hidden = true; var b = document.getElementById('search-suggest'); if (b) b.innerHTML = ''; } }

  document.body.addEventListener('click', function(e) {
    if (e.target.closest('#theme-toggle, #theme-toggle-mobile, #theme-toggle-footer')) { toggleTheme(); return; }
    if (e.target.closest('#search-toggle')) { openSearch(); return; }
    if (e.target.closest('#search-close')) { closeSearch(); return; }
    // Close open dropdowns (user menu + language picker) on click outside.
    document.querySelectorAll('.user-menu[open], .lang-menu[open]').forEach(function(d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { var o = overlay(); if (o && !o.hidden) closeSearch(); }
  });

  // ── Live results while typing ───────────────────────────────────
  // De teksten komen van de overlay zelf, elke keer opnieuw: bij een
  // htmx-navigatie wordt die vervangen en kan de taal gewisseld zijn.
  function _st() {
    var o = document.getElementById('search-overlay');
    try { return JSON.parse((o && o.getAttribute('data-i18n')) || '{}'); } catch (e) { return {}; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function renderSuggest(box, d, q, ov) {
    var html = '';
    function grp(title, items, fmt) {
      if (!items || !items.length) return;
      html += '<div class="ss-group"><div class="ss-title">' + esc(title) + '</div>' + items.map(fmt).join('') + '</div>';
    }
    grp(_st().posts, d.posts, function(p){ return '<a class="ss-item" href="' + esc(p.url) + '">' + esc(p.title) + '</a>'; });
    grp(_st().tracks, d.tracks, function(tk){ var sub = tk.artist ? ' <span class="ss-sub">' + esc(tk.artist) + '</span>' : ''; return tk.url ? '<a class="ss-item" href="' + esc(tk.url) + '">' + esc(tk.title) + sub + '</a>' : '<span class="ss-item ss-noclick">' + esc(tk.title) + sub + '</span>'; });
    grp(_st().events, d.events, function(ev){ return '<a class="ss-item" href="' + esc(ev.url) + '">' + esc(ev.where || ev.when) + ' <span class="ss-sub">' + esc(ev.when) + '</span></a>'; });
    grp(_st().pages, d.pages, function(pg){ return '<a class="ss-item" href="' + esc(pg.url) + '">' + esc(pg.label) + '</a>'; });
    var hasAny = (d.posts && d.posts.length) || (d.tracks && d.tracks.length) || (d.events && d.events.length) || (d.pages && d.pages.length);
    if (!hasAny) { box.innerHTML = '<div class="ss-empty">' + esc(_st().none) + '</div>'; return; }
    var action = (ov && ov.getAttribute('data-action')) || '/search';
    html += '<a class="ss-all" href="' + esc(action) + '?q=' + encodeURIComponent(q) + '">' + esc(_st().all) + '</a>';
    box.innerHTML = html;
  }
  var _sTimer;
  document.addEventListener('input', function(e) {
    var inp = e.target.closest && e.target.closest('#search-overlay input[name="q"]');
    if (!inp) return;
    var box = document.getElementById('search-suggest');
    if (!box) return;
    var q = inp.value.trim();
    clearTimeout(_sTimer);
    if (q.length < 2) { box.innerHTML = ''; return; }
    _sTimer = setTimeout(function() {
      var ov = document.getElementById('search-overlay');
      var url = (ov && ov.getAttribute('data-suggest')) || '/search/suggest';
      fetch(url + '?q=' + encodeURIComponent(q))
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){ if (d) renderSuggest(box, d, q, ov); })
        .catch(function(){});
    }, 200);
  });
  // Click on a suggestion → close the overlay (the link/boost handles navigation).
  document.addEventListener('click', function(e) {
    if (e.target.closest && e.target.closest('#search-suggest a')) { var o = overlay(); if (o) o.hidden = true; }
  });
})();

// ── het profielblad ────────────────────────────────────────────
// Zat inline in partials/profile-sheet.ejs, dat de shell opneemt.
(function() {
  const sheet = document.getElementById('profile-sheet');
  if (!sheet) return;

  const backdrop  = document.getElementById('profile-sheet-backdrop');
  const panel     = sheet.querySelector('.profile-sheet-panel');
  const closeBtn  = document.getElementById('profile-sheet-close');
  const dragZone  = document.getElementById('profile-sheet-drag-zone');
  const themeBtn  = document.getElementById('profile-sheet-theme');
  const themeLbl  = document.getElementById('profile-sheet-theme-state');

  function openSheet() {
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('profile-sheet-locked');
    syncTheme();
  }
  function closeSheet() {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('profile-sheet-locked');
    panel.style.removeProperty('--pcms-drag-y');
  }

  // Open: any element with [data-profile-sheet-toggle]
  document.addEventListener('click', function(e) {
    const trigger = e.target.closest('[data-profile-sheet-toggle]');
    if (trigger) {
      e.preventDefault();
      openSheet();
    }
  });

  // Close: backdrop tap, handle tap, ESC, or any [data-close-sheet] item
  if (backdrop) backdrop.addEventListener('click', closeSheet);
  if (closeBtn) closeBtn.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('is-open')) closeSheet();
  });

  // Menu items that navigate: close synchronously before nav fires
  sheet.querySelectorAll('[data-close-sheet]').forEach((el) => {
    el.addEventListener('click', closeSheet);
  });

  // Drag-down-to-close on touch.
  // Uses --pcms-drag-y custom property rather than overwriting the panel's
  // transform string. This composes correctly with any horizontal centering
  // (currently none here, but the pattern matches audio-sheet for safety).
  let startY = 0, lastY = 0, dragging = false;
  function onDown(e) {
    if (e.pointerType !== 'touch') return;
    if (panel.scrollTop > 0) return;
    startY = lastY = e.clientY;
    dragging = true;
    panel.classList.add('is-dragging');
  }
  function onMove(e) {
    if (!dragging) return;
    lastY = e.clientY;
    const dy = Math.max(0, lastY - startY);
    panel.style.setProperty('--pcms-drag-y', dy + 'px');
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    const dy = lastY - startY;
    if (dy > 80) closeSheet();
    else panel.style.removeProperty('--pcms-drag-y');
  }
  if (window.PointerEvent && dragZone) {
    dragZone.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // Theme toggle inside sheet — syncs label
  function syncTheme() {
    if (!themeLbl) return;
    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    // De twee labels staan op het element zelf: een module kan geen vertaling
    // interpoleren, en zo hoort de tekst bij het ding dat hem toont.
    themeLbl.textContent = themeLbl.getAttribute(t === 'dark' ? 'data-dark' : 'data-light') || themeLbl.textContent;
  }
  if (themeBtn) {
    themeBtn.addEventListener('click', function() {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pcms-theme', next); } catch (e) {}
      syncTheme();
    });
  }
})();
