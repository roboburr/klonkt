/**
 * De deur van Playtime (shaer-ivi4): waar een toestel bereikbaar is zolang de
 * eigenaar "Open to BETA" staat.
 *
 * Barts besluiten van 15-11-2026, en waarom de code zo is:
 *
 * - ALLEEN IN HET GEHEUGEN. Geen tabel, geen back-up, niet in de verhuiszip.
 *   Een IPv6-adres en een poort horen nergens te blijven liggen. De prijs: een
 *   herstart sluit elke deur. Playtime zet hem dan opnieuw (hij ziet een 404 op
 *   zijn eigen deur), en dat telt als online komen.
 * - EEN URL, en op de actor altijd een OBJECT, nooit een kale IRI:
 *   `shaer:door: { id: <actor>/door, type: shaer:Door }`. Dat staat er altijd en
 *   verandert nooit, dus de actor hoeft voor de deur nooit een Update. Er staat
 *   geen adres, poort of sleutel in: wie de deur wil, haalt hem vers op.
 * - ONLINE KOMEN stuurt een Update naar wie op de deur GEABONNEERD is (een
 *   Follow met de deur als object), niet naar de volgers van de actor. Een
 *   vervanging terwijl hij open staat stuurt niets: Playtime vervangt hem bij
 *   elke netwerkwissel en elke nieuwe sessiesleutel, soms vaker dan eens per
 *   kwartier. SLUITEN stuurt er ook een, met `shaer:open: false`, zodat de
 *   lijst van open deuren bij de abonnees vers blijft (shaer-3dwr). Een
 *   herstart sluit stil; die vangt hun navraag op.
 *
 * Klonkt ondertekent niets. Hij controleert dat de deur zichzelf noemt, dat de
 * FEP-8b32-handtekening klopt en dat die sleutel via FEP-c390 aan deze actor
 * hangt -- en serveert dan wat hij kreeg.
 */
import db from '../config/database.js';
import { AP_CONTEXT, actorId } from './ap-core.js';
import { deliverWithRetry, getOrCreateKeys } from './ap-transport.js';
import { publicKeyFromDidKey, verifyEddsaJcs2022 } from './IdentityProof.js';

/** Een deur is een adres en een sleutel, geen document. */
export const MAX_DOOR_BYTES = 8192;
/** Genoeg voor een netwerkwissel per minuut; een lus die doorslaat niet. */
export const DOOR_WRITES_PER_HOUR = 60;

export const doorUrl = (base, slug) => `${actorId(base, slug)}/door`;
/** Wat er op de actor staat: altijd, en altijd hetzelfde. */
export const doorStub = (base, slug) => ({ id: doorUrl(base, slug), type: 'shaer:Door' });

// ── In het geheugen ──────────────────────────────────────────────────

const open = new Map();      // slug -> { body, openedAt }
const schrijven = new Map(); // slug -> [tijdstippen van PUT/DELETE, laatste uur]

/** De open deur van deze site, of null. */
export function get(slug) { return open.get(slug) || null; }

/**
 * Zetten of vervangen. Geeft `{ cameOnline }`: true als hij dicht was. Dat is
 * het enige moment waarop de abonnees iets horen.
 */
export function set(slug, body) {
  const was = open.has(slug);
  open.set(slug, { body, openedAt: was ? open.get(slug).openedAt : Date.now() });
  return { cameOnline: !was };
}

/** Dicht. Geeft true als hij open stond. */
export function close(slug) { return open.delete(slug); }

/** Mag deze site nu schrijven? Telt de poging meteen mee. */
export function allowWrite(slug, now = Date.now()) {
  const uur = now - 3600_000;
  const recent = (schrijven.get(slug) || []).filter((t) => t > uur);
  if (recent.length >= DOOR_WRITES_PER_HOUR) {
    schrijven.set(slug, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + 3600_000 - now) / 1000)) };
  }
  recent.push(now);
  schrijven.set(slug, recent);
  return { ok: true };
}

/** Voor de toetsen: alles dicht, alsof Klonkt herstartte. */
export function _forgetAll() { open.clear(); schrijven.clear(); }

// ── De controle ──────────────────────────────────────────────────────

/** De did:key achter een verificationMethod, met of zonder #-fragment. */
function didOf(vm) {
  const s = String(vm || '');
  const did = s.split('#')[0];
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(did)) return null;
  return did;
}

/** De did:keys die deze actor via FEP-c390 als de zijne noemt. */
export function linkedKeys(site) {
  try {
    const lijst = JSON.parse(site.identity_proofs || '[]');
    return Array.isArray(lijst) ? lijst.map((b) => b && b.subject).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * Is dit een deur die we voor deze actor mogen serveren? `{ ok: true }` of
 * `{ ok: false, error }`, en elke weigering zegt welke regel het was.
 */
export function checkDoor(doc, { url, actor, keys }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'not_an_object' };
  let grootte = 0;
  try { grootte = Buffer.byteLength(JSON.stringify(doc), 'utf8'); } catch { return { ok: false, error: 'not_json' }; }
  if (grootte > MAX_DOOR_BYTES) return { ok: false, error: 'too_large' };
  // De deur noemt zichzelf: wie hem ophaalt kan zien dat hij is wat hij vroeg,
  // ook als een cache of een andere server hem doorgeeft.
  if (doc.id !== url) return { ok: false, error: 'id_is_not_this_door' };
  if (doc.attributedTo !== undefined && doc.attributedTo !== actor) return { ok: false, error: 'attributedTo_is_not_this_actor' };
  const proof = doc.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, error: 'no_proof' };
  if (proof.proofPurpose !== 'assertionMethod') return { ok: false, error: 'wrong_proofPurpose' };
  const did = didOf(proof.verificationMethod);
  const raw = did && publicKeyFromDidKey(did);
  if (!raw) return { ok: false, error: 'verificationMethod_is_not_an_ed25519_did_key' };
  // De sleutel moet van deze actor zijn (FEP-c390). Anders kan iedereen met
  // een token een deur zetten die geen lezer ooit kan narekenen.
  if (!keys.includes(did)) return { ok: false, error: 'key_not_linked_to_actor' };
  if (!verifyEddsaJcs2022(doc, raw)) return { ok: false, error: 'bad_signature' };
  return { ok: true };
}

// ── Abonnees ─────────────────────────────────────────────────────────
//
// Een eigen tabel, zoals de luisteraars van de bibliotheek: wie op de deur
// geabonneerd is krijgt de posts niet, en wie de actor volgt krijgt de deur
// niet. Alleen actor en inbox, nooit iets van de deur zelf.

const stmt = (sql) => db.prepare(sql);

export function subscribe(slug, { actorUri, inbox, sharedInbox }) {
  if (!slug || !actorUri) return false;
  try {
    stmt(`INSERT INTO ap_door_subscribers (slug, actor_uri, inbox, shared_inbox) VALUES (?,?,?,?)
          ON CONFLICT (slug, actor_uri) DO UPDATE SET inbox = excluded.inbox, shared_inbox = excluded.shared_inbox`)
      .run(slug, actorUri, inbox || null, sharedInbox || null);
    return true;
  } catch { return false; }
}

export function unsubscribe(slug, actorUri) {
  try { return stmt('DELETE FROM ap_door_subscribers WHERE slug = ? AND actor_uri = ?').run(slug, actorUri).changes > 0; }
  catch { return false; }
}

export function subscribers(slug) {
  try { return stmt('SELECT actor_uri, inbox, shared_inbox FROM ap_door_subscribers WHERE slug = ? ORDER BY created_at').all(slug); }
  catch { return []; }
}

/**
 * Hoort deze actor bij de lucht van de eigenaar: volgt hij ons, of volgen wij
 * hem? Alleen die mogen zich abonneren; Playtime controleert aan de deur toch
 * tegen dezelfde lucht, en zo stuurt een opening geen post naar vreemden.
 */
export function inSky(slug, actorUri) {
  try {
    if (stmt('SELECT 1 FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(slug, actorUri)) return true;
    return !!stmt("SELECT 1 FROM ap_following WHERE slug = ? AND actor_uri = ? AND status = 'accepted'").get(slug, actorUri);
  } catch { return false; }
}

/**
 * De deur kwam online, of ging dicht: zeg het tegen de abonnees. De Update
 * draagt alleen het stompje (id, type, en of hij open is), niet de deur: zo
 * bewaart geen andere server ooit het adres, en wie wil bellen haalt hem vers.
 */
export function announce(base, slug, isOpen) {
  const lijst = subscribers(slug);
  if (!lijst.length) return 0;
  const me = actorId(base, slug);
  const keys = getOrCreateKeys(slug);
  const update = {
    '@context': AP_CONTEXT,
    id: `${doorUrl(base, slug)}#${isOpen ? 'online' : 'closed'}-${Date.now()}`,
    type: 'Update',
    actor: me,
    to: lijst.map((r) => r.actor_uri),
    object: { ...doorStub(base, slug), attributedTo: me, 'shaer:open': !!isOpen },
  };
  const inboxen = [...new Set(lijst.map((r) => r.shared_inbox || r.inbox).filter(Boolean))];
  for (const inbox of inboxen) {
    deliverWithRetry(slug, inbox, update, `${me}#main-key`, keys.private_pem)
      .catch((e) => console.warn('[door] Update:', inbox, e && e.message));
  }
  return inboxen.length;
}

export default {
  MAX_DOOR_BYTES, DOOR_WRITES_PER_HOUR, doorUrl, doorStub, get, set, close, allowWrite,
  linkedKeys, checkDoor, subscribe, unsubscribe, subscribers, inSky, announce, _forgetAll,
};
