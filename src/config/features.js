// Feature flags (boot-time, via env).
//
// Lite mode: set KLONKT_AUDIO=off in .env to disable the ENTIRE audio feature —
// no audio/playlist/download/embed routes, no ffmpeg calls, no player, and no
// [[track]]/[[playlist]] shortcodes. This lets Klonkt run as a lightweight
// blog/photo/EPK site on environments without ffmpeg/exec. Hub and Circles
// keep working (they have no audio dependency).
//
// Default = on (full version). Only the literal value 'off' disables it.
export function audioEnabled() {
  return String(process.env.KLONKT_AUDIO ?? 'on').toLowerCase() !== 'off';
}
