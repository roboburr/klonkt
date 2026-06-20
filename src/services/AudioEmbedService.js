/**
 * AudioEmbedService — Parse URLs and return embed HTML
 * Supports: Spotify, Bandcamp, SoundCloud, Apple Music, YouTube, Vimeo
 * 
 * Usage in post content:
 * <p>https://open.spotify.com/track/123abc</p>
 * →
 * <figure class="folio-embed folio-embed--spotify">
 *   <iframe src="..."></iframe>
 * </figure>
 */

class AudioEmbedService {
  static detectProvider(url) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();

    // Alleen http(s)-URL's embedden. De provider-regexes hieronder zijn NIET
    // verankerd, dus zonder deze check zou bv. `javascript:alert(1)//youtu.be/x`
    // matchen en als embed-URL belanden (stored XSS via een [[embed:...]]-
    // shortcode — die tekst gaat niet langs de HTML-sanitizer omdat 'ie in een
    // text-node zit). De scheme-guard sluit javascript:/data:/vbscript: enz. uit.
    if (!/^https?:\/\//i.test(url)) return null;

    // Spotify
    if (/open\.spotify\.com\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/i.test(url)) {
      const match = url.match(/\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/i);
      return { provider: 'spotify', type: match[1], id: match[2], url };
    }

    // Bandcamp
    if (/bandcamp\.com\/(track|album)/i.test(url)) {
      return { provider: 'bandcamp', url };
    }

    // SoundCloud
    if (/soundcloud\.com/i.test(url)) {
      return { provider: 'soundcloud', url };
    }

    // Apple Music
    if (/music\.apple\.com\/([a-z]{2})\/(?:album|playlist|song)\//i.test(url)) {
      return { provider: 'applemusic', url };
    }

    // YouTube — video-id is altijd exact 11 tekens (lijnt uit met de client-side
    // ytId() in embed-player.js, die ook {11} verwacht).
    if (/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([A-Za-z0-9_-]{11})/i.test(url)) {
      const match = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/i);
      return { provider: 'youtube', id: match[1], url };
    }

    // Vimeo
    if (/vimeo\.com\/(?:video\/)?(\d+)/i.test(url)) {
      const match = url.match(/\d+/);
      return { provider: 'vimeo', id: match[0], url };
    }

    return null;
  }

  static generateIframe(provider, config) {
    switch (provider) {
      // Eigen custom-spelers (client-side via embed-player.js + de echte
      // platform-API's). We renderen een placeholder met data-attributen i.p.v.
      // het kale platform-iframe, zodat de embed in ÓNZE huisstijl verschijnt.
      case 'youtube':
        return this.embedPlaceholder('youtube', config.id, 'video',
          config.url || `https://youtu.be/${config.id}`);
      case 'soundcloud':
        return this.embedPlaceholder('soundcloud', config.url, 'track', config.url);
      case 'spotify':
        return this.embedPlaceholder('spotify', `spotify:${config.type}:${config.id}`,
          config.type, config.url || `https://open.spotify.com/${config.type}/${config.id}`);
      // Geen JS-API (Bandcamp/Apple) of niet-prioritair (Vimeo): blijven een
      // iframe; mutual-exclusion loopt voor deze via de blur-fallback.
      case 'bandcamp':
        return this.bandcampIframe(config);
      case 'applemusic':
        return this.applemusicIframe(config);
      case 'vimeo':
        return this.vimeoIframe(config);
      default:
        return null;
    }
  }

  /**
   * Placeholder voor een eigen custom-speler. embed-player.js pikt
   * .folio-embed[data-embed-provider] op en bouwt de kaart + speler client-side.
   * ALLE waarden via escape() — post.content_html wordt ongeescaped uitgevoerd.
   */
  static embedPlaceholder(provider, ref, type, url) {
    const attrs = [
      `data-embed-provider="${this.escape(provider)}"`,
      `data-embed-ref="${this.escape(ref)}"`,
      type ? `data-embed-type="${this.escape(type)}"` : '',
      `data-embed-url="${this.escape(url)}"`,
    ].filter(Boolean).join(' ');
    return `<div class="folio-embed folio-embed--${this.escape(provider)} pcms-embed pcms-embed-card pcms-embed-loading" ${attrs}></div>`;
  }

  static spotifyIframe({ type, id }) {
    const src = `https://open.spotify.com/embed/${type}/${id}`;
    return `
      <figure class="folio-embed folio-embed--spotify">
        <iframe src="${this.escape(src)}" 
                style="width:100%;height:152px;border:0;" 
                loading="lazy"
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                title="Spotify ${type}"></iframe>
      </figure>
    `.trim();
  }

  static bandcampIframe({ url }) {
    const encodedUrl = encodeURIComponent(url);
    const src = `https://bandcamp.com/EmbeddedPlayer/url=${encodedUrl}/size=large/bgcol=faf8f3/linkcol=c2410c/tracklist=false/transparent=true/`;
    return `
      <figure class="folio-embed folio-embed--bandcamp">
        <iframe src="${this.escape(src)}"
                style="width:100%;height:470px;border:0;"
                loading="lazy"
                allow="encrypted-media"
                title="Bandcamp player"></iframe>
      </figure>
    `.trim();
  }

  static soundcloudIframe({ url }) {
    const params = {
      url: url,
      color: '#ff5500',
      auto_play: 'false',
      hide_related: 'true',
      show_comments: 'false',
      show_user: 'true',
      show_reposts: 'false',
      show_teaser: 'false',
      visual: 'true'
    };
    const query = new URLSearchParams(params).toString();
    const src = `https://w.soundcloud.com/player/?${query}`;
    return `
      <figure class="folio-embed folio-embed--soundcloud">
        <iframe src="${this.escape(src)}"
                style="width:100%;height:300px;border:0;"
                loading="lazy"
                allow="autoplay; clipboard-write; encrypted-media"
                title="SoundCloud player"></iframe>
      </figure>
    `.trim();
  }

  static applemusicIframe({ url }) {
    const match = url.match(/music\.apple\.com\/([a-z]{2}\/(?:album|playlist|song)\/[^/?#]+\/[0-9]+)/i);
    if (!match) return null;
    const src = `https://embed.music.apple.com/${match[1]}`;
    return `
      <figure class="folio-embed folio-embed--applemusic">
        <iframe src="${this.escape(src)}"
                style="width:100%;height:175px;border:0;overflow:hidden;border-radius:8px;"
                loading="lazy"
                allow="autoplay; clipboard-write; encrypted-media"
                title="Apple Music"></iframe>
      </figure>
    `.trim();
  }

  static youtubeIframe({ id }) {
    const src = `https://www.youtube-nocookie.com/embed/${id}`;
    return `
      <figure class="folio-embed folio-embed--youtube">
        <iframe src="${this.escape(src)}"
                style="aspect-ratio:16/9;width:100%;height:auto;border:0;"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen
                title="YouTube video"></iframe>
      </figure>
    `.trim();
  }

  static vimeoIframe({ id }) {
    const src = `https://player.vimeo.com/video/${id}`;
    return `
      <figure class="folio-embed folio-embed--vimeo">
        <iframe src="${this.escape(src)}"
                style="aspect-ratio:16/9;width:100%;height:auto;border:0;"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen
                title="Vimeo video"></iframe>
      </figure>
    `.trim();
  }

  /**
   * Auto-embed: Scan paragraphs containing only a URL.
   * Handles two markdown-rendered shapes:
   *   <p>https://url</p>                      (bare URL — when GFM auto-link is off)
   *   <p><a href="https://url">https://url</a></p>  (marked GFM auto-link — what we get)
   * Either way → <figure class="folio-embed">...
   */
  static autoembed(html) {
    if (!html) return html;
    return html.replace(
      /<p>\s*(?:<a\b[^>]*?\shref="([^"]+)"[^>]*>[^<]*<\/a>|(https?:\/\/[^\s<>"']+))\s*<\/p>/gi,
      (match, hrefUrl, bareUrl) => {
        const url = hrefUrl || bareUrl;
        const detected = this.detectProvider(url);
        if (detected) {
          const iframe = this.generateIframe(detected.provider, detected);
          return iframe || match;
        }
        return match;
      }
    );
  }

  /**
   * Replace [[embed:<url>]] shortcodes met de platform-iframe (YouTube, Spotify,
   * SoundCloud, Apple Music, Bandcamp, Vimeo). De editor-knop voegt deze
   * shortcode in; losse URL-regels embedden ook automatisch via autoembed().
   * Niet-ondersteunde/ongeldige URLs krijgen een nette inline-melding.
   */
  static embedMediaShortcodes(html) {
    if (!html) return html;
    return html.replace(/\[\[embed:([^\]]+)\]\]/gi, (match, rawUrl) => {
      const url = rawUrl.trim().replace(/&amp;/g, '&');
      const detected = this.detectProvider(url);
      if (!detected) {
        return `<div class="post-embed-missing"><em>Embed: niet-ondersteunde of ongeldige URL.</em></div>`;
      }
      return this.generateIframe(detected.provider, detected) || match;
    });
  }

  /**
   * Replace [[track:<id>]] shortcodes with v9-style player markup.
   * Caller passes a lookup function (id) -> { id, title, artist, url, cover }
   * where url is already a signed /audio/stream/... URL. Unknown ids → left as-is.
   */
  static embedTrackShortcodes(html, trackLookup) {
    if (!html || typeof trackLookup !== 'function') return html;
    return html.replace(/\[\[track:([A-Za-z0-9_-]+)\]\]/g, (match, id) => {
      const t = trackLookup(id);
      if (!t || !t.url) return match;
      const trackJson = JSON.stringify({
        id,
        url: t.url,
        title: t.title || 'Untitled',
        artist: t.artist || '',
        cover: t.cover || '',
      });
      const titleH = this.escape(t.title || 'Untitled');
      const artistH = this.escape(t.artist || '');
      const urlH = this.escape(t.url);
      const dataAttr = trackJson
        .replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
      // id="track-<id>" = anker zodat de mini-speler hierheen kan scrollen.
      return `<div class="post-audio-track" id="track-${id}" data-pcms-track-id="${id}" data-pcms-track-url="${urlH}" data-pcms-track='${dataAttr}'>
  <button type="button" class="pat-play" aria-label="Play ${titleH}">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4l12 8-12 8z"/></svg>
  </button>
  <div class="pat-info">
    <div class="pat-title">${titleH}</div>
    ${artistH ? `<div class="pat-artist">${artistH}</div>` : ''}
  </div>
</div>`;
    });
  }

  /**
   * Replace [[album:<name>]] shortcodes with a v9-style album block.
   * Caller passes a lookup function (name) -> { title, artist, cover, tracks: [{url,title,artist,cover}, ...] }
   * Tracks must already have signed URLs. Unknown albums → left as-is.
   * The wrapper carries the full album JSON so audio-player.js can queue it
   * when any track or the album play button is clicked.
   */
  static embedAlbumShortcodes(html, albumLookup) {
    if (!html || typeof albumLookup !== 'function') return html;
    return html.replace(/\[\[album:([^\]]+)\]\]/g, (match, rawName) => {
      const name = rawName.trim();
      const album = albumLookup(name);
      if (!album || !album.tracks || !album.tracks.length) return match;

      // Stable DOM id for this rendering — used as data-pcms-album-id on tracks
      const albumDomId = 'album-' + Math.random().toString(36).slice(2, 10);
      const albumJson = JSON.stringify(album.tracks)
        .replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
      const titleH = this.escape(album.title || name);
      const artistH = this.escape(album.artist || '');
      const coverH = album.cover ? this.escape(album.cover) : '';

      const trackItems = album.tracks.map((t, i) => {
        const tTitle = this.escape(t.title || ('Track ' + (i + 1)));
        const tArtist = this.escape(t.artist || '');
        const tUrl = this.escape(t.url);
        return `    <li class="post-audio-track"${t.id ? ` id="track-${t.id}" data-pcms-track-id="${t.id}"` : ''} data-pcms-track-url="${tUrl}" data-pcms-album-id="${albumDomId}">
      <button type="button" class="pat-play" aria-label="Play ${tTitle}">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4l12 8-12 8z"/></svg>
      </button>
      <div class="pat-info">
        <span class="pat-track-num">${i + 1}.</span>
        <div class="pat-title">${tTitle}</div>
        ${tArtist && tArtist !== artistH ? `<div class="pat-artist">${tArtist}</div>` : ''}
      </div>
    </li>`;
      }).join('\n');

      return `<div class="post-album" id="${albumDomId}" data-pcms-album='${albumJson}' data-pcms-album-title="${titleH}">
  <div class="post-album-header">
    <button type="button" class="post-album-cover-btn" data-pcms-album-id="${albumDomId}" aria-label="Play album ${titleH}">
      ${coverH
        ? `<img src="${coverH}" alt="" class="post-album-cover-img">`
        : `<svg class="post-album-cover-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 17V5l12-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="18" cy="15" r="3"/></svg>`}
      <span class="post-album-play-overlay" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 4l12 8-12 8z"/></svg>
      </span>
    </button>
    <div class="post-album-info">
      <h3 class="post-album-title">${titleH}</h3>
      ${artistH ? `<p class="post-album-artist">${artistH}</p>` : ''}
      <p class="post-album-count">${album.tracks.length} track${album.tracks.length === 1 ? '' : 's'}</p>
    </div>
  </div>
  <ol class="post-album-tracks">
${trackItems}
  </ol>
</div>`;
    });
  }

  /**
   * Replace [[playlist:<id>]] shortcodes with a v9-style album block.
   * Caller passes a lookup function (id) -> hydrated playlist object from
   * PlaylistService.get(), or null. Unknown playlists render an inline
   * "niet gevonden" placeholder so the post still validates as HTML.
   *
   * Shape returned by lookup:
   *   { id, title, artist, year, cover, kind, tracks: [{url,title,artist,cover,duration}, ...] }
   *
   * `kind` is honored:
   *   - 'album'    → ordered list with track numbers
   *   - 'playlist' → list with per-track cover thumbnails (mixtape feel)
   *
   * opts: { isAdmin: boolean } — when true, an edit/delete action overlay
   * is rendered top-right of each card. The handlers are wired up in
   * audio-player.js via event delegation on data-pcms-playlist-delete.
   */
  static embedPlaylistShortcodes(html, playlistLookup, opts = {}) {
    if (!html || typeof playlistLookup !== 'function') return html;
    const isAdmin = !!opts.isAdmin;
    return html.replace(/\[\[playlist:([a-z0-9][a-z0-9-]*)\]\]/gi, (match, rawId) => {
      const id = rawId.toLowerCase();
      const pl = playlistLookup(id);

      if (!pl) {
        return `<div class="post-playlist-missing"><em>Playlist "${this.escape(id)}" niet gevonden.</em></div>`;
      }
      if (!pl.tracks || !pl.tracks.length) {
        return `<div class="post-playlist-empty"><em>Playlist "${this.escape(pl.title)}" heeft geen beschikbare tracks.</em></div>`;
      }

      const albumDomId = 'album-' + id;
      const kind = (pl.kind === 'playlist') ? 'playlist' : 'album';
      const kindLabel = kind === 'playlist' ? '📃 Playlist' : '💿 Album';
      const titleH  = this.escape(pl.title || 'Naamloos');
      const artistH = this.escape(pl.artist || '');
      const coverH  = pl.cover ? this.escape(pl.cover) : '';

      // Audio-player.js reads data-pcms-album for queue. Same shape as
      // embedAlbumShortcodes — keep both in sync.
      const tracksData = pl.tracks.map(t => ({
        id:     t.id,
        url:    t.url,
        title:  t.title,
        artist: t.artist || pl.artist || '',
        cover:  t.cover  || pl.cover  || '',
      }));
      const albumJson = JSON.stringify(tracksData)
        .replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');

      // Total duration for the meta line
      const totalSec = pl.tracks.reduce((s, t) => s + (t.duration || 0), 0);
      const metaParts = [];
      if (pl.year) metaParts.push(String(pl.year));
      metaParts.push(pl.tracks.length + (pl.tracks.length === 1 ? ' track' : ' tracks'));
      if (totalSec > 0) {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        if (h > 0) metaParts.push(`${h}h ${m}m`);
        else metaParts.push(`${Math.max(1, m)} min`);
      }
      const metaLine = this.escape(metaParts.join(' · '));
      const firstUrl = this.escape(pl.tracks[0].url);

      // Track items — playlist-kind shows per-track cover thumbs, album-kind shows numbers
      const trackItems = pl.tracks.map((t, i) => {
        const tTitleH  = this.escape(t.title || ('Track ' + (i + 1)));
        const tArtistH = this.escape(t.artist || '');
        const tUrl     = this.escape(t.url);
        const showArtist = tArtistH && tArtistH !== artistH;

        // Duration cell — render even when 0 for consistent column layout
        const durHtml = t.duration > 0
          ? `<span class="pat-duration">${Math.floor(t.duration / 60)}:${String(t.duration % 60).padStart(2, '0')}</span>`
          : `<span class="pat-duration pat-duration-empty">—:—</span>`;

        // Leader cell — number for albums, cover thumb for playlists
        const leader = (kind === 'playlist' && t.cover)
          ? `<span class="pat-cover" style="background-image:url(${this.escape(t.cover)})" aria-hidden="true"></span>`
          : `<span class="pat-num">${i + 1}</span>`;

        const trackBase = String(t.url).split('?')[0];
        return `    <li class="post-album-track-compact"${t.id ? ` id="track-${t.id}" data-pcms-track-id="${t.id}"` : ''}>
      <button type="button" class="pat-row"
              data-pcms-track-url="${tUrl}"
              data-pcms-album-id="${albumDomId}"
              data-pcms-track-base="${this.escape(trackBase)}"
              aria-label="Speel ${tTitleH}">
        ${leader}
        <span class="pat-meta">
          <span class="pat-title">${tTitleH}</span>
          ${showArtist ? `<span class="pat-artist">${tArtistH}</span>` : ''}
        </span>
        ${durHtml}
      </button>
    </li>`;
      }).join('\n');

      return `<div class="post-album" id="${albumDomId}"
     data-pcms-album='${albumJson}'
     data-pcms-album-title="${titleH}"
     data-pcms-album-kind="${kind}"
     data-pcms-playlist-id="${this.escape(id)}">
${isAdmin ? `  <div class="post-album-actions" role="group" aria-label="Playlist beheren">
    <a class="post-album-action" href="/admin/playlists?edit=${this.escape(id)}" title="Bewerk playlist" aria-label="Bewerk playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
    </a>
    <button type="button" class="post-album-action is-danger" data-pcms-playlist-delete="${this.escape(id)}" data-pcms-playlist-title="${titleH}" title="Verwijder playlist" aria-label="Verwijder playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
    </button>
  </div>
` : ''}  <div class="post-album-header">
    <button type="button" class="post-album-cover-btn"
            data-pcms-track-url="${firstUrl}"
            data-pcms-album-id="${albumDomId}"
            aria-label="Speel ${kind === 'playlist' ? 'playlist' : 'album'}">
      ${coverH
        ? `<span class="post-album-cover" style="background-image:url('${coverH}')"></span>`
        : `<span class="post-album-cover post-album-cover-empty">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17V5l12-2v12"/><circle cx="6" cy="17" r="3" fill="currentColor"/><circle cx="18" cy="15" r="3" fill="currentColor"/></svg>
           </span>`}
      <span class="post-album-cover-play" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M8 4l12 8-12 8z" fill="currentColor"/></svg>
      </span>
    </button>
    <div class="post-album-info">
      <p class="post-album-label">${kindLabel}</p>
      <h3 class="post-album-title">${titleH}</h3>
      ${artistH ? `<p class="post-album-artist">${artistH}</p>` : ''}
      <p class="post-album-meta">${metaLine}</p>
    </div>
  </div>
  <ol class="post-album-tracks post-album-tracks-compact" data-album-kind="${kind}">
${trackItems}
  </ol>
</div>`;
    });
  }

  /**
   * Human-readable label for a provider slug. Used by external-link buttons.
   */
  static platformLabel(provider) {
    return ({
      spotify: 'Spotify',
      bandcamp: 'Bandcamp',
      soundcloud: 'SoundCloud',
      applemusic: 'Apple Music',
      youtube: 'YouTube',
      vimeo: 'Vimeo',
      tidal: 'Tidal',
      deezer: 'Deezer',
      mixcloud: 'Mixcloud',
    })[provider] || 'External link';
  }

  /**
   * Detect platform from URL purely by hostname (covers more services than
   * detectProvider, which is embed-focused). Used for [[link:url]] rendering.
   */
  static detectLinkPlatform(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.includes('open.spotify.com') || host === 'spotify.com') return 'spotify';
      if (host.includes('bandcamp.com')) return 'bandcamp';
      if (host.includes('soundcloud.com')) return 'soundcloud';
      if (host.includes('music.apple.com') || host.includes('itunes.apple.com')) return 'applemusic';
      if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('music.youtube.com')) return 'youtube';
      if (host.includes('vimeo.com')) return 'vimeo';
      if (host.includes('tidal.com')) return 'tidal';
      if (host.includes('deezer.com')) return 'deezer';
      if (host.includes('mixcloud.com')) return 'mixcloud';
      return 'other';
    } catch (e) {
      return null;
    }
  }

  /**
   * Replace [[link:url]] or [[link:url|Custom Label]] shortcodes with a
   * branded "Open in <Platform>" anchor (no iframe). Opens in new tab.
   * Per Robin's v9: "Externe link, klik = open platform (target _blank)".
   */
  static embedExternalLinkShortcodes(html) {
    if (!html) return html;
    return html.replace(/\[\[link:([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, rawUrl, customLabel) => {
      const url = rawUrl.trim();
      if (!/^https?:\/\//i.test(url)) return match;
      const platform = this.detectLinkPlatform(url) || 'other';
      const label = (customLabel || '').trim();
      const platformLabel = this.platformLabel(platform);
      const buttonText = label || `Open in ${platformLabel}`;
      const urlH = this.escape(url);
      const textH = this.escape(buttonText);
      return `<a class="post-audio-external post-audio-external--${platform}" href="${urlH}" target="_blank" rel="noopener noreferrer" data-platform="${platform}">
  <span class="pae-icon" aria-hidden="true">▶</span>
  <span class="pae-text">${textH}</span>
  <span class="pae-arrow" aria-hidden="true">↗</span>
</a>`;
    });
  }

  static escape(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

export default AudioEmbedService;