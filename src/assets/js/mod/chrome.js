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
  // ── Het zoeken: de balk bovenaan, het vak met resultaten eronder ─────
  // Twee plekken, één vorm (Robins ontwerp, 30-9): de overlay die op elke
  // pagina kan openen, en de pagina /search?q=... zelf. Alles hieronder werkt
  // op elk .search-surface, zodat de twee zich ook hetzelfde gedragen.
  function overlay() { return document.getElementById('search-overlay'); }
  function openSearch() {
    var o = overlay(); if (!o) return;
    var inp = o.querySelector('input[name="q"]');
    var box = o.querySelector('.search-box-inner');
    // Een verse start: tekst en resultaten van de vorige keer horen niet te
    // blijven staan als je hem opnieuw opent.
    if (inp) inp.value = '';
    if (box) box.innerHTML = '';
    o.hidden = false;
    document.documentElement.classList.add('search-open');
    if (inp) inp.focus();
  }
  function closeSearch() {
    var o = overlay(); if (!o) return;
    o.hidden = true;
    document.documentElement.classList.remove('search-open');
  }

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

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function texts(surface) { try { return JSON.parse(surface.getAttribute('data-i18n') || '{}'); } catch (e) { return {}; } }

  // Iets dat van een andere server moet komen: een adres of een handle. Dezelfde
  // regels als lookupUri en lookupHandle in routes/search.js. Hier alleen om te
  // weten of er meteen een wachtregel moet staan: de server beslist daarna
  // zelf, met de rechten erbij.
  function isRemoteLookup(q) {
    if (/^https?:\/\//i.test(q) && !/\s/.test(q)) {
      try { return new URL(q).hostname.indexOf('.') >= 0; } catch (e) { return false; }
    }
    return /^@?[a-z0-9_.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(q);
  }

  // Elke zoekopdracht krijgt een volgnummer per vlak. Een ophaling van een
  // andere server duurt soms seconden; zonder nummer overschrijft een traag
  // antwoord op een oude vraag wat je inmiddels hebt getypt.
  function runSearch(surface, now) {
    if (!surface) return;
    var inp = surface.querySelector('input[name="q"]');
    var box = surface.querySelector('.search-box-inner');
    if (!inp || !box) return;
    var q = inp.value.trim();
    var seq = (surface.__seq = (surface.__seq || 0) + 1);
    clearTimeout(surface.__timer);
    if (q.length < 2) { box.innerHTML = ''; return; }
    var remote = isRemoteLookup(q);
    if (remote) box.innerHTML = '<div class="sr-loading">' + esc(texts(surface).looking) + '</div>';
    // Op de pagina beweegt het adres mee, zodat wat je ziet te delen blijft.
    if (surface.classList.contains('is-page') && history.replaceState) {
      history.replaceState(history.state, '', (surface.getAttribute('data-action') || '/search') + '?q=' + encodeURIComponent(q));
    }
    surface.__timer = setTimeout(function() {
      var url = surface.getAttribute('data-results') || '/search/results';
      fetch(url + '?q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
        .then(function(r) { return r.status === 200 ? r.text() : ''; })
        .then(function(html) {
          if (seq !== surface.__seq) return;
          box.innerHTML = html;
          // De links naar een post zijn htmx-links; wat via innerHTML binnenkomt
          // kent htmx nog niet.
          if (window.htmx && window.htmx.process) window.htmx.process(box);
        })
        .catch(function() {});
    }, now ? 0 : (remote ? 300 : 200));
  }
  document.addEventListener('input', function(e) {
    var inp = e.target.closest && e.target.closest('.search-surface input[name="q"]');
    if (inp) runSearch(inp.closest('.search-surface'), false);
  });
  // Enter blijft waar hij is: het vak IS de resultaten. Zonder JS gaat het
  // formulier naar /search, dat er precies zo uitziet.
  document.addEventListener('submit', function(e) {
    var f = e.target.closest && e.target.closest('.search-bar-form');
    if (!f) return;
    e.preventDefault();
    runSearch(f.closest('.search-surface'), true);
  });
  // Sluiten op de pagina is teruggaan, als je van deze site kwam; anders volgt
  // de link naar het begin van de site.
  document.addEventListener('click', function(e) {
    var leave = e.target.closest && e.target.closest('[data-search-leave]');
    if (!leave) return;
    if (document.referrer.indexOf(location.origin + '/') === 0 && history.length > 1) { e.preventDefault(); history.back(); }
  });
  // Een klik op een resultaat in de overlay sluit hem, want de link gaat ergens
  // heen. Behalve wat in een nieuw tabblad opent: dan blijf je hier.
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('#search-overlay .search-box a');
    if (a && a.getAttribute('target') !== '_blank') closeSearch();
  });
})();

// ── De kaart van een post van een andere server ─────────────────────────
// Staat hier en niet in authorize-interaction.js, want de kaart staat nu op
// drie plekken: de live-preview (elke pagina, via de zoekbalk), de zoekpagina
// en /authorize_interaction. Alles luistert op document, dus een kaart die
// later binnenkomt (de preview, een htmx-wissel) doet vanzelf mee.
(function() {
  if (window.__remoteCardWired) return; window.__remoteCardWired = true;

  // Waarderen en boosten ter plekke: POST via fetch, de knop omzetten, blijven
  // waar je bent. Zonder JS doet het formulier hetzelfde met een omweg.
  document.addEventListener('submit', function(e) {
    var f = e.target.closest && e.target.closest('.fedi-react-form');
    if (!f) return;
    e.preventDefault();
    var btn = f.querySelector('button'); if (!btn || btn.disabled) return;
    btn.disabled = true;
    var body = new URLSearchParams();
    new FormData(f).forEach(function(v, k) { body.append(k, v); });
    fetch(f.action, { method: 'POST', body: body, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(j) {
        if (!j) return;
        var on = !!j.on;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        var lbl = btn.querySelector('.rp-act-label');
        if (lbl) lbl.textContent = on ? (btn.getAttribute('data-on') || lbl.textContent) : (btn.getAttribute('data-off') || lbl.textContent);
      })
      .catch(function() {})
      .then(function() { btn.disabled = false; });
  });

  // Antwoorden klapt open waar de kaart staat. Staat er geen venster (de
  // preview), dan volgt de knop gewoon zijn link naar de volle pagina, met het
  // venster daar al open.
  document.addEventListener('click', function(e) {
    var open = e.target.closest && e.target.closest('[data-rp-reply]');
    var close = !open && e.target.closest && e.target.closest('[data-rp-reply-close]');
    if (!open && !close) return;
    var panel = document.getElementById('rp-reply');
    if (!panel) return;
    e.preventDefault();
    var btn = document.querySelector('[data-rp-reply][aria-controls="rp-reply"]');
    var show = !!open && panel.hidden;
    panel.hidden = !show;
    if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      var ed = panel.querySelector('.re-editor, textarea');
      if (ed) ed.focus();
      // Op een telefoon staat het venster vaak onder de vouw.
      if (panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (btn) {
      btn.focus();
    }
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
