/**
 * Wakker worden: een Klonkt die niet altijd aan staat (shaer-xzab.4 en .5).
 *
 * Een Klonkt op een Mac thuis slaapt, gaat de trein in, staat een weekend uit.
 * Bij het terugkomen doet hij twee dingen, en die doen elk iets anders -- dat is
 * uitgezocht in xzab.6, in de broncode van Mastodon, Akkoma, Pleroma, Misskey
 * en GoToSocial:
 *
 *   AANKONDIGEN (.5): een actor-Update naar de gedeelde inboxes van de volgers.
 *     Een binnenkomende POST is wat Mastodon, Akkoma en Misskey weer naar ons
 *     laat bezorgen (Mastodon schrijft een domein af na mislukkingen op zeven
 *     dagen; Pleroma al na één uitgeputte bezorging, en start bij een
 *     binnenkomende activiteit een controle van onze /). Ondertekende GETs
 *     zetten daar niets terug.
 *   INHALEN (.4): de outboxes van wie je volgt nalopen, vanaf het moment dat we
 *     wegvielen. Het enige wat gemiste posts terugbrengt: GoToSocial gooit een
 *     bezorging na een paar minuten weg, Mastodon na twee à drie dagen.
 *
 * WAKKER WORDEN HERKENNEN, en niet bij elke herstart (npm herstart Klonkt bij
 * elke opgeslagen wijziging): een sprong in de wandklok tussen twee ticks, of
 * het opstarten na langer dan AWAY_MS sinds het laatste teken van leven. Dat
 * teken staat in app_settings, zodat het een herstart overleeft.
 */

import db from '../config/database.js';
import { getSetting, setSetting, apEnabled } from './SettingsService.js';

export const AWAY_MS = 30 * 60 * 1000;            // korter is een herstart of een korte slaap
export const TICK_MS = 60 * 1000;
// Inhalen: niet verder terug dan een week, en per account een maximum, zodat
// een week weg geen storm van verzoeken wordt.
export const CATCHUP_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CATCHUP_PER_ACCOUNT = 40;
export const CATCHUP_MAX_ACCOUNTS = 200;
const CATCHUP_GAP_MS = 300;                       // beleefd: na elkaar, met een adempauze
const ALIVE_KEY = 'last_alive_at';

/**
 * Is dit wakker worden, en sinds wanneer waren we weg? Puur.
 * `lastAlive` is het laatste teken van leven (ms), `now` nu. Null als het geen
 * afwezigheid was (of als er nog nooit een teken was: een eerste start is geen
 * terugkomst).
 */
export function absence(lastAlive, now) {
  if (!Number.isFinite(lastAlive) || lastAlive <= 0) return null;
  const away = now - lastAlive;
  return away >= AWAY_MS ? { since: lastAlive, awayMs: away } : null;
}

/** Vanaf wanneer inhalen: het wegvallen, maar nooit verder terug dan het venster. */
export function catchupSince(since, now) {
  return Math.max(since, now - CATCHUP_MAX_WINDOW_MS);
}

/**
 * De wakker-routine zelf, met haar afhankelijkheden van buiten, zodat ze
 * zonder netwerk te toetsen is. Eerst aankondigen (dan bezorgen de anderen weer
 * terwijl wij inhalen), dan inhalen, account voor account.
 */
export async function runWake({ since, now = Date.now() }, deps) {
  const { sites, deliverActorUpdate, following, backfill, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
  const from = catchupSince(since, now);
  let announced = 0, fetched = 0, added = 0;
  for (const site of sites()) {
    try { await deliverActorUpdate(site); announced++; } catch { /* een site die niet lukt, houdt de rest niet op */ }
  }
  for (const site of sites()) {
    const accounts = following(site.slug).slice(0, CATCHUP_MAX_ACCOUNTS);
    for (const actorUri of accounts) {
      try { added += (await backfill(site.slug, actorUri, CATCHUP_PER_ACCOUNT, { since: from })) || 0; } catch { /* best-effort */ }
      fetched++;
      await pause(CATCHUP_GAP_MS);
    }
  }
  return { announced, fetched, added };
}

// ── Het echte werk: welke sites, wie ze volgen ───────────────────────────────

function realSites() {
  try { return db.prepare('SELECT * FROM sites').all(); } catch { return []; }
}
/** Wie deze site volgt en waar dat rond is: alleen GEACCEPTEERD, want een
 *  wachtend volgverzoek geeft (nog) geen recht op de besloten posts, en de
 *  outbox van iemand die nee zei hoort niet in je stroom. */
export function acceptedFollowing(slug) {
  try {
    return db.prepare("SELECT actor_uri FROM ap_following WHERE slug = ? AND status = 'accepted' ORDER BY id").all(slug).map((r) => r.actor_uri);
  } catch { return []; }
}

let _waking = false;
async function wake(since, now) {
  if (_waking) return;                          // één terugkomst tegelijk
  _waking = true;
  try {
    if (!apEnabled()) return;
    const AP = await import('./ActivityPubService.js');
    const r = await runWake({ since, now }, {
      sites: realSites,
      deliverActorUpdate: AP.deliverActorUpdate,
      following: acceptedFollowing,
      backfill: AP.backfillFromOutbox,
    });
    console.log(`[wake] back after ${Math.round((now - since) / 60000)} min: Update from ${r.announced} site(s), caught up ${r.fetched} account(s), +${r.added} post(s)`);
  } catch (e) {
    console.warn('[wake]', e && e.message);
  } finally { _waking = false; }
}

function readAlive() {
  const v = Number(getSetting(ALIVE_KEY, ''));
  return Number.isFinite(v) ? v : null;
}
function noteAlive(now) {
  try { setSetting(ALIVE_KEY, String(now)); } catch { /* een teken minder is geen ramp */ }
}

let _timer = null;
let _lastTick = null;

/** Eén tik: is er sinds de vorige tik een gat? Dan wakker worden. Los van de
 *  timer, zodat het te toetsen is. */
export function tick(now = Date.now(), onWake = wake) {
  const gat = absence(_lastTick, now);
  _lastTick = now;
  noteAlive(now);
  if (gat) onWake(gat.since, now);
  return gat;
}

/** Bij het opstarten: hoe lang stonden we uit? Daarna elke minuut een tik. */
export function startWakeWatch(onWake = wake) {
  if (_timer) return;
  const now = Date.now();
  const opStart = absence(readAlive(), now);
  _lastTick = now;
  noteAlive(now);
  if (opStart) onWake(opStart.since, now);
  _timer = setInterval(() => { tick(Date.now(), onWake); }, TICK_MS);
  if (_timer.unref) _timer.unref();
}

/** Voor de toetsen: de tik-staat terugzetten. */
export function _resetForTests() { _lastTick = null; if (_timer) { clearInterval(_timer); _timer = null; } }
