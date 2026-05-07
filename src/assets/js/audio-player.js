/**
 * PrutCMS v10 Audio Player — v9 mini-player + Spotify-style sheet.
 *
 * Two surfaces:
 *  1. .audio-player          — bottom strip: cover + meta + controls + progress + volume
 *  2. .audio-sheet           — full-height now-playing panel (slides up from bottom)
 *
 * Features:
 *  - Click cover/meta on mini-player → open sheet
 *  - Sheet handle (pill) or backdrop click → close
 *  - Touch swipe-down on the drag-zone → close (mobile only; desktop has the X)
 *  - Reads data-pcms-track-url + data-pcms-track + data-pcms-album from posts
 *  - body.has-audio-player adds bottom padding when player visible
 *  - body.audio-sheet-locked prevents body scroll when sheet open
 *  - Survives HTMX swaps via htmx:afterSettle re-attach
 *
 * Singleton — guards against double-init.
 */
(function() {
  if (window.pcmsAudioPlayer) return;

  const SVG = {
    play:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4l12 8-12 8z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/></svg>',
    prev:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14M20 5l-11 7 11 7V5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 5v14M4 5l11 7-11 7V5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    vol:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zM16 8a5 5 0 010 8M19 5a9 9 0 010 14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mute:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zM17 9l5 5M22 9l-5 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    musicNote: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17V5l12-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="17" r="3" fill="currentColor"/><circle cx="18" cy="15" r="3" fill="currentColor"/></svg>',
  };

  // ============================================================
  // 1. Build DOM
  // ============================================================
  const root = document.createElement('aside');
  root.id = 'pcms-audio-player';
  root.className = 'audio-player';
  root.setAttribute('aria-label', 'Audio speler');
  root.innerHTML = `
    <div class="audio-player-inner">
      <button type="button" class="audio-player-expand-trigger" id="audio-expand-trigger" aria-label="Vergroot speler">
        <div class="audio-player-cover" id="audio-cover" aria-hidden="true">${SVG.musicNote}</div>
        <div class="audio-player-meta">
          <div class="audio-player-title-wrap"><span class="audio-player-title" id="audio-title">No track</span></div>
          <div class="audio-player-artist" id="audio-artist"></div>
        </div>
      </button>
      <div class="audio-player-controls">
        <button type="button" class="audio-btn" id="audio-prev" aria-label="Vorige" title="Vorige">${SVG.prev}</button>
        <button type="button" class="audio-btn audio-btn-play" id="audio-play" aria-label="Afspelen">
          <span class="icon-play">${SVG.play}</span><span class="icon-pause">${SVG.pause}</span>
        </button>
        <button type="button" class="audio-btn" id="audio-next" aria-label="Volgende" title="Volgende">${SVG.next}</button>
      </div>
      <div class="audio-player-progress">
        <span class="audio-time mono" id="audio-current">0:00</span>
        <div class="audio-seek" id="audio-seek" role="slider" aria-label="Voortgang" tabindex="0">
          <div class="audio-seek-bar"><div class="audio-seek-fill" id="audio-seek-fill"></div></div>
        </div>
        <span class="audio-time mono" id="audio-total">0:00</span>
      </div>
      <div class="audio-player-volume">
        <button type="button" class="audio-btn" id="audio-mute" aria-label="Mute">
          <span class="icon-vol">${SVG.vol}</span><span class="icon-mute">${SVG.mute}</span>
        </button>
        <div class="audio-volume-popup">
          <input type="range" id="audio-volume" min="0" max="100" value="80" aria-label="Volume">
        </div>
      </div>
    </div>
    <audio id="audio-element" preload="none" playsinline webkit-playsinline controlsList="nodownload"></audio>

    <div class="audio-sheet" id="audio-sheet" aria-hidden="true">
      <div class="audio-sheet-backdrop" id="audio-sheet-backdrop"></div>
      <div class="audio-sheet-panel" role="dialog" aria-label="Now playing">
        <div class="audio-sheet-drag-zone" id="audio-sheet-drag-zone">
          <button type="button" class="audio-sheet-handle" id="audio-sheet-close" aria-label="Speler verkleinen"></button>
          <div class="audio-sheet-cover" id="audio-sheet-cover" aria-hidden="true">${SVG.musicNote}</div>
        </div>
        <div class="audio-sheet-info">
          <div class="audio-sheet-title" id="audio-sheet-title">—</div>
          <div class="audio-sheet-artist" id="audio-sheet-artist"></div>
          <div class="audio-sheet-album" id="audio-sheet-album"></div>
        </div>
        <div class="audio-sheet-progress">
          <span class="audio-time mono" id="audio-sheet-current">0:00</span>
          <div class="audio-seek" id="audio-sheet-seek" role="slider" aria-label="Voortgang" tabindex="0">
            <div class="audio-seek-bar"><div class="audio-seek-fill" id="audio-sheet-seek-fill"></div></div>
          </div>
          <span class="audio-time mono" id="audio-sheet-total">0:00</span>
        </div>
        <div class="audio-sheet-controls">
          <button type="button" class="audio-btn audio-sheet-btn" id="audio-sheet-prev" aria-label="Vorige">${SVG.prev}</button>
          <button type="button" class="audio-btn audio-sheet-play" id="audio-sheet-play" aria-label="Afspelen">
            <span class="icon-play">${SVG.play}</span><span class="icon-pause">${SVG.pause}</span>
          </button>
          <button type="button" class="audio-btn audio-sheet-btn" id="audio-sheet-next" aria-label="Volgende">${SVG.next}</button>
        </div>
        <div class="audio-sheet-queue" id="audio-sheet-queue" hidden>
          <div class="audio-sheet-queue-label">Queue</div>
          <ol class="audio-sheet-queue-list" id="audio-sheet-queue-list"></ol>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // FIX: Move .audio-sheet out of the .audio-player root so its
  // position:fixed is anchored to the viewport, not to the mini-bar.
  // The mini-bar has backdrop-filter, which makes it a containing
  // block for fixed descendants — that broke the sheet's left/right/top/bottom.
  const _detachedSheet = root.querySelector('.audio-sheet');
  if (_detachedSheet) document.body.appendChild(_detachedSheet);

  // ============================================================
  // 2. Element references
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const audio = $('audio-element');
  const cover = $('audio-cover');
  const titleEl = $('audio-title');
  const artistEl = $('audio-artist');
  const seek = $('audio-seek');
  const seekFill = $('audio-seek-fill');
  const currentEl = $('audio-current');
  const totalEl = $('audio-total');
  const playBtn = $('audio-play');
  const prevBtn = $('audio-prev');
  const nextBtn = $('audio-next');
  const muteBtn = $('audio-mute');
  const volumeSlider = $('audio-volume');
  const expandTrigger = $('audio-expand-trigger');

  const sheet = $('audio-sheet');
  const sheetBackdrop = $('audio-sheet-backdrop');
  const sheetPanel = sheet.querySelector('.audio-sheet-panel');
  const sheetClose = $('audio-sheet-close');
  const sheetCover = $('audio-sheet-cover');
  const sheetTitle = $('audio-sheet-title');
  const sheetArtist = $('audio-sheet-artist');
  const sheetAlbum = $('audio-sheet-album');
  const sheetSeek = $('audio-sheet-seek');
  const sheetSeekFill = $('audio-sheet-seek-fill');
  const sheetCurrent = $('audio-sheet-current');
  const sheetTotal = $('audio-sheet-total');
  const sheetPlay = $('audio-sheet-play');
  const sheetPrev = $('audio-sheet-prev');
  const sheetNext = $('audio-sheet-next');
  const sheetQueue = $('audio-sheet-queue');
  const sheetQueueList = $('audio-sheet-queue-list');
  const dragZone = $('audio-sheet-drag-zone');

  // ============================================================
  // 3. State
  // ============================================================
  let queue = [];
  let currentIndex = 0;
  let isPlaying = false;
  let albumName = '';

  // Hide initially
  root.classList.add('audio-player-hidden');

  // ============================================================
  // 4. Track / queue loading
  // ============================================================
  function setCoverImage(el, url) {
    if (url) {
      el.style.backgroundImage = `url("${url}")`;
      el.classList.add('has-image');
      el.innerHTML = '';
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('has-image');
      el.innerHTML = SVG.musicNote;
    }
  }

  function loadTrack(index) {
    if (!queue[index]) {
      console.warn('[pcms-audio] loadTrack: no track at index', index);
      return;
    }
    currentIndex = index;
    const t = queue[index];
    if (!t.url) {
      console.error('[pcms-audio] track has no url', t);
      return;
    }
    console.log('[pcms-audio] loading', t.title, t.url);
    // Schone overgang: pause + reset voorkomt state-corruption van het
    // audio-element na meerdere src-changes (bug die continuous playback
    // brak na 3-4 tracks). audio.load() forceert reset van internal state.
    try { audio.pause(); } catch (e) {}
    audio.src = t.url;
    try { audio.load(); } catch (e) {}
    titleEl.textContent  = t.title  || 'Untitled';
    artistEl.textContent = t.artist || '';
    sheetTitle.textContent  = t.title  || 'Untitled';
    sheetArtist.textContent = t.artist || '';
    sheetAlbum.textContent  = albumName || '';
    setCoverImage(cover,      t.cover);
    setCoverImage(sheetCover, t.cover);
    root.classList.remove('audio-player-hidden');
    document.body.classList.add('has-audio-player');
    renderQueue();
  }

  function setQueue(tracks, startIdx, opts) {
    queue = Array.isArray(tracks) ? tracks.slice() : [];
    albumName = (opts && opts.albumName) || '';
    if (!queue.length) return;
    loadTrack(typeof startIdx === 'number' ? Math.max(0, Math.min(startIdx, queue.length - 1)) : 0);
    play();
  }

  function play() {
    if (!audio.src) return;
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn('[pcms-audio] play() rejected:', err.name, err.message);
        // Browser-autoplay-policy heeft 't gestopt (typisch na 3-4
        // automatische plays op iOS Safari, of als tab tijdelijk inactive
        // was). Visuele hint dat user op play moet tappen.
        if (err && err.name === 'NotAllowedError') {
          root.classList.add('audio-needs-tap');
          isPlaying = false;
          root.classList.remove('is-playing');
        }
      });
    }
  }
  function pause()      { audio.pause(); }
  function togglePlay() { audio.paused ? play() : pause(); }
  function next() {
    if (!queue.length) return;
    loadTrack((currentIndex + 1) % queue.length);
    play();
  }
  function prev() {
    if (!queue.length) return;
    loadTrack(currentIndex === 0 ? queue.length - 1 : currentIndex - 1);
    play();
  }
  function close() {
    pause();
    root.classList.add('audio-player-hidden');
    document.body.classList.remove('has-audio-player');
    closeSheet();
    queue = [];
    albumName = '';
  }

  function renderQueue() {
    if (!queue.length) { sheetQueue.hidden = true; return; }
    sheetQueueList.innerHTML = '';
    queue.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'audio-sheet-queue-item' + (i === currentIndex ? ' is-current' : '');
      li.dataset.idx = String(i);
      li.innerHTML = `<span class="aqi-num">${i + 1}.</span> <span class="aqi-title">${escapeHtml(t.title || 'Untitled')}</span>`
                  + (t.artist ? `<span class="aqi-artist">${escapeHtml(t.artist)}</span>` : '');
      sheetQueueList.appendChild(li);
    });
    sheetQueueList.querySelectorAll('.audio-sheet-queue-item').forEach((li) => {
      li.addEventListener('click', () => {
        const idx = parseInt(li.dataset.idx, 10);
        if (!isNaN(idx) && idx !== currentIndex) {
          loadTrack(idx);
          play();
        }
      });
    });
    sheetQueue.hidden = queue.length < 2;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ============================================================
  // 5. Audio element events → UI sync
  // ============================================================
  // Error-counter voorkomt infinite-loop als ALLE tracks broken zijn.
  let consecutiveErrors = 0;

  audio.addEventListener('play',  () => {
    isPlaying = true;
    consecutiveErrors = 0;  // reset bij succesvolle play
    root.classList.add('is-playing');
    root.classList.remove('audio-needs-tap');  // verstop tap-hint
  });
  audio.addEventListener('pause', () => { isPlaying = false; root.classList.remove('is-playing'); });
  audio.addEventListener('ended', next);
  audio.addEventListener('error', (e) => {
    const code = audio.error ? audio.error.code : '?';
    console.error('[pcms-audio] playback error', code, audio.src, e);
    consecutiveErrors++;
    // Bij netwerk/decode-fout: skip naar volgende track ipv stilstaan.
    // Max 3 fouten op rij voordat we opgeven (anders infinite loop).
    if (consecutiveErrors < 3 && queue.length > 1) {
      console.warn('[pcms-audio] auto-skip naar volgende na error', consecutiveErrors);
      setTimeout(next, 400);
    }
  });
  audio.addEventListener('stalled', () => console.warn('[pcms-audio] stalled at', audio.currentTime));
  audio.addEventListener('volumechange', () => { root.classList.toggle('is-muted', audio.muted || audio.volume === 0); });
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration || isNaN(audio.duration)) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    seekFill.style.width = pct + '%';
    sheetSeekFill.style.width = pct + '%';
    currentEl.textContent  = formatTime(audio.currentTime);
    totalEl.textContent    = formatTime(audio.duration);
    sheetCurrent.textContent = formatTime(audio.currentTime);
    sheetTotal.textContent   = formatTime(audio.duration);
  });

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function attachSeek(seekEl) {
    seekEl.addEventListener('click', (e) => {
      if (!audio.duration) return;
      const rect = seekEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
    });
  }
  attachSeek(seek);
  attachSeek(sheetSeek);

  audio.volume = 0.8;
  volumeSlider.addEventListener('input', () => {
    audio.volume = volumeSlider.value / 100;
    if (volumeSlider.value > 0) audio.muted = false;
  });
  muteBtn.addEventListener('click', () => { audio.muted = !audio.muted; });

  // ============================================================
  // 6. Control wiring
  // ============================================================
  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);
  sheetPlay.addEventListener('click', togglePlay);
  sheetPrev.addEventListener('click', prev);
  sheetNext.addEventListener('click', next);

  // ============================================================
  // 7. Sheet expand/close + drag-down-to-close
  // ============================================================
  function openSheet() {
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('audio-sheet-locked');
  }
  function closeSheet() {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('audio-sheet-locked');
    sheetPanel.style.removeProperty('--pcms-drag-y');
    sheetBackdrop.style.removeProperty('--pcms-sheet-progress');
  }
  expandTrigger.addEventListener('click', openSheet);
  sheetClose.addEventListener('click', closeSheet);
  sheetBackdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('is-open')) closeSheet();
  });

  // Drag-down-to-close on touch devices.
  //
  // We set --pcms-drag-y as a CSS custom prop instead of writing
  // sheetPanel.style.transform directly. The reason: on desktop the panel
  // uses `transform: translate(-50%, 0)` for horizontal centering. Writing
  // `style.transform = translateY(...)` would obliterate the -50% and the
  // panel would jump rightward. With a custom prop, audio.css composes the
  // final transform per breakpoint:
  //   mobile:   transform: translateY(var(--pcms-drag-y, 0))
  //   desktop:  transform: translate(-50%, var(--pcms-drag-y, 0))
  let dragStartY = 0, dragLastY = 0, isDragging = false;
  function onPointerDown(e) {
    if (e.pointerType !== 'touch') return;
    if (sheetPanel.scrollTop > 0) return;  // queue is scrolled, don't drag
    dragStartY = dragLastY = e.clientY;
    isDragging = true;
    sheetPanel.classList.add('is-dragging');
    sheetBackdrop.classList.add('is-dragging');
  }
  function onPointerMove(e) {
    if (!isDragging) return;
    dragLastY = e.clientY;
    const dy = Math.max(0, dragLastY - dragStartY);
    sheetPanel.style.setProperty('--pcms-drag-y', dy + 'px');
    const progress = Math.max(0, 1 - dy / sheetPanel.offsetHeight);
    sheetBackdrop.style.setProperty('--pcms-sheet-progress', String(progress));
  }
  function onPointerUp() {
    if (!isDragging) return;
    isDragging = false;
    sheetPanel.classList.remove('is-dragging');
    sheetBackdrop.classList.remove('is-dragging');
    const dy = dragLastY - dragStartY;
    if (dy > 100) {
      closeSheet();
    } else {
      sheetPanel.style.removeProperty('--pcms-drag-y');
      sheetBackdrop.style.removeProperty('--pcms-sheet-progress');
    }
  }
  if (window.PointerEvent) {
    dragZone.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup',   onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  }

  // ============================================================
  // 8. Hook up post-audio-track + post-album-cover-btn + .pat-row + .post-album-playall
  // ============================================================
  // Four entry points fire the same play action:
  //   - .pat-play              → single-track widget in a post
  //   - .pat-row               → track row inside an album/playlist tracklist
  //   - .post-album-cover-btn  → big cover button (plays album from track 0)
  //   - .post-album-playall    → "Speel album" / "Speel playlist" button
  //
  // For .pat-play the metadata lives on the surrounding .post-audio-track
  // wrapper. For the other three the data is on the button itself. The
  // handler reads from button-first, falls back to wrapper.
  function attachListeners() {
    const playBtns = document.querySelectorAll(
      '.post-audio-track .pat-play, ' +
      '.post-album-tracks .pat-row, ' +
      '.post-album-cover-btn, ' +
      '.post-album-playall'
    );
    if (playBtns.length) console.log('[pcms-audio] attaching to', playBtns.length, 'play buttons');

    playBtns.forEach((btn) => {
      if (btn.dataset.pcmsAttached) return;
      btn.dataset.pcmsAttached = '1';

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Resolve metadata: button-first, then closest .post-audio-track wrapper
        // (only inline single-track widgets put the data on the wrapper).
        const wrapper = btn.closest('.post-audio-track');
        const albumId   = btn.dataset.pcmsAlbumId  || (wrapper && wrapper.dataset.pcmsAlbumId);
        const trackData = btn.dataset.pcmsTrack    || (wrapper && wrapper.dataset.pcmsTrack);
        const trackUrl  = btn.dataset.pcmsTrackUrl || (wrapper && wrapper.dataset.pcmsTrackUrl);
        console.log('[pcms-audio] click', { btn: btn.className, albumId, trackUrl, hasTrackData: !!trackData });

        if (albumId) {
          const album = document.getElementById(albumId);
          if (!album) { console.error('[pcms-audio] album not found:', albumId); return; }
          try {
            const tracks = JSON.parse(album.dataset.pcmsAlbum);
            // Start at the clicked track if we know its URL, else start at 0
            // (cover-btn and playall both want to start from the beginning).
            const startIdx = trackUrl ? tracks.findIndex(t => t.url === trackUrl) : 0;
            setQueue(tracks, startIdx >= 0 ? startIdx : 0, { albumName: album.dataset.pcmsAlbumTitle || '' });
          } catch(err) { console.error('[pcms-audio] bad album JSON', err, album.dataset.pcmsAlbum); }
        } else if (trackData) {
          try {
            const t = JSON.parse(trackData);
            setQueue([t], 0);
          } catch(err) { console.error('[pcms-audio] bad track JSON', err, trackData); }
        } else if (trackUrl) {
          // Fallback: at minimum we have the signed URL
          setQueue([{ url: trackUrl, title: 'Track', artist: '', cover: '' }], 0);
        } else {
          console.error('[pcms-audio] no track data or url on button or wrapper', btn);
        }
      });
    });
  }

  attachListeners();
  document.body.addEventListener('htmx:afterSettle', attachListeners);

  // ============================================================
  // 8b. Admin playlist delete (event delegation)
  // ============================================================
  // The post-album embed renders a [data-pcms-playlist-delete] button
  // top-right when the viewer is admin (server decides; not client).
  // We delegate from document.body so HTMX-swapped content works too.
  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pcms-playlist-delete]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.pcmsPlaylistDelete;
    const title = btn.dataset.pcmsPlaylistTitle || id;
    if (!id) return;
    if (!confirm(`Playlist "${title}" verwijderen? De embed in deze post toont vanaf nu een placeholder.`)) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/admin/playlists/api/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': '' },
        credentials: 'same-origin',
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.ok) {
        location.reload();
      } else {
        alert('Verwijderen mislukt: ' + ((j && j.error) || 'onbekende fout'));
        btn.disabled = false;
      }
    } catch (err) {
      alert('Verwijderen mislukt: ' + err.message);
      btn.disabled = false;
    }
  });

  // ============================================================
  // 9. Public API
  // ============================================================
  window.pcmsAudioPlayer = {
    setQueue, play, pause, next, prev, close, openSheet, closeSheet,
    isPlaying: () => isPlaying,
    currentTrack: () => queue[currentIndex] || null,
  };

  // ============================================================
  // 10. Site-level pre-seed (window.PCMS_SITE_TRACKS)
  // ============================================================
  if (Array.isArray(window.PCMS_SITE_TRACKS) && window.PCMS_SITE_TRACKS.length) {
    queue = window.PCMS_SITE_TRACKS.map(t => ({
      url:    t.media_url || t.url,
      title:  t.title  || 'Untitled',
      artist: t.artist || '',
      cover:  t.cover_url || t.cover || '',
    }));
    if (queue.length) loadTrack(0);
  }
})();
