/**
 * [Add to HUB] — een klonkt zelf op de Klonkt Hub zetten (Robin, 30-9).
 *
 * WAAROM DIT MEER IS DAN EEN LINK. Aanmelden op de hub betekent: de hub
 * stuurt een Follow. Met de eigenaarspoort aan (standaard) wacht die Follow
 * dan op de eigenaar -- dezelfde persoon die net op de knop drukte. Zonder dit
 * stuk zou die dus eerst zijn klonkt aanmelden en daarna zijn eigen aanmelding
 * moeten goedkeuren op /connect.
 *
 * De klik IS de toestemming. Hij geldt kort (een dag), alleen voor een Follow
 * van de host van de hub, en alleen als die Follow is ondertekend door de hub
 * zelf. De poort blijft verder precies wat hij was: niemand anders komt er
 * zonder ja door, en bij een WARD beslissen nog steeds de guardians -- die
 * poort staat in ap-inbox VOOR deze, en daar komt dit stuk nooit langs.
 *
 * De uitnodiging wordt niet opgebruikt bij de eerste Follow maar loopt af. Een
 * hub die zijn Follow opnieuw stuurt (na een time-out) krijgt anders alsnog
 * een wachtend verzoek voor iets dat al beslist was.
 */
import db from '../config/database.js';

const GELDIG_MS = 24 * 3600 * 1000;

/** De hub waar de knop naartoe wijst. Zelfhosters kunnen een andere kiezen. */
export function hubUrl() {
  return String(process.env.KLONKT_HUB_URL || 'https://hub.klonkt.com').replace(/\/+$/, '');
}

function hubHost() {
  try { return new URL(hubUrl()).host.toLowerCase(); } catch { return ''; }
}

function hostOf(uri) {
  try { return new URL(uri).host.toLowerCase(); } catch { return ''; }
}

/** Komt dit actor-adres van de hub? */
export const isHubActor = (uri) => !!uri && hostOf(uri) === hubHost();

/** De eigenaar zegt ja, vooruit: de volgende dag mag een Follow van de hub door. */
export function invite(siteId) {
  db.prepare('UPDATE sites SET hub_invite_until = ? WHERE id = ?').run(Date.now() + GELDIG_MS, siteId);
}

/** Heeft de eigenaar van `slug` de hub uitgenodigd, en is dat nog geldig? */
export function isInvited(slug, actorUri) {
  if (!isHubActor(actorUri)) return false;
  const r = db.prepare('SELECT hub_invite_until FROM sites WHERE slug = ?').get(slug);
  return !!(r && r.hub_invite_until && r.hub_invite_until > Date.now());
}

/** Volgt de hub deze klonkt al? Dan hoort er geen knop maar een bevestiging. */
export function onHub(slug) {
  const rows = db.prepare('SELECT actor_uri FROM ap_followers WHERE slug = ?').all(slug);
  return rows.some((r) => isHubActor(r.actor_uri));
}
