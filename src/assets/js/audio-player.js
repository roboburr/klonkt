/**
 * Klonkt Audio Player — v9 mini-player + Spotify-style sheet.
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
 *  - Survives HTMX swaps + history-restores via event delegation on document.body
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
  // Blob playback state. We fetch each track's bytes and play from a blob:
  // object URL — no plain media URL is ever exposed to the page. currentObjectUrl
  // is revoked when we move on, so we don't leak one Blob per track in memory.
  let currentObjectUrl = null;
  // Monotonic load token: a fast prev/next can fire several loads before an
  // earlier fetch resolves. Only the latest load may set audio.src.
  let loadSeq = 0;
  // Next-track prefetch. While the current track plays we download the *next*
  // track's bytes into a held blob, so `ended` → next() can swap src instantly
  // (no silent gap, and no long async window where the browser's autoplay
  // activation can lapse and reject play()). At most one track ahead is held.
  // Shape: { url, objUrl }  — objUrl is null while the fetch is still in flight.
  let preload = null;

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

  // Fetch the track bytes and hand back a blob: object URL. The X-Audio-Player
  // header + same-origin credentials get us past the stream route's access gate.
  // Retries a few times with backoff: a single transient network blip used to
  // bump the error counter and SKIP the song (auto-advance past it). Now one
  // hiccup just costs a retry, and we only give up after genuinely failing.
  async function fetchAsObjectUrl(url, attempts) {
    attempts = attempts || 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, {
          credentials: 'same-origin',
          headers: { 'X-Audio-Player': '1' },
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        return URL.createObjectURL(blob);
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) {
          await new Promise((res) => setTimeout(res, 350 * (i + 1)));
        }
      }
    }
    throw lastErr;
  }

  // Apply a ready blob URL to the <audio> element. Single source of truth for
  // "swap the playing source": used by both the cached-preload path and the
  // fresh-fetch path so there's one place that touches audio.src.
  function applyBlob(objUrl, autoplay, mySeq) {
    if (mySeq !== loadSeq) { try { URL.revokeObjectURL(objUrl); } catch (e) {} return; }  // superseded
    root.classList.remove('audio-loading');
    // Free the previously-playing track's blob — otherwise each track leaks a
    // copy. Never the same handle as objUrl (createObjectURL is unique), so this
    // can't revoke the source we're about to play.
    if (currentObjectUrl && currentObjectUrl !== objUrl) {
      try { URL.revokeObjectURL(currentObjectUrl); } catch (e) {}
    }
    currentObjectUrl = objUrl;
    // Clean transition: pause + load forces a reset of internal state after
    // multiple src changes (prevents state corruption of the audio element).
    try { audio.pause(); } catch (e) {}
    audio.src = objUrl;
    try { audio.load(); } catch (e) {}
    if (autoplay) play();
  }

  function onLoadError(err, mySeq) {
    if (mySeq !== loadSeq) return;  // superseded — ignore stale failure
    root.classList.remove('audio-loading');
    console.error('[pcms-audio] track load failed after retries', err);
    // Genuine failure (after retries): bump the counter and auto-skip, but stop
    // after 3 in a row so a fully-broken queue can't loop "next" forever.
    consecutiveErrors++;
    if (consecutiveErrors < 3 && queue.length > 1) setTimeout(next, 400);
  }

  // Discard any held/in-flight preload and free its blob if resolved.
  function dropPreload() {
    if (preload && preload.objUrl) { try { URL.revokeObjectURL(preload.objUrl); } catch (e) {} }
    preload = null;
  }

  // Prefetch the *next* track's bytes in the background. Idempotent: re-calling
  // while the same track is already cached / in flight is a no-op. Called from
  // the `playing` event so the network is otherwise idle.
  function preloadNext() {
    if (queue.length < 2) return;
    const ni = (currentIndex + 1) % queue.length;
    const t = queue[ni];
    if (!t || !t.url) return;
    if (preload && preload.url === t.url) return;  // already held or in flight
    dropPreload();                                  // different track queued before → free it
    const marker = { url: t.url, objUrl: null };
    preload = marker;
    fetchAsObjectUrl(t.url, 2).then((obj) => {
      // Only keep it if this is still the track we want next; otherwise free it.
      if (preload === marker) { marker.objUrl = obj; }
      else { try { URL.revokeObjectURL(obj); } catch (e) {} }
    }).catch(() => { if (preload === marker) preload = null; });
  }

  // metaOnly: show the track in the UI but DON'T download its bytes yet.
  // Used by the site pre-seed so opening a page doesn't auto-download audio;
  // the blob is fetched lazily on the first play().
  // Persistently mark the current track (stays highlighted as long as it's active).
  function markPlaying(trackId) {
    document.querySelectorAll('.pat-playing').forEach((e) => e.classList.remove('pat-playing'));
    if (!trackId) return;
    const el = document.getElementById('track-' + trackId);
    if (el) el.classList.add('pat-playing');
  }
  // After an htmx navigation the post DOM is replaced → reapply the highlight.
  document.body.addEventListener('htmx:afterSettle', () => {
    const t = queue[currentIndex];
    if (t) markPlaying(t.id);
  });

  // Media Session metadata (lock-screen / notification info + artwork). Set per
  // track; the action handlers are wired once below. Keeping a live media session
  // is what lets iOS continue a programmatic auto-advance play() instead of
  // pausing it immediately.
  function updateMediaMetadata(t) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      const art = [];
      if (t && t.cover) {
        let u = t.cover; try { u = new URL(t.cover, location.href).href; } catch (e) {}
        art.push({ src: u, sizes: '512x512', type: '' });
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (t && t.title) || 'Untitled',
        artist: (t && t.artist) || '',
        album: albumName || '',
        artwork: art,
      });
    } catch (e) { /* non-fatal */ }
  }

  function loadTrack(index, autoplay, metaOnly) {
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
    console.log('[pcms-audio] loading', t.title, t.url, metaOnly ? '(meta only)' : '');
    // Metadata + chrome update synchronously so the UI reacts instantly while
    // the bytes download.
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
    markPlaying(t.id);
    updateMediaMetadata(t);

    if (metaOnly) return;

    const mySeq = ++loadSeq;

    // Fast path: the bytes for this exact track were already prefetched while
    // the previous track played → swap in instantly, no gap, no fetch window.
    if (preload && preload.url === t.url && preload.objUrl) {
      const obj = preload.objUrl;
      preload = null;  // ownership moves to applyBlob (becomes currentObjectUrl)
      applyBlob(obj, autoplay, mySeq);
      return;
    }

    // Not preloaded (or preload still in flight) → drop any stale preload and
    // fetch fresh, retrying transient failures before giving up.
    dropPreload();
    root.classList.add('audio-loading');
    fetchAsObjectUrl(t.url, 3)
      .then((objUrl) => applyBlob(objUrl, autoplay, mySeq))
      .catch((err) => onLoadError(err, mySeq));
  }

  // True when the viewport is in the mobile sheet-layout — matches the CSS
  // breakpoint where .audio-sheet slides up full-width from the bottom
  // (@media max-width:719.98px). On wider/desktop widths the sheet is a centered
  // panel, so we do NOT auto-open it there.
  // Three layouts (Robin 2026-06-15): phone (<768) = fullscreen sheet;
  // tablet/car (768–1199) = large landscape full-player (tablet + car-mode);
  // desktop (≥1200) = mini-player only, NO full player. matchMedia so this
  // exactly follows the CSS breakpoints.
  function playerTier() {
    if (window.matchMedia('(min-width: 1200px)').matches) return 'desktop';
    if (window.matchMedia('(min-width: 768px)').matches) return 'tablet';
    return 'phone';
  }
  function hasFullPlayer() { return playerTier() !== 'desktop'; }
  function isMobileView() { return playerTier() === 'phone'; }

  function setQueue(tracks, startIdx, opts) {
    queue = Array.isArray(tracks) ? tracks.slice() : [];
    albumName = (opts && opts.albumName) || '';
    if (!queue.length) return;
    loadTrack(typeof startIdx === 'number' ? Math.max(0, Math.min(startIdx, queue.length - 1)) : 0, true);
    // Mobile: a track press from an album/playlist auto-opens the full
    // now-playing sheet (Spotify-style) instead of just the thin mini-strip.
    // Only here (setQueue = a fresh, user-initiated queue) —
    // not on next/prev or the site pre-seed — so a sheet the user
    // deliberately closed doesn't reappear by itself.
    if (hasFullPlayer()) openSheet();
  }

  function play() {
    if (!audio.src) {
      // Nothing fetched yet (pre-seed showed metadata only, or a load is still
      // in flight). Kick off the blob load for the current track and autoplay.
      if (queue[currentIndex]) loadTrack(currentIndex, true);
      return;
    }
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn('[pcms-audio] play() rejected:', err.name, err.message);
        // Browser autoplay policy blocked it (typically after 3-4
        // auto-plays on iOS Safari, or when the tab was temporarily inactive).
        // Show a visual hint for the user to tap play.
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
    loadTrack((currentIndex + 1) % queue.length, true);
  }
  function prev() {
    if (!queue.length) return;
    loadTrack(currentIndex === 0 ? queue.length - 1 : currentIndex - 1, true);
  }
  function close() {
    pause();
    mediaRegistry().release(registrySelf);
    root.classList.add('audio-player-hidden');
    document.body.classList.remove('has-audio-player');
    closeSheet();
    queue = [];
    albumName = '';
    loadSeq++;  // cancel any in-flight load
    dropPreload();  // free any prefetched next-track blob
    if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl); } catch (e) {} }
    currentObjectUrl = null;
    try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
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
          loadTrack(idx, true);
        }
      });
    });
    sheetQueue.hidden = queue.length < 2;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ============================================================
  // 4b. Mutual exclusion — shared media registry (see embed-player.js).
  // ============================================================
  // All players (this site player + YouTube/SoundCloud/Spotify embeds)
  // register themselves in window.pcmsMediaRegistry. Starting one pauses
  // the previous. This is the precise replacement for the old focus/blur
  // heuristic for embeds with a real JS API. (The blur fallback below stays
  // for iframe-only embeds without an API: Bandcamp/Apple Music/Vimeo.)
  function mediaRegistry() {
    if (window.pcmsMediaRegistry) return window.pcmsMediaRegistry;
    const r = {
      _active: null,
      setActive(player) {
        if (this._active && this._active !== player && this._active.pause) {
          try { this._active.pause(); } catch (e) {}
        }
        this._active = player;
      },
      release(player) { if (this._active === player) this._active = null; },
    };
    window.pcmsMediaRegistry = r;
    return r;
  }
  const registrySelf = { pause() { try { audio.pause(); } catch (e) {} } };

  // ============================================================
  // 5. Audio element events → UI sync
  // ============================================================
  // Error counter prevents an infinite loop when ALL tracks are broken.
  let consecutiveErrors = 0;

  audio.addEventListener('play',  () => {
    isPlaying = true;
    root.classList.add('is-playing');
    root.classList.remove('audio-needs-tap');  // hide tap hint
    mediaRegistry().setActive(registrySelf);   // pause any currently playing embeds
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {} }
  });

  // Media Session action handlers (wired once): lock-screen / headset / car
  // controls, and — crucially — an active session so iOS keeps a programmatic
  // auto-advance playing instead of pausing it the instant it starts.
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const wire = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported action */ } };
    wire('play', () => play());
    wire('pause', () => pause());
    wire('previoustrack', () => prev());
    wire('nexttrack', () => next());
    wire('seekto', (e) => { if (e && e.seekTime != null && audio.duration) { try { audio.currentTime = e.seekTime; } catch (er) {} } });
  }
  // Reset the error counter only on a REAL playback start (`playing`), not the
  // eager `play` event. `play` fires before any network/decode error, so resetting
  // there would prevent the 3-strikes stop from ever triggering on a broken
  // track → infinite "next" loop. `playing` only fires when audio is actually playing.
  audio.addEventListener('playing', () => { consecutiveErrors = 0; preloadNext(); });
  audio.addEventListener('pause', () => { isPlaying = false; root.classList.remove('is-playing'); if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {} } });
  audio.addEventListener('ended', next);
  audio.addEventListener('error', (e) => {
    const code = audio.error ? audio.error.code : '?';
    console.error('[pcms-audio] playback error', code, audio.src, e);
    consecutiveErrors++;
    // On network/decode error: skip to next track instead of stalling.
    // Max 3 consecutive errors before giving up (otherwise infinite loop).
    if (consecutiveErrors < 3 && queue.length > 1) {
      console.warn('[pcms-audio] auto-skip to next after error', consecutiveErrors);
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
  // Back button closes the sheet on mobile: on open we push a history entry
  // so the phone back button (popstate) closes the sheet first instead of
  // leaving the page. We balance it on a UI-initiated close via history.back().
  let sheetHistoryPushed = false;

  function openSheet() {
    if (!hasFullPlayer()) return; // desktop (≥1200): no full player, mini-player only
    if (sheet.classList.contains('is-open')) return;
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('audio-sheet-locked');
    // Phone + tablet: push a history entry so the back button closes the sheet first.
    try { history.pushState({ pcmsSheet: true }, ''); sheetHistoryPushed = true; } catch (e) {}
  }
  function closeSheet(fromPopstate) {
    if (!sheet.classList.contains('is-open')) return;
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('audio-sheet-locked');
    sheetPanel.style.removeProperty('--pcms-drag-y');
    sheetBackdrop.style.removeProperty('--pcms-sheet-progress');
    // UI close (X / swipe / backdrop / Esc): pop our own history entry so the
    // next back button navigates normally. On a popstate close (back button itself)
    // the entry is already popped.
    const wasPushed = sheetHistoryPushed;
    sheetHistoryPushed = false;
    if (wasPushed && !fromPopstate) { try { history.back(); } catch (e) {} }
  }
  window.addEventListener('popstate', () => {
    if (sheet.classList.contains('is-open')) closeSheet(true);
  });
  // Clicking the mini-player track info:
  //  - DESKTOP (≥1200px): jump to the post the track came from (if known),
  //    via htmx so audio keeps playing. No post known → fall back to the sheet.
  //  - MOBILE/TABLET: always open the full now-playing sheet.
  function scrollToTrack(trackId) {
    if (!trackId) { window.scrollTo(0, 0); return; }
    const el = document.getElementById('track-' + trackId);
    if (!el) { window.scrollTo(0, 0); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('pat-flash');
    setTimeout(() => el.classList.remove('pat-flash'), 1600);
  }
  function goToPost(url, trackId) {
    const hash = trackId ? ('#track-' + trackId) : '';
    if (window.htmx && url.charAt(0) === '/') {
      try {
        const p = window.htmx.ajax('GET', url, { target: '#pcms-main', swap: 'innerHTML' });
        history.pushState({}, '', url + hash);
        // Scroll to the track after the swap (small delay so the global
        // afterSwap scroll-to-top runs first); fall back to top if not found.
        const go = () => setTimeout(() => scrollToTrack(trackId), 60);
        if (p && typeof p.then === 'function') p.then(go); else setTimeout(go, 150);
        return;
      } catch (e) { /* fall back to full navigation */ }
    }
    location.href = url + hash;
  }
  expandTrigger.addEventListener('click', () => {
    const t = queue[currentIndex];
    // Only on true desktop (≥1200, no full-player) do we jump to the post.
    // Tablet + phone have a full-player → open it (same as mobile behaviour).
    const jumpToPost = !hasFullPlayer();
    if (jumpToPost && t) {
      // 1) Track played from a post → we already know that URL.
      if (t.postUrl) { goToPost(t.postUrl, t.id); return; }
      // 2) Site-wide track (no postUrl) → look up the post via the track id.
      if (t.id) {
        fetch('/audio/track/' + encodeURIComponent(t.id) + '/post')
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d && d.url) goToPost(d.url, t.id); else openSheet(); })
          .catch(() => openSheet());
        return;
      }
    }
    openSheet();
  });
  sheetClose.addEventListener('click', () => closeSheet());
  sheetBackdrop.addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('is-open')) closeSheet();
  });
  // Resized to desktop width (≥1200) while the full player is open? Close it —
  // the full player doesn't exist on desktop.
  window.addEventListener('resize', () => {
    if (!hasFullPlayer() && sheet.classList.contains('is-open')) closeSheet();
  });

  // Fallback for mutual exclusion. For YouTube/SoundCloud/Spotify embeds the
  // registry already handles this precisely (real play events). But for
  // iframe-only embeds WITHOUT a JS API (Bandcamp/Apple/Vimeo) and for the
  // iframe FALLBACK (when an ad-blocker blocks the player API) there is no
  // play event: we catch those via focus. User clicks such an iframe →
  // window 'blur' → pause our player. (For API embeds this is at worst a
  // harmless double-pause.)
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const el = document.activeElement;
      // Only embed iframes (inside .folio-embed) pause the player — not a
      // random iframe (captcha/ad/map) that happens to receive focus.
      if (el && el.tagName === 'IFRAME' && el.closest('.folio-embed') && audio.src && !audio.paused) {
        pause();
      }
    }, 0);
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
  // Event delegation on document.body instead of per-button listeners. This
  // survives HTMX history-restores: the mobile back button (popstate) lets HTMX
  // restore #pcms-main from its snapshot; a per-element `data-pcms-attached` flag
  // would leave dead buttons (flag baked into the snapshot, listener gone). One
  // delegated listener works regardless of how many times the DOM is (re)swapped.
  const PLAY_SELECTOR =
    '.post-audio-track .pat-play, .post-album-tracks .pat-row, .post-album-cover-btn, .post-album-playall';
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest(PLAY_SELECTOR);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    // The post you're playing FROM = the current page (embeds live in post content).
    // Store it on the track(s) so the desktop mini-player can jump back to it —
    // survives the sessionStorage resume as well.
    const postUrl = location.pathname + location.search;
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
        tracks.forEach((t) => { t.postUrl = postUrl; });
        // Start at the clicked track if we know its URL, else start at 0
        // (cover-btn and playall both want to start from the beginning).
        const startIdx = trackUrl ? tracks.findIndex(t => t.url === trackUrl) : 0;
        setQueue(tracks, startIdx >= 0 ? startIdx : 0, { albumName: album.dataset.pcmsAlbumTitle || '' });
      } catch(err) { console.error('[pcms-audio] bad album JSON', err, album.dataset.pcmsAlbum); }
    } else if (trackData) {
      try {
        const t = JSON.parse(trackData);
        t.postUrl = postUrl;
        setQueue([t], 0);
      } catch(err) { console.error('[pcms-audio] bad track JSON', err, trackData); }
    } else if (trackUrl) {
      // Fallback: at minimum we have the signed URL
      setQueue([{ url: trackUrl, title: 'Track', artist: '', cover: '', postUrl }], 0);
    } else {
      console.error('[pcms-audio] no track data or url on button or wrapper', btn);
    }
  });

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
  // 10. Session persistence — player "survives" across page navigations
  // ============================================================
  // An <audio> element doesn't survive a full page load (and cross-context
  // navigation — e.g. to the headerless hub overview — is intentionally a
  // full-nav). We save the session to sessionStorage and restore + resume it
  // on the next page: the player comes back with the same track at the same
  // position. In Chrome (high media engagement) it resumes immediately;
  // if the browser blocks autoplay it waits at that position (one tap = play).
  const PLAYER_STATE_KEY = 'pcms-player-state';
  let pendingSeek = 0;
  function savePlayerState() {
    try {
      if (!queue.length) { sessionStorage.removeItem(PLAYER_STATE_KEY); return; }
      sessionStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
        queue, currentIndex, albumName,
        time: audio.currentTime || 0,
        playing: !!audio.src && !audio.paused,
      }));
    } catch (e) {}
  }
  window.addEventListener('pagehide', savePlayerState);
  window.addEventListener('beforeunload', savePlayerState);
  audio.addEventListener('play',  savePlayerState);
  audio.addEventListener('pause', savePlayerState);
  audio.addEventListener('ended', savePlayerState);
  setInterval(() => { if (audio.src && !audio.paused) savePlayerState(); }, 5000);
  // Apply the restored position once track metadata is available.
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek > 0 && isFinite(audio.duration) && audio.duration > 0) {
      try { audio.currentTime = Math.min(pendingSeek, audio.duration - 0.25); } catch (e) {}
      pendingSeek = 0;
    }
  });
  function restorePlayerState() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(PLAYER_STATE_KEY) || 'null'); } catch (e) { return false; }
    if (!s || !Array.isArray(s.queue) || !s.queue.length) return false;
    queue = s.queue;
    albumName = s.albumName || '';
    pendingSeek = s.time || 0;
    const idx = Math.max(0, Math.min(s.currentIndex || 0, queue.length - 1));
    // playing → fetch + (attempt to) resume; paused → meta-only.
    loadTrack(idx, !!s.playing, !s.playing);
    return true;
  }

  // ============================================================
  // 11. Site-level pre-seed (window.PCMS_SITE_TRACKS)
  // ============================================================
  // An active session (restore) wins over the page seed, so music that is
  // already playing continues instead of being replaced by the new page's tracks.
  if (!restorePlayerState()) {
    if (Array.isArray(window.PCMS_SITE_TRACKS) && window.PCMS_SITE_TRACKS.length) {
      queue = window.PCMS_SITE_TRACKS.map(t => ({
        id:     t.id || null,
        url:    t.media_url || t.url,
        title:  t.title  || 'Untitled',
        artist: t.artist || '',
        cover:  t.cover_url || t.cover || '',
      }));
      // Only prime the queue — the player bar appears only on the first audio click
      // (.post-audio-track or the mini-player play button calls setQueue/loadTrack,
      // which shows the bar). No more pre-seed bar on page load.
      currentIndex = 0;
    }
  }
})();
