// Audio in beheer -- verplaatst uit inline script, shaer-bqr.
//
// Servergegevens komen uit pageData(); interpolatie kan niet in een statisch
// bestand. Inline script wordt bovendien geweigerd zodra deze pagina via een
// link BINNEN de site binnenkomt (shaer-0i6).

import { pageData, makeSweeper } from './lib.js';

// Zie post-edit.js: init() per paginawissel, de veger haalt de window-
// listeners van de vorige lichting weg (shaer-5s1).
const doc = makeSweeper();
let T = {};

export function init() {
  doc.sweep();
  T = pageData();
  run();
}

function run() {

(function() {

  // ── Live filename display for custom file inputs ──────────────
  document.querySelectorAll('.ax-file-control input[type="file"]').forEach(input => {
    const nameEl = input.parentElement.querySelector('.ax-file-name');
    if (!nameEl) return;
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) {
        nameEl.textContent = input.files[0].name;
        nameEl.removeAttribute('data-empty');
      } else {
        nameEl.textContent = (T.no_file || '');
        nameEl.setAttribute('data-empty', '');
      }
    });
  });

  // ── Inline track preview (routed through the global mini-player) ──
  // Each .ax-track-play button is a thin wrapper around the global
  // window.pcmsAudioPlayer.setQueue([...]) call. Visual state (▶ / ⏸ /
  // .is-playing) is synced from the player's own audio element so it
  // stays accurate even when the user uses the mini-player's controls.
  (function setupTrackPreview() {
    const buttons = document.querySelectorAll('.ax-track-play');
    if (!buttons.length) return;

    function setIcon(btn, playing) {
      const icon = btn.querySelector('.ax-track-play-icon');
      if (icon) icon.textContent = playing ? '⏸' : '▶';
      btn.classList.toggle('is-playing', playing);
      btn.setAttribute('aria-label', playing ? (T.pause || '') : (T.play || ''));
    }

    // Resync ALL preview buttons against the current audio element state.
    // Called on every play/pause/ended event so admins always see the right
    // icon — including the case where they hit pause on the mini-player
    // bar instead of the row's button.
    function resyncAll() {
      const audio = document.getElementById('audio-element');
      const player = window.pcmsAudioPlayer;
      const playing = audio && !audio.paused && !audio.ended;
      // audio.src is now a blob: URL (Spotify-style playback), so compare
      // against the player's logical track URL, not the element src.
      const cur = player && player.currentTrack();
      const curUrl = cur ? cur.url : '';
      buttons.forEach(b => {
        const isThisOne = playing && curUrl === b.dataset.streamUrl;
        setIcon(b, isThisOne);
      });
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const player = window.pcmsAudioPlayer;
        if (!player) {
          console.warn('[admin-audio] miniplayer not available');
          return;
        }
        const url = btn.dataset.streamUrl;
        if (!url) return;

        // Build track metadata from the row's DOM so the mini-player shows
        // useful info (title/artist/album/cover) without an extra API call.
        const row = btn.closest('.ax-track');
        const titleEl  = row && row.querySelector('[data-cell="title"]');
        const artistEl = row && row.querySelector('[data-cell="artist"]');
        const albumEl  = row && row.querySelector('[data-cell="album"]');
        const coverImg = row && row.querySelector('img[data-cover-thumb]');
        const track = {
          url,
          title:  titleEl  ? titleEl.textContent.trim()  : 'Track',
          artist: artistEl ? artistEl.textContent.trim() : '',
          album:  albumEl  ? albumEl.textContent.trim()  : '',
          cover:  coverImg ? coverImg.src                : '',
        };

        // If this exact track is already current, toggle pause/play instead
        // of restarting from zero. Compare logical URLs (audio.src is a blob:).
        const cur = player.currentTrack();
        if (cur && cur.url === url) {
          if (player.isPlaying()) player.pause();
          else                    player.play();
          return;
        }

        player.setQueue([track], 0);
      });
    });

    // Hook the global audio element's events to keep the row buttons synced.
    // We attach lazily after the player has built its DOM. The script in
    // shell.ejs runs at page-load so #audio-element exists by the time
    // this IIFE fires (script tag is below the body content).
    const audio = document.getElementById('audio-element');
    if (audio) {
      ['play', 'pause', 'ended', 'loadstart', 'emptied'].forEach(ev => {
        audio.addEventListener(ev, resyncAll);
      });
      // Initial state on page load (e.g. user navigated back while a track
      // was already playing — buttons should reflect that).
      resyncAll();
    }
  })();


  // ── Bulk upload (drag-drop + sequential transcoding) ─────────
  // Files dropped or picked are queued (not uploaded immediately) so the
  // user can review the list, set shared metadata, then hit "Start upload".
  // The loop POSTs one file at a time to /admin/audio/upload with
  // Accept: application/json so the server returns structured per-file
  // results instead of redirecting.
  const dropzone   = document.getElementById('audio-dropzone');
  const fileInput  = document.getElementById('audio-files');
  const queueEl    = document.getElementById('upload-queue');
  const actionsEl  = document.getElementById('upload-actions');
  const startBtn   = document.getElementById('start-upload-btn');
  const clearBtn   = document.getElementById('clear-queue-btn');
  const artistInput= document.getElementById('batch-artist');
  const albumInput = document.getElementById('batch-album');
  const coverInput = document.getElementById('batch-cover');

  /** @type {Array<{file: File, el: HTMLElement, status: string}>} */
  const queue = [];

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setItemStatus(item, status, label) {
    const labels = {
      queued:      (T.st_queued || ''),
      uploading:   (T.st_uploading || ''),
      transcoding: (T.st_transcoding || ''),
      done:        '✓ ' + (T.st_done || ''),
      error:       '✗ ' + (T.st_error || ''),
    };
    item.status = status;
    const badge = item.el.querySelector('.ax-queue-status');
    badge.className = 'ax-queue-status ax-queue-status--' + status;
    badge.textContent = label || labels[status] || status;
    // Restyle the row
    item.el.classList.remove(
      'ax-queue-item--active', 'ax-queue-item--done', 'ax-queue-item--error'
    );
    if (status === 'uploading' || status === 'transcoding') item.el.classList.add('ax-queue-item--active');
    else if (status === 'done')  item.el.classList.add('ax-queue-item--done');
    else if (status === 'error') item.el.classList.add('ax-queue-item--error');
  }

  function addFiles(files) {
    let added = 0;
    for (const file of files) {
      if (!file.type.startsWith('audio/') &&
          !/\.(mp3|m4a|ogg|opus|flac|wav|webm|aac|oga|mp4)$/i.test(file.name)) {
        // Silently skip non-audio drops; keeps the UX uncluttered.
        continue;
      }
      const li = document.createElement('li');
      li.className = 'ax-queue-item';
      li.innerHTML =
        '<div class="ax-queue-name"></div>' +
        '<span class="ax-queue-status ax-queue-status--queued">' + (T.st_queued || '') + '</span>';
      // Use textContent to avoid HTML-injection if a filename contains markup.
      li.querySelector('.ax-queue-name').textContent = file.name;
      // Append size hint inline
      const size = document.createElement('span');
      size.className = 'ax-queue-size';
      size.textContent = fmtBytes(file.size);
      li.querySelector('.ax-queue-name').appendChild(size);
      queueEl.appendChild(li);
      queue.push({ file, el: li, status: 'queued' });
      added++;
    }
    if (added) {
      queueEl.hidden = false;
      actionsEl.hidden = false;
    }
  }

  // ── Drop-zone events ─────────────────────────────────────────
  // Page-level guard: a dropped file outside the zone would otherwise
  // make the browser navigate to it (e.g. opening the audio inline), which
  // discards typed metadata. We swallow drops anywhere unless the dropzone
  // explicitly handles them.
  ['dragover', 'drop'].forEach(ev => {
    doc.on(window, ev, e => {
      // Allow drops INSIDE the dropzone — its own listener handles those.
      if (dropzone.contains(e.target)) return;
      e.preventDefault();
    });
  });

  ['dragenter', 'dragover'].forEach(ev => {
    dropzone.addEventListener(ev, e => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dropzone.addEventListener(ev, e => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });
  dropzone.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    // Reset so the same file can be picked again later if user wants
    fileInput.value = '';
  });

  // ── Clear queue button ───────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    // Only remove items that aren't currently uploading (anything queued
    // or already finished). An in-progress upload finishes, then its row
    // would also disappear once we re-render — but we keep it simple and
    // just refuse to clear during an active run.
    if (startBtn.disabled) return;
    queue.length = 0;
    queueEl.innerHTML = '';
    queueEl.hidden = true;
    actionsEl.hidden = true;
  });

  // ── Sequential upload loop ───────────────────────────────────
  startBtn.addEventListener('click', async () => {
    if (startBtn.disabled) return;
    startBtn.disabled = true;
    clearBtn.disabled = true;
    dropzone.style.pointerEvents = 'none';
    dropzone.style.opacity = '0.5';

    const sharedArtist = artistInput.value.trim();
    const sharedAlbum  = albumInput.value.trim();
    const sharedCover  = coverInput.files && coverInput.files[0];

    // Process queued items one at a time. We iterate via index so that
    // if more files get dropped during the run they ALSO get processed
    // (queue.push above mutates the same array we're iterating).
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status !== 'queued') continue;
      try {
        await uploadOne(item, sharedArtist, sharedAlbum, sharedCover);
      } catch (err) {
        console.error('upload failed for', item.file.name, err);
        setItemStatus(item, 'error', '✗ ' + (err.message || (T.failed || '')));
      }
    }

    startBtn.disabled = false;
    clearBtn.disabled = false;
    dropzone.style.pointerEvents = '';
    dropzone.style.opacity = '';

    // Reload the page so the new tracks appear in the list below.
    // Could also fetch them and inject, but a full reload is simpler and
    // ensures position indexes / album-grouping are correct.
    const anyDone = queue.some(q => q.status === 'done');
    if (anyDone) {
      setTimeout(() => location.reload(), 700);
    }
  });

  async function uploadOne(item, sharedArtist, sharedAlbum, sharedCover) {
    setItemStatus(item, 'uploading');

    const fd = new FormData();
    fd.append('audio', item.file);
    if (sharedArtist) fd.append('artist', sharedArtist);
    if (sharedAlbum)  fd.append('album',  sharedAlbum);
    if (sharedCover)  fd.append('cover',  sharedCover);
    // Title is intentionally omitted — server uses filename fallback.

    // We can't reliably distinguish "still uploading bytes" from
    // "uploading done, ffmpeg running" without progress events, but the
    // status flips to "Converteren…" once the request is past upload phase.
    // We approximate this by waiting until the response arrives — by then
    // both phases are complete on the server side. For a smoother feel we
    // briefly show "transcoding" near the end of the request lifecycle.
    const transcodeHint = setTimeout(() => {
      if (item.status === 'uploading') setItemStatus(item, 'transcoding');
    }, 1500);

    try {
      const res = await fetch('/admin/audio/upload', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: fd,
        credentials: 'same-origin',
      });
      clearTimeout(transcodeHint);

      // Server responds with JSON for our Accept header. If it didn't
      // (e.g. session expired and got an HTML login page), surface that.
      let data;
      try { data = await res.json(); }
      catch (_) { throw new Error((T.err_unexpected || '') + ' (' + res.status + ')'); }

      if (!res.ok || !data.ok) {
        throw new Error(data.error || ('HTTP ' + res.status));
      }

      setItemStatus(item, 'done', '✓ ' + (data.title || (T.st_done || '')));
    } catch (err) {
      clearTimeout(transcodeHint);
      throw err;
    }
  }

  // ── Click-to-copy embed codes ─────────────────────────────────
  document.querySelectorAll('[data-copy]').forEach(el => {
    el.addEventListener('click', async () => {
      const text = el.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        el.classList.add('is-copied');
        const original = el.textContent;
        el.textContent = '✓ ' + (T.copied || '');
        setTimeout(() => {
          el.classList.remove('is-copied');
          el.textContent = original;
        }, 1200);
      } catch (_) { /* fall through — selection still works */ }
    });
  });

  // ── "+ Track zonder audio": maak een link-only stub + open de editor ──
  const addLinkBtn = document.getElementById('add-link-track-btn');
  if (addLinkBtn) {
    addLinkBtn.addEventListener('click', async () => {
      addLinkBtn.disabled = true;
      try {
        const r = await fetch('/admin/audio/create-link', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: (T.new_track || '') }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || (T.create_failed || ''));
        if (typeof window.openTrackEditor !== 'function') { location.reload(); return; }
        window.openTrackEditor({ id: j.id, onSaved: () => location.reload() });
      } catch (err) {
        alert((T.create_failed || '') + ': ' + err.message);
      } finally {
        addLinkBtn.disabled = false;
      }
    });
  }

  // ── Wire all "Edit" buttons to the track-editor modal ─────────
  // After save we patch the row in-place rather than reloading,
  // so the user keeps their scroll position on long lists.
  document.querySelectorAll('[data-track-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof window.openTrackEditor !== 'function') {
        alert((T.editor_not_loaded || ''));
        return;
      }
      const id = btn.dataset.id;
      window.openTrackEditor({
        id,
        onSaved: (track) => {
          const row = document.querySelector('li[data-track-id="' + id + '"]');
          if (!row) return;
          // Update visible cells
          const titleEl  = row.querySelector('[data-cell="title"]');
          const artistEl = row.querySelector('[data-cell="artist"]');
          const albumEl  = row.querySelector('[data-cell="album"]');
          if (titleEl)  titleEl.textContent  = track.title  || (T.untitled || '');
          if (artistEl) artistEl.textContent = track.artist || '—';
          if (albumEl)  {
            albumEl.textContent = track.album || '';
            if (track.album) albumEl.removeAttribute('hidden');
            else albumEl.setAttribute('hidden', '');
          }
          // Update cover thumb (replace element if type changed)
          const oldThumb = row.querySelector('[data-cover-thumb]');
          if (oldThumb) {
            const parent = oldThumb.parentElement;
            if (track.cover_url) {
              const img = document.createElement('img');
              img.className = 'ax-track-cover';
              img.src = track.cover_url;
              img.alt = '';
              img.dataset.coverThumb = '';
              parent.replaceChild(img, oldThumb);
            } else {
              const sp = document.createElement('span');
              sp.className = 'ax-track-cover ax-track-cover-empty';
              sp.textContent = '♫';
              sp.dataset.coverThumb = '';
              parent.replaceChild(sp, oldThumb);
            }
          }
        },
      });
    });
  });

  // Download-voor-email toggle — AJAX (geen pagina-reload meer).
  document.querySelectorAll('[data-track-dl]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const want = btn.dataset.on === '1' ? 0 : 1;
      btn.disabled = true;
      try {
        const res = await fetch('/admin/audio/api/' + btn.dataset.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ downloadable: !!want }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        btn.dataset.on = String(want);
        btn.style.color = want ? 'var(--accent,#6b8f71)' : '';
        btn.style.opacity = want ? '1' : '.5';
        btn.title = want
          ? (T.dl_on || '')
          : (T.dl_off || '');
      } catch (e) {
        alert((T.change_failed || '') + ': ' + (e.message || e));
      } finally {
        btn.disabled = false;
      }
    });
  });
})();

  // MusicBrainz-paneel (shaer-mbz). Binnen run(), niet op moduleniveau:
  // deze modules krijgen bij elke paginawissel opnieuw init(), en een blok dat
  // maar een keer per sessie draait is precies wat shaer-5s1 opleverde.
  wireMusicBrainz();
}

// ── MusicBrainz: ben jij dit? (shaer-mbz, stap 2) ─────────────────
//
// De kandidaten komen van de server, want MusicBrainz eist een verzoek per
// seconde per APPLICATIE en een User-Agent met contact -- allebei niet vanuit
// een browser af te dwingen.
//
// WIJ KIEZEN NIET. Ook niet als er precies een treffer is: een verkeerd
// geraden MBID zet jouw naam onder andermans werk. De knop staat er, de klik
// is van de artiest.
function wireMusicBrainz() {
  const knop = document.getElementById('mb-zoek-btn');
  const veld = document.getElementById('mb-q');
  const uit = document.getElementById('mb-uit');
  if (!knop || !veld || !uit || knop.__wired) return;
  knop.__wired = true;

  const el = (tag, cls, tekst) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (tekst != null) e.textContent = tekst;   // textContent: nooit HTML uit een vreemd register
    return e;
  };

  async function zoek() {
    const q = (veld.value || '').trim();
    if (!q) return;
    uit.hidden = false;
    uit.replaceChildren(el('p', 'ax-hint', T.aaud_mb_busy || 'Zoeken…'));
    knop.disabled = true;
    try {
      const r = await fetch(`api/musicbrainz?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const j = await r.json();
      toon((j && j.kandidaten) || []);
    } catch {
      uit.replaceChildren(el('p', 'ax-hint', T.aaud_mb_fail || 'MusicBrainz is even niet bereikbaar.'));
    } finally {
      knop.disabled = false;
    }
  }

  function toon(kandidaten) {
    if (!kandidaten.length) {
      uit.replaceChildren(el('p', 'ax-hint', T.aaud_mb_none || 'Niets gevonden.'));
      return;
    }
    const lijst = el('ul', 'mb-lijst');
    for (const k of kandidaten) {
      const li = el('li', 'mb-kandidaat');
      li.appendChild(el('strong', null, k.naam));
      // De toelichting is het hele punt: er zijn drie bands die Nirvana heten,
      // en zonder dit veld kiest iemand de verkeerde.
      const bij = [k.toelichting, k.soort, k.land, k.jaren].filter(Boolean).join(' · ');
      if (bij) li.appendChild(el('small', 'mb-bij', bij));
      const open = el('a', 'mb-open', T.aaud_mb_open || 'Bekijk op MusicBrainz');
      open.href = k.url; open.target = '_blank'; open.rel = 'noopener';
      li.appendChild(open);
      li.appendChild(kiesForm(k));
      lijst.appendChild(li);
    }
    uit.replaceChildren(lijst);
  }

  function kiesForm(k) {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = 'musicbrainz/link';
    for (const [naam, waarde] of [['_csrf', csrf()], ['mbid', k.mbid], ['naam', k.naam]]) {
      const i = document.createElement('input');
      i.type = 'hidden'; i.name = naam; i.value = waarde || '';
      f.appendChild(i);
    }
    const b = el('button', 'ax-btn', T.aaud_mb_pick || 'Dit ben ik');
    b.type = 'submit';
    f.appendChild(b);
    return f;
  }

  // Het token staat al in elk formulier op deze pagina; er is er geen apart voor.
  const csrf = () => (document.querySelector('input[name="_csrf"]') || {}).value || '';

  knop.addEventListener('click', zoek);
  veld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); zoek(); } });
}
