// Afspeellijsten in beheer -- verplaatst uit inline script, shaer-bqr.
//
// Servergegevens (het csrf-token en drie teksten) komen uit pageData();
// interpolatie kan niet in een statisch bestand.

import { pageData } from './lib.js';

// Element-bedrading per render, dus init() per paginawissel (shaer-5s1).
export function init() { run(); }

function run() {
(function() {
  const _d = pageData();
  const csrf = _d.csrf || '';

  document.getElementById('pl-new-btn')?.addEventListener('click', () => {
    if (typeof window.openPlaylistEditor === 'function') {
      window.openPlaylistEditor({ mode: 'create', onSaved: () => location.reload() });
    }
  });

  // Click-to-copy on shortcodes
  document.querySelectorAll('[data-copy]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        el.classList.add('is-copied');
        const original = el.textContent;
        el.textContent = '✓ ' + (_d.copied || '');
        setTimeout(() => { el.classList.remove('is-copied'); el.textContent = original; }, 1200);
      } catch (_) { /* fall back to selection */ }
    });
  });

  document.querySelectorAll('[data-pl-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof window.openPlaylistEditor === 'function') {
        window.openPlaylistEditor({ mode: 'edit', id: btn.dataset.id, onSaved: () => location.reload() });
      }
    });
  });

  document.querySelectorAll('[data-pl-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const title = btn.dataset.title || id;
      if (!confirm((_d.delConfirm || '').replace('{title}', title))) return;
      try {
        const r = await fetch(`/admin/playlists/api/${encodeURIComponent(id)}/delete`, {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf },
          credentials: 'same-origin',
        });
        const j = await r.json();
        if (j.ok) location.reload();
        else alert((_d.delFailed || '') + ': ' + (j.error || ''));
      } catch (err) {
        alert((_d.delFailed || '') + ': ' + err.message);
      }
    });
  });

  // P52 — deep-link from playlist embed (?edit=<id>) auto-opens the editor.
  // openPlaylistEditor is defined synchronously by the included partial, so
  // it's available by the time this IIFE runs.
  (function deepLinkEdit() {
    const params = new URLSearchParams(location.search);
    const editId = params.get('edit');
    if (!editId) return;
    if (typeof window.openPlaylistEditor !== 'function') return;
    // Strip the query param immediately so reload after save doesn't re-open.
    history.replaceState({}, '', location.pathname);
    window.openPlaylistEditor({
      mode: 'edit',
      id: editId,
      onSaved: () => location.reload(),
    });
  })();
})();
}
