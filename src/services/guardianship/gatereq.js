/**
 * Een kind dat zelf om een poort vraagt (shaer-8ru, Barts opdracht 8-8).
 *
 * Tot nu toe liep alles over de guardians: zij zien de catalogus, zij stellen
 * voor, zij tellen. Het kind liep tegen een dichte deur en had geen woorden.
 * Dit is die woorden -- niet meer dan dat.
 *
 * EEN VRAAG IS GEEN STEM, en dat is de hele grens. De ward stelt niet voor en
 * stemt niet mee; het verzoek landt bij zijn guardians als iets om over te
 * beslissen, en pas als EEN GUARDIAN het oppakt wordt het een voorstel dat
 * langs de gewone tally gaat. Zou een verzoek zelf een voorstel zijn, dan kon
 * een kind zijn eigen poort openen door hard genoeg te vragen.
 *
 * NIET DE REDDINGSBOEI, en dat verschil moet scherp blijven. Een hulpvraag is
 * een noodgeval en gaat door elke dichte deur heen. Dit is een wens. Ze door
 * elkaar laten lopen zou de boei devalueren tot "het kind wil iets", en dan
 * kijkt er op een dag niemand meer op als hij afgaat.
 *
 * GEEN VRIJE TEKST. Een verzoek draagt alleen de naam van de feature. Dat is
 * niet gierig maar precies de reden dat hij langs de messages-poort MAG: een
 * kind met berichten dicht kan nog steeds om iets vragen, zonder dat daarmee
 * een kanaal ontstaat om omheen die poort te praten. Wil het kind uitleggen
 * waarom, dan is dat een gesprek, en gesprekken hebben hun eigen poort.
 */

import db from '../../config/database.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      ins: db.prepare(`INSERT OR IGNORE INTO ap_gate_requests (slug, ward_uri, feature, note_uri)
                       VALUES (?,?,?,?)`),
      bySlug: db.prepare(`SELECT * FROM ap_gate_requests WHERE slug = ? AND handled_at IS NULL
                          ORDER BY created_at DESC`),
      handle: db.prepare(`UPDATE ap_gate_requests SET handled_at = CURRENT_TIMESTAMP
                          WHERE slug = ? AND ward_uri = ? AND feature = ? AND handled_at IS NULL`),
    };
  }
  return _s;
}

/** Leg vast dat dit kind om deze poort vroeg. Nooit dragend: een verzoek dat
 *  niet opgeslagen kan worden mag geen inkomend bericht laten stranden. */
export function record(slug, wardUri, feature, noteUri = null) {
  if (!slug || !wardUri || !feature) return;
  try { stmts().ins.run(slug, wardUri, feature, noteUri); } catch { /* nooit dragend */ }
}

/** De openstaande verzoeken van de kinderen van deze guardian. */
export function listOpen(slug) {
  try { return stmts().bySlug.all(slug); } catch { return []; }
}

/**
 * Afgehandeld: er is een voorstel van gemaakt, of een guardian legde hem weg.
 *
 * Verdwijnt niet uit de tabel. Er wordt niets herschreven, er wordt toegevoegd
 * -- zelfde regel als bij de hulpvraag, en om dezelfde reden: wat een kind
 * gevraagd heeft hoort terug te vinden te zijn, ook als het antwoord nee was.
 */
export function markHandled(slug, wardUri, feature) {
  try { stmts().handle.run(slug, wardUri, feature); } catch { /* nooit dragend */ }
}

/**
 * Hoeveel verzoeken er per feature openstaan voor dit kind, voor de
 * waiting-kolom van het paneel. Zo staat de vraag bij de poort waar hij over
 * gaat, en niet in een aparte lijst die je apart moet openen.
 */
export function waitingFor(slug, wardUri) {
  const uit = {};
  for (const r of listOpen(slug)) {
    if (r.ward_uri !== wardUri) continue;
    uit[r.feature] = (uit[r.feature] || 0) + 1;
  }
  return uit;
}

/** Het verzoek als bericht. Bewust dezelfde vorm als de zwaai en de
 *  hulpmarkering: een gewone directe note met een shaer:-markering, zodat hij
 *  over de bestaande bezorging reist en niet over een eigen kanaal. */
export function requestNote({ id, me, feature, to }) {
  return {
    id, type: 'Note', attributedTo: me, to,
    'shaer:gateRequest': feature,
    // Vaste tekst, geen invoer van het kind: zie de kop over vrije tekst.
    content: '<p>Mag dit aan?</p>',
  };
}

/** Leest een binnengekomen note als poortverzoek, of null als hij er geen is. */
export function parseRequest(object) {
  if (!object || typeof object !== 'object') return null;
  const f = object['shaer:gateRequest'] || object.gateRequest;
  return (typeof f === 'string' && f) ? { feature: f } : null;
}

export default { record, listOpen, markHandled, waitingFor, requestNote, parseRequest };
