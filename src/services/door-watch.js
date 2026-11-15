/**
 * De andere kant van de deur (shaer-3dwr): welke deuren in jouw lucht open
 * staan, zodat Playtime de sterren van open vrienden kan laten pulseren.
 *
 * Barts besluit (15-11-2026): één instelling van de eigenaar, en dan volgt
 * Klonkt zelf de deur van iedereen in zijn lucht -- wie hem volgt en wie hij
 * volgt. De Updates van hun Klonkts houden de stand hier vers. Playtime heeft
 * geen inbox, dus hij leest het hier: een eigenaar-only collectie,
 * `<actor>/openDoors`, met `since` en `wait` zoals de inbox, zodat een ster
 * binnen seconden gaat pulseren.
 *
 * Zoals de deur zelf: de STAND leeft alleen in het geheugen. Welke deuren we
 * volgen staat wel in de database (dat is een relatie, geen adres), en na een
 * herstart vraagt Klonkt elke gevolgde deur rustig één keer na, want wie al
 * open stond kondigt dat niet opnieuw aan.
 *
 * Wat hier NIET gebeurt: een deur ophalen om te bellen. Dat doet Playtime zelf,
 * vers, en een 404 is dicht. Deze lijst is wie er open staat, niet hoe je er
 * binnenkomt.
 */
import crypto from 'crypto';
import db from '../config/database.js';
import { AP_CONTEXT, actorId } from './ap-core.js';
import { deliverWithRetry, fetchActor, getOrCreateKeys, safeFetch } from './ap-transport.js';

/** Hoeveel nieuwe actors één ronde ophaalt: een grote lucht komt er in delen. */
export const NIEUW_PER_RONDE = 25;
/** Een vriend zonder deur (of die ons weigerde) wordt na een week opnieuw bekeken. */
export const OPNIEUW_NA_MS = 7 * 24 * 3600_000;
/** Zo vaak kijkt Klonkt of de lucht veranderde. */
export const RONDE_MS = 15 * 60_000;
/** Zo langzaam vraagt hij na een herstart de deuren na. */
export const NAVRAAG_TUSSEN_MS = 1000;

const stmt = (sql) => db.prepare(sql);
const rid = () => crypto.randomBytes(4).toString('hex');

// ── De stand, in het geheugen ────────────────────────────────────────

const boot = Date.now().toString(36);
const open = new Map();      // slug -> Map(doorId -> { friend, since })
const versie = new Map();    // slug -> n
const wachters = new Map();  // slug -> Set(resolve)

/** De cursor. Hij draagt de start van dit proces, zodat een herstart nooit een 304 geeft op een oude lijst. */
export const cursor = (slug) => `${boot}.${versie.get(slug) || 0}`;

function veranderd(slug) {
  versie.set(slug, (versie.get(slug) || 0) + 1);
  const w = wachters.get(slug);
  if (w) { wachters.delete(slug); for (const r of w) r(); }
}

/** Zet een deur open of dicht. Geeft true als dat iets veranderde. */
export function markDoor(slug, doorId, friend, isOpen, since = Date.now()) {
  const m = open.get(slug) || new Map();
  if (isOpen) {
    const was = m.get(doorId);
    if (was && was.friend === friend) return false;
    m.set(doorId, { friend, since });
    open.set(slug, m);
  } else {
    if (!m.delete(doorId)) return false;
    if (!m.size) open.delete(slug);
  }
  veranderd(slug);
  return true;
}

/** De open deuren, nieuwste eerst. */
export function list(slug) {
  const m = open.get(slug);
  if (!m) return [];
  return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.since - a.since);
}

/** Wacht tot de lijst verandert, of tot de tijd om is. Geen polling: de lijst zegt het zelf. */
export function waitForChange(slug, { since, waitMs, signal } = {}) {
  const nu = cursor(slug);
  if (!since || since !== nu || !waitMs) return Promise.resolve({ cursor: nu, changed: !!since && since !== nu });
  return new Promise((klaar) => {
    let tijd = null;
    const af = () => {
      clearTimeout(tijd);
      const w = wachters.get(slug);
      if (w) { w.delete(af); if (!w.size) wachters.delete(slug); }
      const c = cursor(slug);
      klaar({ cursor: c, changed: c !== since });
    };
    tijd = setTimeout(af, waitMs);
    if (signal) signal.addEventListener('abort', af, { once: true });
    const w = wachters.get(slug) || new Set();
    w.add(af);
    wachters.set(slug, w);
  });
}

/** Voor de toetsen: alsof Klonkt herstartte. */
export function _forgetAll() { open.clear(); versie.clear(); }

// ── De instelling ────────────────────────────────────────────────────

export function isOn(slug) {
  try { return !!(stmt('SELECT follow_doors FROM sites WHERE slug = ?').get(slug) || {}).follow_doors; }
  catch { return false; }
}

/**
 * Aan of uit. Aan: meteen een ronde, en de deuren navragen. Uit: elk
 * abonnement met een Undo opzeggen en de lijst leeg. Geeft een belofte die
 * klaar is als de eerste ronde klaar is.
 */
export async function setFollowing(base, slug, on) {
  stmt('UPDATE sites SET follow_doors = ? WHERE slug = ?').run(on ? 1 : 0, slug);
  if (on) {
    await reconcile(base, slug);
    await refresh(base, slug);
    return;
  }
  for (const r of rows(slug)) {
    if (r.status === 'pending' || r.status === 'accepted') undo(base, slug, r);
  }
  stmt('DELETE FROM ap_door_follows WHERE slug = ?').run(slug);
  if (open.delete(slug)) veranderd(slug);
}

// ── Welke deuren we volgen ───────────────────────────────────────────

const rows = (slug) => stmt('SELECT * FROM ap_door_follows WHERE slug = ?').all(slug);

/** De lucht van de eigenaar: wie hem volgt en wie hij volgt. */
export function sky(slug) {
  const uit = new Set();
  for (const r of stmt('SELECT actor_uri FROM ap_followers WHERE slug = ?').all(slug)) uit.add(r.actor_uri);
  for (const r of stmt("SELECT actor_uri FROM ap_following WHERE slug = ? AND status = 'accepted'").all(slug)) uit.add(r.actor_uri);
  return uit;
}

/** De deur op een actor: een object met een id op dezelfde host, anders niets. */
export function doorOf(actor, friend) {
  const d = actor && actor['shaer:door'];
  if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.id !== 'string') return null;
  try { if (new URL(d.id).origin !== new URL(friend).origin) return null; } catch { return null; }
  return d.id;
}

function follow(base, slug, friend, inbox, doorId) {
  const me = actorId(base, slug);
  const keys = getOrCreateKeys(slug);
  const followId = `${me}#follow-door-${Date.now()}-${rid()}`;
  const act = { '@context': AP_CONTEXT, id: followId, type: 'Follow', actor: me, object: doorId, to: [friend] };
  deliverWithRetry(slug, inbox, act, `${me}#main-key`, keys.private_pem)
    .catch((e) => console.warn('[door-watch] Follow:', inbox, e && e.message));
  return followId;
}

function undo(base, slug, r) {
  if (!r.inbox || !r.follow_id) return;
  const me = actorId(base, slug);
  const keys = getOrCreateKeys(slug);
  const act = {
    '@context': AP_CONTEXT, id: `${r.follow_id}#undo-${Date.now()}`, type: 'Undo', actor: me, to: [r.friend_uri],
    object: { id: r.follow_id, type: 'Follow', actor: me, object: r.door_id },
  };
  deliverWithRetry(slug, r.inbox, act, `${me}#main-key`, keys.private_pem)
    .catch((e) => console.warn('[door-watch] Undo:', r.inbox, e && e.message));
}

/**
 * Eén ronde: wie uit de lucht verdween wordt opgezegd, wie erbij kwam wordt
 * bekeken. Een vriend zonder deur onthouden we een week, zodat een grote
 * lucht niet elk kwartier helemaal opgehaald wordt.
 */
export async function reconcile(base, slug, { now = Date.now() } = {}) {
  if (!isOn(slug)) return { followed: 0 };
  const lucht = sky(slug);
  const bekend = new Map(rows(slug).map((r) => [r.friend_uri, r]));
  for (const [friend, r] of bekend) {
    if (lucht.has(friend)) continue;
    if (r.status === 'pending' || r.status === 'accepted') undo(base, slug, r);
    stmt('DELETE FROM ap_door_follows WHERE slug = ? AND friend_uri = ?').run(slug, friend);
    if (r.door_id) markDoor(slug, r.door_id, friend, false);
  }
  const teBekijken = [...lucht].filter((f) => {
    const r = bekend.get(f);
    if (!r) return true;
    return (r.status === 'none' || r.status === 'rejected') && now - Date.parse(r.checked_at || 0) > OPNIEUW_NA_MS;
  }).slice(0, NIEUW_PER_RONDE);
  let gevolgd = 0;
  for (const friend of teBekijken) {
    const actor = await fetchActor(friend).catch(() => null);
    const doorId = doorOf(actor, friend);
    const inbox = actor && actor.inbox;
    const iso = new Date(now).toISOString();
    if (!doorId || !inbox) {
      stmt(`INSERT INTO ap_door_follows (slug, friend_uri, status, checked_at) VALUES (?,?,'none',?)
            ON CONFLICT (slug, friend_uri) DO UPDATE SET status = 'none', checked_at = excluded.checked_at`).run(slug, friend, iso);
      continue;
    }
    const followId = follow(base, slug, friend, inbox, doorId);
    stmt(`INSERT INTO ap_door_follows (slug, friend_uri, door_id, inbox, follow_id, status, checked_at) VALUES (?,?,?,?,?,'pending',?)
          ON CONFLICT (slug, friend_uri) DO UPDATE SET door_id = excluded.door_id, inbox = excluded.inbox,
            follow_id = excluded.follow_id, status = 'pending', checked_at = excluded.checked_at`)
      .run(slug, friend, doorId, inbox, followId, iso);
    gevolgd++;
  }
  return { followed: gevolgd };
}

/** Eén deur navragen: 200 is open, 404/410 dicht, iets anders laat de stand staan. */
export async function checkOne(slug, r) {
  try {
    const res = await safeFetch(r.door_id, { headers: { Accept: 'application/activity+json' } });
    if (res.status === 200) {
      let since = Date.now();
      try { const d = await res.json(); const c = Date.parse(d && d.proof && d.proof.created); if (c) since = c; } catch { /* geen JSON: open, sinds nu */ }
      markDoor(slug, r.door_id, r.friend_uri, true, since);
    } else if (res.status === 404 || res.status === 410) {
      markDoor(slug, r.door_id, r.friend_uri, false);
    }
  } catch { /* onbereikbaar: niets weten is niets veranderen */ }
}

/** Alle gevolgde deuren rustig navragen: na een herstart, of als de instelling aangaat. */
export async function refresh(base, slug, { pauseMs = NAVRAAG_TUSSEN_MS } = {}) {
  for (const r of rows(slug).filter((x) => x.status === 'accepted' && x.door_id)) {
    if (!isOn(slug)) return;
    await checkOne(slug, r);
    if (pauseMs) await new Promise((t) => setTimeout(t, pauseMs));
  }
}

// ── Wat er binnenkomt ────────────────────────────────────────────────

/** De rij waar dit Accept of Reject op antwoordt, of null. */
function antwoordOp(act, signer) {
  const o = act.object;
  const fid = typeof o === 'string' ? o : (o && o.id);
  const doel = o && typeof o === 'object' ? (typeof o.object === 'string' ? o.object : (o.object && o.object.id)) : null;
  if (fid) {
    const r = stmt('SELECT * FROM ap_door_follows WHERE follow_id = ? AND friend_uri = ?').get(fid, signer);
    if (r) return r;
  }
  if (doel) return stmt('SELECT * FROM ap_door_follows WHERE door_id = ? AND friend_uri = ?').get(doel, signer) || null;
  return null;
}

/**
 * Een Accept of Reject van een deurabonnement dat WIJ stuurden. Geeft true als
 * hij van ons was -- dan mag hij nooit verder naar de gewone Follow-takken,
 * want die zouden een Reject lezen als 'ontvolg deze actor'.
 */
export function handleAnswer(act, signer) {
  if (!signer || !act || !act.object) return false;
  const r = antwoordOp(act, signer);
  if (!r) return false;
  if (act.type === 'Accept') {
    stmt("UPDATE ap_door_follows SET status = 'accepted' WHERE slug = ? AND friend_uri = ?").run(r.slug, r.friend_uri);
    checkOne(r.slug, { ...r, status: 'accepted' });   // staat hij nu al open?
  } else {
    stmt("UPDATE ap_door_follows SET status = 'rejected', checked_at = ? WHERE slug = ? AND friend_uri = ?").run(new Date().toISOString(), r.slug, r.friend_uri);
    markDoor(r.slug, r.door_id, r.friend_uri, false);
  }
  return true;
}

/**
 * Een Update van een shaer:Door. Alleen geloofd als de ondertekenaar de vriend
 * is wiens deur het is, en als wij die deur van hem volgen. `shaer:open: false`
 * is dicht; zonder die vlag is het een online-melding.
 */
export function handleUpdate(act, signer) {
  const o = act && act.object;
  if (!o || typeof o !== 'object' || o.type !== 'shaer:Door' || typeof o.id !== 'string') return false;
  if (o.attributedTo !== undefined && o.attributedTo !== signer) return true;
  const isOpen = o['shaer:open'] !== false;
  for (const r of stmt("SELECT * FROM ap_door_follows WHERE door_id = ? AND friend_uri = ? AND status IN ('pending', 'accepted')").all(o.id, signer)) {
    if (r.status === 'pending') stmt("UPDATE ap_door_follows SET status = 'accepted' WHERE slug = ? AND friend_uri = ?").run(r.slug, r.friend_uri);
    markDoor(r.slug, o.id, signer, isOpen);
  }
  return true;
}

// ── De collectie ─────────────────────────────────────────────────────

export function buildCollection(base, slug) {
  const items = list(slug).map((d) => ({
    id: d.id, type: 'shaer:Door', attributedTo: d.friend, 'shaer:openSince': new Date(d.since).toISOString(),
  }));
  return {
    '@context': AP_CONTEXT,
    id: `${actorId(base, slug)}/openDoors`,
    type: 'OrderedCollection',
    'shaer:followDoors': isOn(slug),
    'shaer:cursor': cursor(slug),
    totalItems: items.length,
    orderedItems: items,
  };
}

// ── De wekker ────────────────────────────────────────────────────────

/** Na het opstarten: elke site die het aan heeft een ronde en een navraag; daarna elk kwartier een ronde. */
export function startDoorWorker() {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const aan = () => { try { return stmt('SELECT slug FROM sites WHERE follow_doors = 1').all().map((r) => r.slug); } catch { return []; } };
  const eerst = setTimeout(async () => {
    for (const slug of aan()) {
      await reconcile(base, slug).catch((e) => console.warn('[door-watch] ronde:', slug, e && e.message));
      refresh(base, slug).catch(() => { /* navraag is nooit dragend */ });
    }
  }, 30_000);
  const elk = setInterval(async () => {
    for (const slug of aan()) await reconcile(base, slug).catch((e) => console.warn('[door-watch] ronde:', slug, e && e.message));
  }, RONDE_MS);
  eerst.unref(); elk.unref();
}

export default {
  cursor, markDoor, list, waitForChange, isOn, setFollowing, sky, doorOf, reconcile, checkOne, refresh,
  handleAnswer, handleUpdate, buildCollection, startDoorWorker, _forgetAll,
  NIEUW_PER_RONDE, OPNIEUW_NA_MS, RONDE_MS,
};
