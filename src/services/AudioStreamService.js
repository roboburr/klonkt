/**
 * AudioStreamService — builds URLs for the audio streaming route.
 *
 * ┌─ ANTI-THEFT MODEL (Spotify-flavoured, step 1 — 2026-05-20) ─────────────┐
 * │ audioUrl() returns a plain /audio/stream/<filename> path. There is NO   │
 * │ signed/expiring token in the URL — that earlier design baked a single   │
 * │ 10-min deadline into a whole queue at render time, so later tracks'     │
 * │ tokens expired mid-session and the player looped "next" forever.        │
 * │                                                                          │
 * │ Protection now lives in two NON-expiring layers, so it can't cause that │
 * │ failure again:                                                           │
 * │   1. Client (audio-player.js) fetch()es the bytes and plays from a      │
 * │      blob: object URL — no shareable link, no "save audio as".          │
 * │   2. Server (routes/audio.js) gates /audio/stream to same-origin        │
 * │      browser fetches — blocks address-bar paste, hotlinks, curl/yt-dlp. │
 * │                                                                          │
 * │ FUTURE STEPS (deliberate, tested one at a time):                         │
 * │   - step 2: MSE chunked/progressive streaming (true Spotify feel)        │
 * │   - step 3: per-session short-lived token in a header, minted JIT        │
 * │   - step 4: light byte obfuscation (XOR/key) on the wire                 │
 * └──────────────────────────────────────────────────────────────────────┘
 */

/**
 * Build the public stream URL for an audio filename.
 * Returns null for a falsy filename so callers can guard playability.
 */
export function audioUrl(filename) {
  if (!filename) return null;
  return `/audio/stream/${encodeURIComponent(filename)}`;
}

export default { audioUrl };
