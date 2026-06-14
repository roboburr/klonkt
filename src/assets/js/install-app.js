/**
 * install-app.js — handles the "Installeer app" button in the footer.
 *
 * Behavior:
 *  - Hides itself if the user is already running the site as an installed PWA
 *    (display-mode: standalone) or iOS web-app.
 *  - On click, opens a modal with platform-specific instructions:
 *      iOS     → "Voeg toe aan beginscherm" via Safari share sheet
 *      Android → PWA install (1-tap if available, else Chrome ⋮-menu instructions)
 *      Desktop → instructions for Chrome/Edge install icon, or native prompt if available
 *  - Listens for `beforeinstallprompt` (Android Chrome / desktop Chromium) and
 *    deferreds it so the modal's "Install as PWA" button can fire it.
 *
 * Markup contract: <button data-pcms-install-app>
 *
 * CSS: .install-app-btn / .install-modal* / .install-choice* — defined in
 * style.css (carried over from v9 import).
 */
(function() {
  'use strict';
  const btn = document.querySelector('[data-pcms-install-app]');
  if (!btn) return;

  // Already running standalone → no point showing the button.
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true;
  if (isStandalone) { btn.style.display = 'none'; return; }

  const ua        = navigator.userAgent;
  const isIOS     = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);

  // Capture Chrome/Edge native install prompt so we can fire it from our modal.
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.classList.add('has-native-prompt');
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    btn.style.display = 'none';
  });

  function showModal(innerHTML) {
    const m = document.createElement('div');
    m.className = 'install-modal';
    m.innerHTML = `
      <div class="install-modal-backdrop"></div>
      <div class="install-modal-panel" role="dialog" aria-labelledby="install-title" aria-modal="true">
        ${innerHTML}
        <div class="install-modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Sluiten</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('.install-modal-backdrop').addEventListener('click', close);
    m.querySelector('[data-close]').addEventListener('click', close);
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });

    // If a [data-install-pwa] button is in the modal AND a deferredPrompt is
    // available: clicking triggers the native install dialog.
    const pwaBtn = m.querySelector('[data-install-pwa]');
    if (pwaBtn) {
      pwaBtn.addEventListener('click', () => {
        if (!deferredPrompt) { close(); return; }
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(() => {
          deferredPrompt = null;
          close();
        });
      });
    }
  }

  function iosInstructions() {
    showModal(`
      <h3 id="install-title" style="margin:0 0 .5rem">📲 Installeer op iOS</h3>
      <p style="margin:0 0 1rem;opacity:.8">Om deze site als app op je home-scherm te zetten:</p>
      <ol class="install-steps">
        <li>Tik op het <strong>deel-icoon</strong>
          <svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:middle;margin:0 2px"><path d="M12 2L8 6h3v9h2V6h3l-4-4zm7 10v8H5v-8H3v8a2 2 0 002 2h14a2 2 0 002-2v-8h-2z" fill="currentColor"/></svg>
          onderaan in Safari
        </li>
        <li>Scroll tot je <strong>"Voeg toe aan beginscherm"</strong> ziet (soms achter "Meer…")</li>
        <li>Geef de app eventueel een naam en tik op <strong>Voeg toe</strong></li>
      </ol>
      <p style="margin:1rem 0 0;opacity:.7;font-size:.85rem">⚠️ Werkt alleen in Safari — niet in Chrome op iOS (Apple-beleid).</p>
    `);
  }

  function androidInstructions() {
    const nativeLine = deferredPrompt
      ? `<button type="button" class="install-choice-cta" data-install-pwa>📱 Installeer als PWA (1 tik)</button>`
      : `<p class="install-choice-note">Open deze site in <strong>Chrome</strong> en kies in het <strong>⋮-menu → "App installeren"</strong> (of "Aan beginscherm toevoegen").</p>`;

    showModal(`
      <h3 id="install-title" style="margin:0 0 .5rem">🤖 Installeer op Android</h3>
      <p style="margin:0 0 1rem;opacity:.8">Voeg deze site als app toe aan je beginscherm:</p>
      <ul class="install-steps" style="opacity:.85">
        <li>Instant — geen download of toestemmingen</li>
        <li>Updatet automatisch bij elke wijziging</li>
        <li>Minder opslag dan een losse app</li>
      </ul>
      ${nativeLine}
      <p style="margin:1rem 0 0;opacity:.7;font-size:.85rem">⚠️ Werkt het best in Chrome.</p>
    `);
  }

  function desktopInstructions() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => { deferredPrompt = null; });
      return;
    }
    showModal(`
      <h3 id="install-title" style="margin:0 0 .5rem">💻 Installeer op desktop</h3>
      <p style="margin:0 0 1rem;opacity:.8">In Chrome, Edge of een andere Chromium-browser:</p>
      <ol class="install-steps">
        <li>Zoek het <strong>installeer-icoon</strong>
          <svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:middle;margin:0 2px"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>
          in de adresbalk</li>
        <li>Klik erop en bevestig</li>
      </ol>
      <p style="margin:1rem 0 0;opacity:.7;font-size:.85rem">Firefox/Safari desktop ondersteunen PWA-install niet — gebruik een bookmark.</p>
    `);
  }

  btn.addEventListener('click', () => {
    if (isIOS)     return iosInstructions();
    if (isAndroid) return androidInstructions();
    return desktopInstructions();
  });
})();
