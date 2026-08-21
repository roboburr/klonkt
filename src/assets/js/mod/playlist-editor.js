// De afspeellijst-editor -- verplaatst uit inline script, shaer-bqr.
//
// Servergegevens komen uit pageData(); interpolatie kan niet in een statisch
// bestand. Inline script wordt bovendien geweigerd zodra deze pagina via een
// link BINNEN de site binnenkomt (shaer-0i6).

import { pageData } from './lib.js';

/**
 * De teksten van deze modal, uit het gegevensblok van partials/playlist-editor.ejs.
 *
 * EIGEN BLOK en niet pageData(): die pakt met querySelector er EEN, en deze
 * modal hangt onder pagina's die er zelf al een hebben. Een tweede blok zou
 * daar genegeerd worden.
 *
 * De terugval is bewust de sleutelnaam en niet de Nederlandse tekst: ontbreekt
 * er iets, dan zie je DAT er iets ontbreekt in plaats van een pagina die er
 * half vertaald uitziet en waarvan niemand merkt welke helft.
 */
let _T = null;
function T(sleutel) {
  if (_T === null) {
    try {
      const el = document.querySelector('script[type="application/json"][data-playlist-editor-i18n]');
      _T = el ? (JSON.parse(el.textContent) || {}) : {};
    } catch (e) { _T = {}; }
  }
  return _T[sleutel] != null ? _T[sleutel] : sleutel;
}

(function() {
  // Idempotency: if window.openPlaylistEditor already defined (multiple
  // partial includes on a single page), skip re-binding.
  if (typeof window.openPlaylistEditor === 'function') return;

  const CSRF = pageData().csrf || '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function fmtDur(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async function api(method, url, body) {
    const opts = {
      method, credentials: 'same-origin',
      headers: { 'X-CSRF-Token': CSRF },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    return r.json();
  }

  /**
   * Public entry point: open the editor.
   *  opts: { mode: 'create'|'edit', id?, onSaved? }
   *  onSaved is called with { id, playlist } after a successful save.
   */
  window.openPlaylistEditor = async function(opts) {
    opts = opts || {};
    const mode = opts.mode === 'edit' ? 'edit' : 'create';
    const isEdit = mode === 'edit';

    // Load all audio tracks for the picker
    let tracks = [];
    try {
      const j = await api('GET', '/admin/playlists/api/tracks');
      if (Array.isArray(j.tracks)) tracks = j.tracks;
    } catch (e) {
      alert(T('e_tracks'));
      return;
    }
    if (!tracks.length) {
      alert(T('e_geen_tracks'));
      return;
    }

    // Existing playlist data when editing
    let initial = { title: '', artist: '', year: '', cover: '', kind: 'album', release_date: '', mb_release_id: '', track_ids: [] };
    if (isEdit && opts.id) {
      try {
        const j = await api('GET', '/admin/playlists/api/' + encodeURIComponent(opts.id));
        if (j.ok) initial = { ...initial, ...j.playlist };
      } catch (e) {}
    }

    // ── DOM ────────────────────────────────────────────────────────
    const backdrop = document.createElement('div');
    backdrop.className = 'pl-modal-backdrop';
    backdrop.innerHTML = `
      <div class="pl-modal" role="dialog" aria-label="${T('dialoog')}">
        <div class="pl-modal-header">
          <h3>${isEdit ? '✎ ' + T('t_edit') : '+ ' + T('t_new')}</h3>
          <button type="button" class="pl-modal-close" aria-label="${T('sluiten')}">×</button>
        </div>
        <div class="pl-modal-body">
          <div class="pl-editor-cols">
            <div class="pl-editor-left">
              <div class="pl-meta-grid">
                <label class="pl-field pl-field-full">
                  <span>${T('titel')}</span>
                  <input type="text" id="pli-title" maxlength="200" autofocus value="${esc(initial.title)}">
                </label>
                <label class="pl-field">
                  <span>${T('artiest')}</span>
                  <input type="text" id="pli-artist" maxlength="200" value="${esc(initial.artist)}">
                </label>
                <label class="pl-field">
                  <span>${T('jaar')}</span>
                  <input type="number" id="pli-year" min="1900" max="2099" value="${initial.year || ''}">
                </label>
                <label class="pl-field">
                  <span>${T('type')}</span>
                  <select id="pli-kind">
                    <option value="album"    ${initial.kind === 'album' ? 'selected' : ''}>💿 ${T('k_album')}</option>
                    <option value="playlist" ${initial.kind === 'playlist' ? 'selected' : ''}>📃 ${T('k_playlist')}</option>
                  </select>
                </label>
                <label class="pl-field pl-uitgave">
                  <span>${T('uitgave')}</span>
                  <input type="date" id="pli-release-date" value="${esc(initial.release_date || '')}">
                </label>
                <label class="pl-field pl-uitgave">
                  <span>${T('mb_release')}</span>
                  <input type="text" id="pli-mb-release" maxlength="36" spellcheck="false"
                         placeholder="00000000-0000-0000-0000-000000000000"
                         value="${esc(initial.mb_release_id || '')}">
                </label>
                <div class="pl-field pl-field-full">
                  <span>${T('cover')}</span>
                  <div class="pl-cover-row">
                    <span class="pl-cover-thumb" id="pli-cover-thumb">
                      ${initial.cover
                        ? `<img src="${esc(initial.cover)}" alt="">`
                        : `<span class="pl-cover-empty">🎨</span>`}
                    </span>
                    <input type="text" id="pli-cover" placeholder="${T('cover_url')}" value="${esc(initial.cover)}" style="flex:1">
                  </div>
                  <div class="pl-cover-upload-row">
                    <input type="file" id="pli-cover-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
                    <button type="button" class="pl-btn-small" id="pli-cover-pick">📷 ${T('cover_kies')}</button>
                    <span class="pl-cover-status" id="pli-cover-status"></span>
                  </div>
                </div>
              </div>
              <div class="pl-section-title">
                ${T('tracks_in')} <span class="pl-track-count" id="pli-count">0</span>
                <small>${T('sleep_hint')}</small>
              </div>
              <div id="pli-selected" class="pl-selected-list"></div>
            </div>
            <div class="pl-editor-right">
              <div class="pl-section-title">${T('beschikbaar')}</div>
              <input type="search" id="pli-search" placeholder="${T('zoek')}" class="pl-search-input">
              <div id="pli-available" class="pl-available-list"></div>
            </div>
          </div>
        </div>
        <div class="pl-modal-footer">
          <button type="button" class="btn" id="pli-cancel">${T('annuleren')}</button>
          <button type="button" class="btn btn-primary" id="pli-save" disabled>
            ${isEdit ? T('opslaan') : T('aanmaken')}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const $ = sel => backdrop.querySelector(sel);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    $('.pl-modal-close').addEventListener('click', close);
    $('#pli-cancel').addEventListener('click', close);

    // Index tracks by id for fast lookup
    const trackById = new Map(tracks.map(t => [t.id, t]));
    let selected = (initial.track_ids || []).filter(id => trackById.has(id));

    const titleEl = $('#pli-title');
    const artistEl = $('#pli-artist');
    const yearEl = $('#pli-year');
    const kindEl = $('#pli-kind');
    const releaseEl = $('#pli-release-date');
    const mbReleaseEl = $('#pli-mb-release');
    const coverEl = $('#pli-cover');

    // Uitgavedatum en release-id horen bij een ALBUM, niet bij een
    // afspeellijst -- dat is wat de keuze album/playlist betekent. Ze
    // verdwijnen dus als je omschakelt, en de server maakt ze dan ook leeg;
    // dit scherm is de uitleg, niet de bewaking.
    const toonUitgave = () => {
      const album = kindEl.value !== 'playlist';
      for (const el of backdrop.querySelectorAll('.pl-uitgave')) el.hidden = !album;
    };
    kindEl.addEventListener('change', toonUitgave);
    toonUitgave();
    const coverThumb = $('#pli-cover-thumb');
    const saveBtn = $('#pli-save');
    const selectedEl = $('#pli-selected');
    const availEl = $('#pli-available');
    const searchEl = $('#pli-search');
    const countEl = $('#pli-count');

    coverEl.addEventListener('input', () => {
      const u = coverEl.value.trim();
      coverThumb.innerHTML = u
        ? `<img src="${esc(u)}" alt="" data-fallback>`
        : `<span class="pl-cover-empty">🎨</span>`;
    });

    // ── Cover file upload (werkt in create ÉN edit) ───────────
    // We uploaden naar het generieke image-endpoint (/posts/upload-image,
    // requireAuth) dat een /media/-URL teruggeeft — dat heeft GEEN playlist-id
    // nodig, dus uploaden kan ook al vóór het aanmaken. De URL belandt in het
    // cover-veld en wordt bij het opslaan met de playlist meegestuurd.
    const coverFileInput = $('#pli-cover-file');
    const coverPickBtn   = $('#pli-cover-pick');
    const coverStatus    = $('#pli-cover-status');
    if (coverFileInput && coverPickBtn) {
      coverPickBtn.addEventListener('click', () => coverFileInput.click());
      coverFileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        coverFileInput.value = '';
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          coverStatus.textContent = T('e_alleen_afb');
          coverStatus.className = 'pl-cover-status is-error';
          return;
        }
        coverStatus.textContent = T('bezig');
        coverStatus.className = 'pl-cover-status';
        const fd = new FormData();
        fd.append('image', file);
        try {
          const r = await fetch('/posts/upload-image',
            { method: 'POST', body: fd, credentials: 'same-origin' }
          );
          const j = await r.json();
          if (!r.ok || !j.url) throw new Error(j.error || T('e_upload'));
          const url = j.url || '';
          coverEl.value = url;
          coverThumb.innerHTML = url
            ? `<img src="${esc(url)}" alt="">`
            : `<span class="pl-cover-empty">🎨</span>`;
          coverStatus.textContent = '✓ Geüpload';
          coverStatus.className = 'pl-cover-status is-ok';
        } catch (err) {
          coverStatus.textContent = T('e_mislukt') + err.message;
          coverStatus.className = 'pl-cover-status is-error';
        }
      });
    }

    function updateSaveBtn() {
      saveBtn.disabled = !titleEl.value.trim() || selected.length === 0;
    }

    function renderSelected() {
      countEl.textContent = selected.length;
      if (selected.length === 0) {
        selectedEl.innerHTML = '<div class="pl-empty">' + T('leeg_sel') + '</div>';
        updateSaveBtn();
        return;
      }
      selectedEl.innerHTML = selected.map((id, i) => {
        const t = trackById.get(id);
        if (!t) return '';
        const cover = t.cover
          ? `<span class="pl-row-cover"><img src="${esc(t.cover)}" alt=""></span>`
          : `<span class="pl-row-cover pl-row-cover-empty">♪</span>`;
        return `<div class="pl-row" data-id="${esc(id)}" data-pos="${i}">
          <span class="pl-row-handle" aria-label="${T('versleep')}">⠿</span>
          <span class="pl-row-num">${i + 1}</span>
          ${cover}
          <span class="pl-row-info">
            <span class="pl-row-title">${esc(t.title)}</span>
            ${t.artist ? `<span class="pl-row-artist">${esc(t.artist)}</span>` : ''}
          </span>
          <button type="button" class="pl-row-x" data-id="${esc(id)}" aria-label="${T('verwijder')}">×</button>
        </div>`;
      }).join('');

      selectedEl.querySelectorAll('.pl-row-x').forEach(b => {
        b.addEventListener('click', () => {
          selected = selected.filter(x => x !== b.dataset.id);
          renderSelected();
          renderAvailable();
        });
      });
      bindDrag();
      updateSaveBtn();
    }

    function renderAvailable() {
      const q = searchEl.value.trim().toLowerCase();
      const matches = tracks.filter(t => {
        if (!q) return true;
        return (t.title || '').toLowerCase().includes(q)
            || (t.artist || '').toLowerCase().includes(q);
      });
      if (matches.length === 0) {
        availEl.innerHTML = '<div class="pl-empty">' + T('geen_res') + '</div>';
        return;
      }
      availEl.innerHTML = matches.map(t => {
        const isAdded = selected.includes(t.id);
        const cls = ['pl-avail-row'];
        if (isAdded) cls.push('is-added');
        if (!t.playable) cls.push('is-unplayable');
        const cover = t.cover
          ? `<span class="pl-row-cover"><img src="${esc(t.cover)}" alt=""></span>`
          : `<span class="pl-row-cover pl-row-cover-empty">♪</span>`;
        return `<div class="${cls.join(' ')}" data-id="${esc(t.id)}" ${t.playable ? '' : `title="${T('geen_audio')}"`}>
          ${cover}
          <span class="pl-row-info">
            <span class="pl-row-title">${esc(t.title)}</span>
            ${t.artist ? `<span class="pl-row-artist">${esc(t.artist)}${t.duration ? ' · ' + fmtDur(t.duration) : ''}</span>` : ''}
          </span>
          <span class="pl-avail-action">${isAdded ? '✓' : '+'}</span>
        </div>`;
      }).join('');

      availEl.querySelectorAll('.pl-avail-row').forEach(row => {
        if (row.classList.contains('is-unplayable')) return;
        row.addEventListener('click', () => {
          const id = row.dataset.id;
          if (selected.includes(id)) selected = selected.filter(x => x !== id);
          else selected.push(id);
          renderSelected();
          renderAvailable();
        });
      });
    }

    // Pointer-based drag-to-reorder. Same pattern as v9's admin.js.
    function bindDrag() {
      selectedEl.querySelectorAll('.pl-row').forEach(row => {
        const handle = row.querySelector('.pl-row-handle');
        if (!handle) return;
        let dragging = false, originalIdx = -1;

        handle.addEventListener('pointerdown', e => {
          e.preventDefault();
          handle.setPointerCapture(e.pointerId);
          dragging = true;
          originalIdx = parseInt(row.dataset.pos, 10);
          row.classList.add('is-dragging');
        });
        handle.addEventListener('pointermove', e => {
          if (!dragging) return;
          e.preventDefault();
          const rows = Array.from(selectedEl.querySelectorAll('.pl-row'));
          rows.forEach(r => r.classList.remove('drop-above', 'drop-below'));
          let targetIdx = -1, above = false;
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i]; if (r === row) continue;
            const rect = r.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (e.clientY < mid && targetIdx === -1) { targetIdx = i; above = true; break; }
            if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
              targetIdx = i; above = e.clientY < mid; break;
            }
          }
          if (targetIdx !== -1) rows[targetIdx].classList.add(above ? 'drop-above' : 'drop-below');
        });
        const finish = e => {
          if (!dragging) return;
          dragging = false;
          try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
          row.classList.remove('is-dragging');
          const rows = Array.from(selectedEl.querySelectorAll('.pl-row'));
          let targetIdx = -1, above = false;
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('drop-above')) { targetIdx = i; above = true; break; }
            if (rows[i].classList.contains('drop-below')) { targetIdx = i; above = false; break; }
          }
          rows.forEach(r => r.classList.remove('drop-above', 'drop-below'));
          if (targetIdx === -1 || targetIdx === originalIdx) return;
          const moved = selected[originalIdx];
          selected.splice(originalIdx, 1);
          let newIdx = targetIdx;
          if (originalIdx < targetIdx) newIdx--;
          if (!above) newIdx++;
          newIdx = Math.max(0, Math.min(selected.length, newIdx));
          selected.splice(newIdx, 0, moved);
          renderSelected();
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', () => {
          dragging = false;
          row.classList.remove('is-dragging');
          selectedEl.querySelectorAll('.drop-above, .drop-below')
            .forEach(r => r.classList.remove('drop-above', 'drop-below'));
        });
      });
    }

    titleEl.addEventListener('input', updateSaveBtn);
    searchEl.addEventListener('input', renderAvailable);
    renderSelected();
    renderAvailable();

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      const orig = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = T('bezig_opslaan');

      const payload = {
        title:  titleEl.value.trim(),
        artist: artistEl.value.trim(),
        year:   parseInt(yearEl.value, 10) || 0,
        cover:  coverEl.value.trim(),
        kind:   kindEl.value === 'playlist' ? 'playlist' : 'album',
        release_date:  releaseEl.value.trim(),
        mb_release_id: mbReleaseEl.value.trim(),
        tracks: selected.slice(),
      };

      try {
        const url = isEdit
          ? '/admin/playlists/api/' + encodeURIComponent(initial.id)
          : '/admin/playlists/api';
        const j = await api('POST', url, payload);
        if (!j.ok) {
          alert(T('e_opslaan') + (j.error || 'onbekend'));
          saveBtn.disabled = false;
          saveBtn.textContent = orig;
          return;
        }
        const savedId = isEdit ? initial.id : j.id;
        close();
        if (typeof opts.onSaved === 'function') {
          opts.onSaved({ id: savedId, playlist: payload });
        }
      } catch (err) {
        alert(T('e_opslaan') + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = orig;
      }
    });

    // ESC to close
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && document.body.contains(backdrop)) {
        close();
        document.removeEventListener('keydown', onEsc);
      }
    });
  };
})();
