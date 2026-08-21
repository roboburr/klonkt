/**
 * Luisteraars: wie de BIBLIOTHEEK volgt (shaer-0nh).
 *
 * Een aparte soort volger. Ze hangen aan `/ap/users/<slug>/library` en niet aan
 * de actor, en dat verschil is de hele bedoeling: een luisteraar krijgt de
 * muziek en NIET de gewone posts. Iemand die zich abonneert op een
 * platenkast heeft niet gevraagd om de Krant.
 *
 * WAAROM EEN EIGEN TABEL EN GEEN VLAG op ap_followers: zolang ze ergens anders
 * staan kan een bezorging ze niet per ongeluk meenemen. Een vlag die iemand
 * vergeet te filteren doet dat wel, en dan is de fout stil -- de posts komen
 * gewoon aan bij mensen die er niet om vroegen, en niemand ziet het aan onze
 * kant. Dit is dezelfde afweging als bij de wachtrijen: de vorm moet de fout
 * onmogelijk maken, niet alleen onwaarschijnlijk.
 */
import db from '../../config/database.js';

const stmt = (sql) => db.prepare(sql);

/** Erbij, of bijwerken als hij er al was. Volgen is idempotent. */
export function voegToe(slug, { actorUri, inbox, sharedInbox, name, handle, icon }) {
  if (!slug || !actorUri) return false;
  try {
    stmt(`INSERT INTO ap_library_followers (slug, actor_uri, inbox, shared_inbox, name, handle, icon)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT (slug, actor_uri) DO UPDATE SET
            inbox = excluded.inbox, shared_inbox = excluded.shared_inbox,
            name = excluded.name, handle = excluded.handle, icon = excluded.icon`)
      .run(slug, actorUri, inbox || null, sharedInbox || null, name || null, handle || null, icon || null);
    return true;
  } catch { return false; }
}

/** Weg. Een Undo(Follow) hoort meteen te werken, niet pas na een opruiming. */
export function verwijder(slug, actorUri) {
  try { return stmt('DELETE FROM ap_library_followers WHERE slug = ? AND actor_uri = ?').run(slug, actorUri).changes > 0; }
  catch { return false; }
}

/** Voor het beheerscherm. */
export function lijst(slug) {
  try {
    return stmt(`SELECT actor_uri, inbox, shared_inbox, name, handle, icon, created_at, last_delivery_at, last_error_at
                 FROM ap_library_followers WHERE slug = ? ORDER BY created_at DESC`).all(slug);
  } catch { return []; }
}

export function telling(slug) {
  try { return stmt('SELECT COUNT(*) n FROM ap_library_followers WHERE slug = ?').get(slug).n; }
  catch { return 0; }
}

/** Volgt deze actor onze bibliotheek al? */
export function isLuisteraar(slug, actorUri) {
  try { return !!stmt('SELECT 1 FROM ap_library_followers WHERE slug = ? AND actor_uri = ?').get(slug, actorUri); }
  catch { return false; }
}

/**
 * De inboxen om muziek naartoe te sturen, ontdubbeld op gedeelde inbox.
 * Nog niemand gebruikt dit -- de bezorging is de volgende stap -- maar het hoort
 * bij de opslag en niet bij de aanroeper.
 */
export function inboxen(slug) {
  const uit = new Map();
  for (const r of lijst(slug)) {
    const adres = r.shared_inbox || r.inbox;
    if (adres && !uit.has(adres)) uit.set(adres, r.actor_uri);
  }
  return [...uit.keys()];
}

export default { voegToe, verwijder, lijst, telling, isLuisteraar, inboxen };
