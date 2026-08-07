// De track-editor (beheer > audio) (partials/track-editor.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

(function() {

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      if (body instanceof FormData) {
        opts.body = body;
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    let data;
    try { data = await res.json(); }
    catch (_) { throw new Error('Onverwacht antwoord (' + res.status + ')'); }
    if (!res.ok) data.ok = false;
    return data;
  }

  /**
   * Open the track editor.
   * @param {object} opts
   * @param {string} opts.id        — track id to edit
   * @param {function?} opts.onSaved — called with updated track on success
   */
  window.openTrackEditor = async function openTrackEditor({ id, onSaved }) {
    if (!id) return;
    let track, albumSuggestions = [];
    try {
      const [trackJson, listJson] = await Promise.all([
        api('GET', '/admin/audio/api/' + encodeURIComponent(id)),
        api('GET', '/admin/audio/api/albums'),
      ]);
      if (!trackJson.ok) throw new Error(trackJson.error || 'Track niet gevonden');
      track = trackJson.track;
      if (listJson.ok && Array.isArray(listJson.albums)) {
        albumSuggestions = listJson.albums.filter(Boolean);
      }
    } catch (err) {
      alert('Track ophalen mislukt: ' + err.message);
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'te-backdrop';
    backdrop.innerHTML = `
      <div class="te-modal" role="dialog" aria-modal="true" aria-label="Track bewerken">
        <div class="te-handle" aria-hidden="true"><span class="te-handle-bar"></span></div>

        <div class="te-header">
          <h3>✎ Track bewerken</h3>
          <button type="button" class="te-close" aria-label="Sluiten">×</button>
        </div>

        <div class="te-body">

          ${track.stream_url ? `
          <div class="te-preview">
            <div class="te-preview-cover">
              ${track.cover_url
                ? `<img src="${esc(track.cover_url)}" alt="">`
                : `🎵`}
            </div>
            <div class="te-preview-meta">
              <div class="te-preview-title">${esc(track.title || '(zonder titel)')}</div>
              <div class="te-preview-sub">
                ${esc(track.artist || '—')}${track.album ? ' · ' + esc(track.album) : ''}
              </div>
            </div>
            <button type="button" class="te-preview-play" id="te-preview-play" aria-label="Afspelen">▶</button>
          </div>
          ` : ''}

          <div class="te-form">

            <label class="te-field">
              <span>Titel <span class="te-required" aria-hidden="true">*</span></span>
              <input type="text" id="te-title" maxlength="200" required
                     autocomplete="off" autocapitalize="words" spellcheck="false"
                     value="${esc(track.title || '')}">
            </label>

            <div class="te-row te-row-2">
              <label class="te-field">
                <span>Artiest</span>
                <input type="text" id="te-artist" maxlength="200"
                       autocomplete="off" autocapitalize="words" spellcheck="false"
                       value="${esc(track.artist || '')}">
              </label>
              <label class="te-field">
                <span>Album</span>
                <input type="text" id="te-album" maxlength="200"
                       autocomplete="off" autocapitalize="words" spellcheck="false"
                       list="te-album-list" value="${esc(track.album || '')}">
                <datalist id="te-album-list">
                  ${albumSuggestions.map(a => `<option value="${esc(a)}">`).join('')}
                </datalist>
              </label>
            </div>

            <label class="te-field">
              <span>Duur <small>(seconden — automatisch bepaald, hier te overschrijven)</small></span>
              <input type="number" id="te-duration" min="0" step="1"
                     inputmode="numeric" pattern="[0-9]*"
                     value="${track.duration || ''}" placeholder="auto">
            </label>

            <div class="te-row te-row-2">
              <label class="te-field">
                <span>Eigenaar / credit <small>(copyright-houder)</small></span>
                <div class="te-credit-row">
                  <input type="text" id="te-credit" maxlength="200"
                         autocomplete="off" spellcheck="false"
                         placeholder="bv. © 2025 Mara Vos"
                         value="${esc(track.credit || '')}">
                  <button type="button" class="te-sym-btn" id="te-credit-copyr"
                          title="© invoegen" aria-label="Copyright-teken invoegen">©</button>
                </div>
              </label>
              <label class="te-field">
                <span>Licentie</span>
                <input type="text" id="te-license" maxlength="120"
                       autocomplete="off" spellcheck="false" list="te-license-list"
                       placeholder="Alle rechten voorbehouden"
                       value="${esc(track.license || '')}">
                <datalist id="te-license-list">
                  <option value="Alle rechten voorbehouden"></option>
                  <option value="CC BY 4.0"></option>
                  <option value="CC BY-SA 4.0"></option>
                  <option value="CC BY-NC 4.0"></option>
                  <option value="CC BY-NC-SA 4.0"></option>
                  <option value="CC BY-ND 4.0"></option>
                  <option value="CC0 1.0 (publiek domein)"></option>
                </datalist>
              </label>
            </div>

            <div class="te-field">
              <span>Open in <small>(links naar dezelfde track elders)</small></span>
              <input type="url" id="te-link-spotify" inputmode="url" autocomplete="off" spellcheck="false"
                     placeholder="Spotify-URL (https://open.spotify.com/…)" value="${esc(track.link_spotify || '')}">
              <input type="url" id="te-link-youtube" inputmode="url" autocomplete="off" spellcheck="false"
                     placeholder="YouTube-URL (https://youtu.be/…)" value="${esc(track.link_youtube || '')}">
              <input type="url" id="te-link-soundcloud" inputmode="url" autocomplete="off" spellcheck="false"
                     placeholder="SoundCloud-URL (https://soundcloud.com/…)" value="${esc(track.link_soundcloud || '')}">
            </div>

            <div class="te-field">
              <span>Audiobestand</span>
              <div class="te-cover-btn-row">
                <input type="file" id="te-audio-file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac" hidden>
                <button type="button" class="te-cover-btn" id="te-audio-pick">${track.stream_url ? '🔁 Vervang audiobestand' : '🎵 Audiobestand kiezen'}</button>
                <span class="te-cover-status" id="te-audio-status"></span>
              </div>
            </div>

            <div class="te-field">
              <span>Cover</span>
              <div class="te-cover-row">
                <div class="te-cover-thumb" id="te-cover-thumb" tabindex="0" role="button"
                     aria-label="Klik om cover te kiezen">
                  ${track.cover_url
                    ? `<img src="${esc(track.cover_url)}" alt="">`
                    : `<span class="te-cover-empty">🎨</span>`}
                </div>
                <input type="file" id="te-cover-file"
                       accept="image/jpeg,image/png,image/webp,image/gif" hidden>
                <div class="te-cover-actions">
                  <div class="te-cover-btn-row">
                    <button type="button" class="te-cover-btn" id="te-cover-pick">
                      📷 Foto kiezen
                    </button>
                    ${track.cover_url ? `
                    <button type="button" class="te-cover-btn te-cover-btn-remove" id="te-cover-remove">
                      × Verwijder
                    </button>` : ''}
                  </div>
                  <input type="text" id="te-cover-url" inputmode="url"
                         placeholder="/media/… of https://…"
                         autocomplete="off" autocapitalize="none" spellcheck="false"
                         value="${esc(track.cover_url || '')}">
                  <div class="te-cover-status" id="te-cover-status"></div>
                </div>
              </div>
            </div>

          </div>
        </div>

        <div class="te-footer">
          <button type="button" class="te-btn" id="te-cancel">Annuleren</button>
          <div class="te-footer-spacer"></div>
          <button type="button" class="te-btn te-btn-primary" id="te-save">💾 Opslaan</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.classList.add('te-modal-open');

    const $ = sel => backdrop.querySelector(sel);

    // ── Inline preview player (routed through global mini-player) ──
    // We don't build our own <audio>; instead we tell the global
    // window.pcmsAudioPlayer to load this single track. Visual state
    // syncs against the global audio element so toggle works correctly
    // even if the user pauses from the mini-bar.
    const previewBtn = $('#te-preview-play');
    if (previewBtn) {
      const setPreviewState = (playing) => {
        previewBtn.textContent = playing ? '⏸' : '▶';
        previewBtn.classList.toggle('is-playing', playing);
        previewBtn.setAttribute('aria-label', playing ? 'Pauzeren' : 'Afspelen');
      };
      const isOurTrack = () => {
        // audio.src is a blob: URL (Spotify-style playback) — compare against
        // the player's logical current-track URL instead.
        const player = window.pcmsAudioPlayer;
        const cur = player && player.currentTrack();
        return !!(cur && track.stream_url && cur.url === track.stream_url);
      };
      const resync = () => {
        const audio = document.getElementById('audio-element');
        const playing = audio && !audio.paused && !audio.ended && isOurTrack();
        setPreviewState(!!playing);
      };

      previewBtn.addEventListener('click', () => {
        const player = window.pcmsAudioPlayer;
        if (!player || !track.stream_url) {
          console.warn('preview: miniplayer or url missing');
          return;
        }
        const audio = document.getElementById('audio-element');
        if (audio && isOurTrack()) {
          // Same track loaded — toggle
          if (audio.paused) player.play(); else player.pause();
        } else {
          player.setQueue([{
            url:    track.stream_url,
            title:  track.title  || '(zonder titel)',
            artist: track.artist || '',
            album:  track.album  || '',
            cover:  track.cover_url || '',
          }], 0);
        }
      });

      const audio = document.getElementById('audio-element');
      if (audio) {
        const evs = ['play', 'pause', 'ended', 'loadstart', 'emptied'];
        evs.forEach(ev => audio.addEventListener(ev, resync));
        // Detach listeners on close so we don't leak them
        backdrop._previewCleanup = () => {
          evs.forEach(ev => audio.removeEventListener(ev, resync));
        };
        resync();   // initial state
      }
    }

    function close() {
      // Detach our resync listeners (mini-player stays running)
      if (backdrop._previewCleanup) backdrop._previewCleanup();
      document.body.classList.remove('te-modal-open');
      document.removeEventListener('keydown', onEsc);
      backdrop.remove();
    }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onEsc);

    // A click on the backdrop does NOT close the editor — too easy to lose edits by
    // mis-clicking outside. Close deliberately via ×, Cancel or Esc.
    $('.te-close').addEventListener('click', close);
    $('#te-cancel').addEventListener('click', close);

    // ── Cover picking + URL paste + drag-drop ────────────────
    const thumb     = $('#te-cover-thumb');
    const fileInput = $('#te-cover-file');
    const urlInput  = $('#te-cover-url');
    const status    = $('#te-cover-status');
    const pickBtn   = $('#te-cover-pick');
    const removeBtn = $('#te-cover-remove');

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = 'te-cover-status' + (kind ? ' is-' + kind : '');
    }
    function setThumb(url) {
      if (url) {
        thumb.innerHTML = `<img src="${esc(url)}" alt="">`;
      } else {
        thumb.innerHTML = `<span class="te-cover-empty">🎨</span>`;
      }
    }

    pickBtn.addEventListener('click', () => fileInput.click());
    thumb.addEventListener('click', () => fileInput.click());
    thumb.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    async function uploadCoverFile(file) {
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        setStatus('Alleen afbeeldingen toegestaan', 'error'); return;
      }
      setStatus('Uploaden…', null);
      const fd = new FormData();
      fd.append('cover', file);
      try {
        const r = await fetch('/admin/audio/api/' + encodeURIComponent(id) + '/cover', {
          method: 'POST', body: fd, credentials: 'same-origin',
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Upload mislukt');
        urlInput.value = j.cover_url || '';
        setThumb(j.cover_url);
        setStatus('✓ Geüpload', 'ok');
      } catch (err) {
        setStatus('Mislukt: ' + err.message, 'error');
      }
    }

    fileInput.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadCoverFile(f);
      fileInput.value = '';
    });

    // Drag-drop on thumb (desktop nicety)
    ['dragenter', 'dragover'].forEach(ev =>
      thumb.addEventListener(ev, e => { e.preventDefault(); thumb.classList.add('is-dragover'); }));
    ['dragleave', 'drop'].forEach(ev =>
      thumb.addEventListener(ev, e => { e.preventDefault(); thumb.classList.remove('is-dragover'); }));
    thumb.addEventListener('drop', e => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadCoverFile(f);
    });

    // URL paste auto-preview
    urlInput.addEventListener('input', () => {
      const v = urlInput.value.trim();
      setThumb(v);
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        urlInput.value = '';
        setThumb('');
        removeBtn.remove();
      });
    }

    // ── Replace the audio file of this track ──────────────────
    const aPick = $('#te-audio-pick');
    const aFile = $('#te-audio-file');
    const aStatus = $('#te-audio-status');
    if (aPick && aFile) {
      aPick.addEventListener('click', () => aFile.click());
      aFile.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        aFile.value = '';
        if (!f) return;
        aStatus.textContent = '⏳ Converteren… (kan even duren)'; aStatus.className = 'te-cover-status';
        aPick.disabled = true;
        try {
          const fd = new FormData();
          fd.append('audio', f);
          const j = await api('POST', '/admin/audio/api/' + encodeURIComponent(id) + '/replace-audio', fd);
          if (!j.ok) throw new Error(j.error || 'mislukt');
          aStatus.textContent = '✓ Vervangen'; aStatus.className = 'te-cover-status is-ok';
          track.stream_url = j.stream_url || track.stream_url;
          if (j.duration) { const d = $('#te-duration'); if (d) d.value = j.duration; }
        } catch (err) {
          aStatus.textContent = 'Mislukt: ' + err.message; aStatus.className = 'te-cover-status is-error';
        } finally { aPick.disabled = false; }
      });
    }

    // ── Insert © symbol into the credit field ─────────────────
    const copyrBtn = $('#te-credit-copyr');
    if (copyrBtn) {
      copyrBtn.addEventListener('click', () => {
        const inp = $('#te-credit');
        if (!inp) return;
        const sym = '© ';
        const start = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
        const end = inp.selectionEnd != null ? inp.selectionEnd : inp.value.length;
        inp.value = inp.value.slice(0, start) + sym + inp.value.slice(end);
        inp.focus();
        const pos = start + sym.length;
        try { inp.setSelectionRange(pos, pos); } catch (e) {}
      });
    }

    // ── Save ────────────────────────────────────────────────
    $('#te-save').addEventListener('click', async () => {
      const titleEl = $('#te-title');
      const title = titleEl.value.trim();
      if (!title) {
        titleEl.focus();
        alert('Titel is verplicht');
        return;
      }
      const saveBtn = $('#te-save');
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Opslaan…';

      try {
        const j = await api('POST', '/admin/audio/api/' + encodeURIComponent(id), {
          title,
          artist: $('#te-artist').value.trim() || null,
          album:  $('#te-album').value.trim() || null,
          credit:  $('#te-credit').value.trim() || null,
          license: $('#te-license').value.trim() || null,
          link_spotify:    $('#te-link-spotify').value.trim() || null,
          link_youtube:    $('#te-link-youtube').value.trim() || null,
          link_soundcloud: $('#te-link-soundcloud').value.trim() || null,
          duration: $('#te-duration').value ? Number($('#te-duration').value) : null,
          cover_url: urlInput.value.trim() || null,
        });
        if (!j.ok) throw new Error(j.error || 'Opslaan mislukt');
        if (typeof onSaved === 'function') onSaved(j.track || { id, title,
          artist: $('#te-artist').value.trim() || null,
          album:  $('#te-album').value.trim() || null,
          cover_url: urlInput.value.trim() || null });
        close();
      } catch (err) {
        alert('Opslaan mislukt: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Opslaan';
      }
    });

    // ── Auto-duration ───────────────────────────────────────────
    // The server already determines duration automatically on upload. This is the
    // fallback/UX layer: if an admin opens an existing track without a duration,
    // we read it from the audio metadata and fill the field — so you never need
    // to type seconds manually. An existing value is never overwritten. We fetch
    // the bytes via the same header gate as the player (X-Audio-Player).
    (async function autoDuration() {
      const durEl = $('#te-duration');
      if (!durEl || !track.stream_url) return;
      if (durEl.value && Number(durEl.value) > 0) return;  // already filled → leave it alone
      let objUrl = null;
      try {
        const r = await fetch(track.stream_url, { credentials: 'same-origin', headers: { 'X-Audio-Player': '1' } });
        if (!r.ok) return;
        objUrl = URL.createObjectURL(await r.blob());
        const probe = new Audio();
        probe.preload = 'metadata';
        probe.addEventListener('loadedmetadata', () => {
          if (isFinite(probe.duration) && probe.duration > 0 && !(durEl.value && Number(durEl.value) > 0)) {
            durEl.value = Math.round(probe.duration);
          }
          if (objUrl) URL.revokeObjectURL(objUrl);
        });
        probe.addEventListener('error', () => { if (objUrl) URL.revokeObjectURL(objUrl); });
        probe.src = objUrl;
      } catch (e) { if (objUrl) URL.revokeObjectURL(objUrl); }
    })();

    // Focus title for fast typing
    setTimeout(() => $('#te-title').focus(), 60);
  };
})();
