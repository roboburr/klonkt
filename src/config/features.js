// Feature-flags (boot-tijd, via env).
//
// Lite-modus: zet KLONKT_AUDIO=off in .env om de HELE audio-feature uit te
// schakelen — geen audio-/playlist-/download-/embed-routes, geen ffmpeg-aanroep,
// geen speler en geen [[track]]/[[playlist]]-shortcodes. Zo draait Klonkt als
// lichte blog/foto/EPK-site op een omgeving zónder ffmpeg/exec. Hub én Cirkels
// blijven gewoon werken (die hangen niet van audio af).
//
// Default = aan (volledige versie). Alleen de letterlijke waarde 'off' schakelt uit.
export function audioEnabled() {
  return String(process.env.KLONKT_AUDIO ?? 'on').toLowerCase() !== 'off';
}
