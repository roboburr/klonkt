/**
 * ap-following.js — de volgwinkel (stap 7 van shaer-drc).
 *
 * Alles rond ap_following: WebFinger, de statements, de lijst en de
 * auto-boost-knop, en de drie federatiehandelingen (followActor,
 * resolveRemoteActor, unfollowActor).
 *
 * fwStmts exporteert mee: de Accept-tak van de inbox en de verhuizing
 * (FEP-7628) schrijven de winkel bij en blijven in de dienst wonen -- zelfde
 * verhouding als tlStmts bij ap-timeline. De poortwachter (gateOutgoingFollow)
 * en zijn goedkeuring (performApprovedFollow) blijven daar ook: de eerste komt
 * hier via injectie binnen, de tweede roept followActor gewoon via de dienst
 * aan, en zo is er geen kring.
 */
import db from '../config/database.js';
import * as Guardianship from './guardianship/index.js';
import { safeUrl, actorId, AP_CONTEXT } from './ap-core.js';
import { safeFetch, signedGetJson, fetchActor, getOrCreateKeys, deliverWithRetry } from './ap-transport.js';

// De werktuigen uit de dienstlaag; ActivityPubService vult ze onderaan.
let movedRefusal, gateOutgoingFollow, actorInfo, rid, backfillFromOutbox,
  deliverToActor;
export function wireFollowing(deps) {
  ({ movedRefusal, gateOutgoingFollow, actorInfo, rid, backfillFromOutbox,
    deliverToActor } = deps);
}

// ── Fediverse CLIENT: follow accounts + home timeline ─────────────
// Resolve an @user@domain handle to its actor URL via WebFinger.
export async function webfingerResolve(handle) {
  const h = String(handle || '').trim().replace(/^@/, '');
  const parts = h.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const acct = `${parts[0]}@${parts[1]}`;
  try {
    const r = await safeFetch(`https://${parts[1]}/.well-known/webfinger?resource=acct:${encodeURIComponent(acct)}`,
      { headers: { Accept: 'application/jrd+json, application/json' } });
    if (!r.ok) return null;
    const jrd = await r.json();
    const link = (jrd.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/.test(l.type || ''));
    return safeUrl(link ? link.href : '') || null;
  } catch { return null; }
}

let _insFw, _delFw, _listFw, _accFw, _accFwByActor, _oneFw, _setAB;
export function fwStmts() {
  if (!_insFw) {
    _insFw = db.prepare('INSERT OR REPLACE INTO ap_following (slug, actor_uri, handle, name, icon, url, inbox, follow_id, status, auto_boost, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delFw = db.prepare('DELETE FROM ap_following WHERE slug = ? AND actor_uri = ?');
    _listFw = db.prepare('SELECT * FROM ap_following WHERE slug = ? ORDER BY created_at DESC');
    _accFw = db.prepare("UPDATE ap_following SET status = 'accepted' WHERE follow_id = ?");
    // Terugval als de Accept ons follow-id niet teruggeeft (zie de Accept-tak
    // in handleInbox): dan is het paar dat we WEL zeker weten (deze site, deze
    // actor) genoeg, mits de rij nog op pending staat.
    _accFwByActor = db.prepare("UPDATE ap_following SET status = 'accepted' WHERE slug = ? AND actor_uri = ? AND status = 'pending'");
    _oneFw = db.prepare('SELECT * FROM ap_following WHERE slug = ? AND actor_uri = ?');
    _setAB = db.prepare('UPDATE ap_following SET auto_boost = ? WHERE slug = ? AND actor_uri = ?');
  }
  return { ins: _insFw, del: _delFw, list: _listFw, acc: _accFw, accByActor: _accFwByActor, one: _oneFw, setAB: _setAB };
}
export function listFollowing(slug) { return fwStmts().list.all(slug); }

// Toggle auto-boost ("feature") on an account we already follow.
export function setAutoBoost(slug, actorUri, on) {
  try { fwStmts().setAB.run(on ? 1 : 0, slug, actorUri); } catch { /* ignore */ }
  // Featuring an account → AP-native catch-up so the Cirkel isn't empty until they next
  // post (push doesn't backfill history-before-follow). Fire-and-forget pull, sends nothing.
  if (on) backfillFromOutbox(slug, actorUri).catch(() => {});
  return { ok: true };
}

// Resolve a Klonkt/AP actor URL from a site root: a Klonkt site's root 302s to
// /ap/users/<slug> (content negotiation; Location may be relative). Used by
// followActor for bare-domain follows.
// NB: the old auto-migration of legacy Cirkels (circle_links -> AP follows) was
// REMOVED on 2026-06-26 — it auto-sent Follows on boot, which violates "the code
// never throws anything into the fediverse automatically" (would surprise-Follow
// for some operators at scale). The dead circle_links table stays as harmless dead
// data; an operator restores an old cirkel by re-following in /following (their click).
async function resolveApActor(siteUrl) {
  try {
    const r = await fetch(siteUrl, { headers: { Accept: 'application/activity+json' }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (loc) return new URL(loc, siteUrl).href; }
    if (r.ok) return siteUrl;
  } catch { /* unreachable */ }
  return null;
}

export async function followActor(site, handle, autoBoost = false, { approved = false } = {}) {
  const _mv = movedRefusal(site, 'follow'); if (_mv) return _mv;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  // DE POORT STAAT HIER, en niet alleen in de C2S-outbox (shaer-p729, Barts
  // melding 8-8: de volgverzoeken van Esmee kwamen nooit bij haar guardians
  // aan). Hij stond in `case 'Follow'` van de outbox -- dus alleen als je via
  // Shaer volgt. Volgde het kind vanuit Klonkts eigen webinterface, dan werd er
  // geen verzoek aangemaakt, ging er niets naar de guardians, en was er dus ook
  // niets om te beantwoorden. Precies dezelfde deur-naast-de-poort als bij de
  // antwoordpoort vanmiddag (shaer-r4c).
  //
  // Merk op wat het NIET was: niet dat een guardian elders het niet kon
  // beantwoorden. Die weg werkt en levert een Offer af bij de externe guardian.
  // Er kwam alleen nooit iets aan om af te leveren.
  //
  // `approved` is de enige doorlaat, voor performApprovedFollow: zonder dat zou
  // een goedgekeurd verzoek opnieuw op de poort stuiten en voor eeuwig wachten.

  // Accept any of: a profile/actor URL, an @user@host handle (WebFinger), or a
  // bare site domain (site.com) — for a single-actor site (Klonkt etc.) the root
  // resolves to its AP actor, so you can follow a site by just its domain.
  const s = String(handle || '').trim();
  let actorUrl;
  if (/^https?:\/\//i.test(s)) actorUrl = safeUrl(s) || null;
  else if (s.includes('@')) actorUrl = await webfingerResolve(s);
  else if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) actorUrl = await resolveApActor('https://' + s.replace(/^\/+|\/+$/g, ''));
  else actorUrl = null;
  if (!actorUrl) return { error: 'not_found' };
  // NA het oplossen, want een kind volgt net zo goed met @naam@server of een
  // kaal domein. Zou de poort alleen naar de ruwe invoer kijken, dan is elke
  // handle een sluiproute -- en dat is precies de fout die we hier repareren,
  // een maat kleiner.
  if (!approved) {
    const held = await gateOutgoingFollow(site, actorUrl);
    if (held) return { held: true, id: held.id, status: held.status || 'pending' };
  }
  // SIGNED, as this actor: an authorized-fetch instance refuses an anonymous
  // GET of the actor doc, which made following from a boost silently fail
  // (Robins melding, 31-7). Signed, the other side sees who asks.
  const actor = await signedGetJson(site.slug, actorUrl);
  if (!actor || !actor.id || !actor.inbox) return { error: 'unreachable' };
  const ai = actorInfo(actor, actor.id);
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const followId = `${me}#follow-${Date.now()}-${rid()}`;
  fwStmts().ins.run(site.slug, actor.id, ai.handle, ai.name, ai.icon, ai.url, actor.inbox, followId, 'pending', autoBoost ? 1 : 0);
  const follow = { '@context': AP_CONTEXT, id: followId, type: 'Follow', actor: me, object: actor.id };
  // Deliver via the retry queue: a Follow that fails the first attempt (peer down,
  // timeout, transient 5xx) is retried with backoff instead of staying stuck on
  // 'pending' forever — the Accept can only come back once the Follow lands.
  await deliverWithRetry(site.slug, actor.inbox, follow, `${me}#main-key`, keys.private_pem);
  console.log('[AP] follow', site.slug, '→', actor.id);
  // Follow + feature in one step → backfill their recent posts into the Cirkel right away.
  if (autoBoost) backfillFromOutbox(site.slug, actor.id).catch(() => {});
  // A ward's guardians are TOLD about a new follow (Robins verzoek, 31-7):
  // a follow brings new content into the child's feed, and the village
  // should know the door opened. A direct note per guardian, best-effort;
  // FEP-633c 5.3 gates inbound follows, the outbound notice is Shaer policy
  // for now (bead: spec-vraag).
  try {
    const guardians = Guardianship.listGuardians(site.slug);
    if (guardians.length) {
      const meRef = actorId(base, site.slug);
      const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      const label = esc(ai.name || ai.handle || actor.id);
      for (const g of guardians) {
        const note = {
          id: `${meRef}/follow-notice/${Date.now().toString(36)}${rid()}`,
          type: 'Note', attributedTo: meRef, to: [g.other_uri],
          tag: [{ type: 'Mention', href: g.other_uri }],
          content: `<p>👀 ${esc(site.title || site.slug)} is now following ${label}.</p>`,
        };
        deliverToActor(site, g.other_uri, { id: `${note.id}#create`, type: 'Create', actor: meRef, to: [g.other_uri], object: note })
          .catch(() => { /* retried by the queue */ });
      }
      console.log('[AP] follow notice →', guardians.length, 'guardian(s) of', site.slug);
    }
  } catch { /* geen guardians is geen fout */ }
  return { ok: true, name: ai.name, handle: ai.handle, actor: actor.id };
}

// Resolve a profile URL or @handle to a followable remote actor (for the
// authorize_interaction "Follow" flow). Returns display fields + inbox, or null
// when it isn't a reachable actor (e.g. the input was a post, not a profile).
export async function resolveRemoteActor(input) {
  const s = String(input || '').trim();
  const actorUrl = /^https?:\/\//i.test(s) ? (safeUrl(s) || null) : await webfingerResolve(s);
  if (!actorUrl) return null;
  const actor = await fetchActor(actorUrl).catch(() => null);
  if (!actor || !actor.id || !actor.inbox) return null;
  const ai = actorInfo(actor, actor.id);
  return { actor_uri: actor.id, actor_name: ai.name, actor_handle: ai.handle, actor_url: ai.url, actor_icon: ai.icon, inbox: actor.inbox };
}

export async function unfollowActor(site, actorUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const row = fwStmts().one.get(site.slug, actorUri);
  // Undo(Follow) MUST reference the original Follow's real id so the remote can correlate it
  // and drop the follow. The old `${me}#follow` fallback never matched anything → the unfollow
  // silently failed on the remote. With no stored follow id (legacy row), skip the network Undo
  // rather than send an unmatchable one. Deliver durably via the retry queue.
  if (row && row.inbox && row.follow_id) {
    const undo = { '@context': AP_CONTEXT, id: `${me}/undo/${Date.now()}-${rid()}`, type: 'Undo', actor: me, object: { id: row.follow_id, type: 'Follow', actor: me, object: actorUri } };
    deliverWithRetry(site.slug, row.inbox, undo, `${me}#main-key`, keys.private_pem);
  } else if (row && row.inbox) {
    console.warn('[AP] unfollow', site.slug, '→', actorUri, '— no stored follow id; removed locally only (legacy follow, remote may keep it)');
  }
  fwStmts().del.run(site.slug, actorUri);
  return { ok: true };
}
