/**
 * Wie er op een hulpvraag af is, en wanneer hij is afgesloten (shaer-lgo).
 *
 * Een hulpvraag (FEP-633c 5.2.1) gaat naar ALLE guardians van een kind, die op
 * verschillende servers zitten. Zonder gedeelde staat denken er twee dat de
 * ander het oppakt -- en dat is precies het scenario waar de reddingsboei voor
 * bestaat.
 *
 * DE FAALSTAND IS HIER NIET VEILIG, en dat maakt dit anders dan elke gate. Bij
 * een gate is "dicht" het veilige antwoord. Hier is de faalstand "iedereen denkt
 * dat het geregeld is", en dat is gevaarlijker dan geen markering. Daaruit volgt
 * de regel die overal in dit bestand terugkomt: bij twijfel is een hulpvraag
 * OPEN.
 *
 * Twee besluiten van Bart (7-8) zitten in de vorm:
 *
 *   OPGEPIKT mag stapelen en vervalt niet, maar VEROUDERT zichtbaar. Twee mensen
 *   die tegelijk reageren op een kind is geen probleem; twee die allebei niets
 *   doen omdat de ander het "geclaimd" had, wel. En een signaal dat vanzelf
 *   verdwijnt laat een hulpvraag er onaangeroerd uitzien terwijl er iemand mee
 *   bezig is.
 *
 *   AFGEHANDELD kent geen terugdraai. Sluiten gebeurt met een stevige
 *   bevestiging, en leeft de vraag daarna nog, dan wordt hij OPNIEUW GESTELD --
 *   een nieuwe hulpvraag. Er wordt niets herschreven, er wordt toegevoegd.
 */

import db from '../../config/database.js';

let _s = null;
function stmts() {
  if (!_s) {
    _s = {
      ins: db.prepare(`INSERT OR IGNORE INTO ap_help_state (note_uri, guardian_uri, kind, guardian_handle)
                       VALUES (?,?,?,?)`),
      forNote: db.prepare('SELECT * FROM ap_help_state WHERE note_uri = ? ORDER BY created_at ASC'),
      forNotes: db.prepare('SELECT * FROM ap_help_state WHERE note_uri IN (SELECT value FROM json_each(?))'),
    };
  }
  return _s;
}

/** Leg vast dat iemand deze hulpvraag heeft opgepikt of afgesloten. */
export function record(noteUri, guardianUri, kind, handle = null) {
  if (!noteUri || !guardianUri) return;
  const k = kind === 'handled' ? 'handled' : 'pickup';
  try { stmts().ins.run(noteUri, guardianUri, k, handle); } catch { /* nooit dragend */ }
}

/**
 * De staat van een hulpvraag, uit zijn rijen. Puur, zodat de regels te toetsen
 * zijn zonder database of scherm.
 *
 * `oldestPickupAt` is het TIJDSTIP van de oudste oppik, niet de leeftijd. Daar
 * tekent het scherm mee dat een signaal oud wordt -- niets verdwijnt, maar je
 * ziet wel dat er misschien niets meer gebeurt.
 *
 * EEN TIJDSTIP, GEEN LEEFTIJD, en dat is geen smaak. Hier stond `ageMs`, een
 * verschil met `now`, en dus veranderde dit antwoord elke milliseconde. Zodra
 * het paneel een ETag kreeg (9-8) kon die daardoor nooit meer gelijk zijn: de
 * 304 kwam nooit, de lange poll keerde meteen terug, en de browser kwam in een
 * lus van ongeveer een seconde waarin de scrollpositie werd vermalen. Een
 * levende klok in een antwoord maakt dat antwoord onvergelijkbaar met zichzelf.
 *
 * De leeftijd is een weergavedetail en wordt in de client uitgerekend.
 */
export function helpStatus(rows, now = Date.now()) {
  const list = rows || [];
  const pickups = list.filter((r) => r.kind === 'pickup');
  const done = list.find((r) => r.kind === 'handled') || null;
  const stamp = (r) => { const t = Date.parse(r.created_at); return isNaN(t) ? null : t; };
  const oudste = pickups.map(stamp).filter((t) => t !== null).sort((a, b) => a - b)[0];
  return {
    // Namen erbij: "door wie" was de hele vraag. Zonder dat is het een vinkje.
    pickedUpBy: pickups.map((r) => ({ uri: r.guardian_uri, handle: r.guardian_handle || null, at: r.created_at })),
    handled: done ? { uri: done.guardian_uri, handle: done.guardian_handle || null, at: done.created_at } : null,
    // Alleen betekenisvol zolang er niets is afgesloten.
    oldestPickupAt: (!done && oudste) ? new Date(oudste).toISOString() : null,
    // Waar het scherm op afgaat. Bij twijfel OPEN: een lege lijst, een rij die we
    // niet kunnen lezen, wat dan ook -- alles wat geen expliciete afsluiting is,
    // is een hulpvraag die nog op iemand wacht.
    open: !done,
  };
}

/**
 * Een hulpvraag van iemand die je NIET MEER bewaakt.
 *
 * Het loslaat-scherm belooft dit al letterlijk: "je krijgt geen hulpvragen meer
 * van ze". Nieuwe komen inderdaad niet meer binnen, maar wat er al lag bleef in
 * de open lijst staan -- en was niet af te sluiten, want de markeerroute eist
 * dat het nog je ward is en antwoordt anders met 403. De knop stond er dus wel
 * en deed niets.
 *
 * Zo'n vraag is niet AFGEHANDELD -- dat zou een claim zijn over een kind waar je
 * niets meer over te zeggen hebt, en die claim wordt ook nog rondgestuurd. Hij is
 * niet meer van jou. Dat is een derde uitkomst en die hoort als zodanig te lezen.
 *
 * Veilig omdat een guardianship nooit bij de LAATSTE guardian eindigt (3.4,
 * emancipatie): er blijft altijd iemand over voor wie de vraag wel open staat.
 */
export function withWardship(status, stillWard) {
  if (stillWard) return status;
  return { ...status, open: false, formerWard: true };
}

/** De staat van een hulpvraag zoals die nu is opgeslagen. */
export function statusOf(noteUri, now = Date.now()) {
  if (!noteUri) return helpStatus([], now);
  try { return helpStatus(stmts().forNote.all(noteUri), now); } catch { return helpStatus([], now); }
}

/** Idem voor een hele lijst in een query, zodat een paneel geen N+1 wordt. */
export function statusFor(noteUris, now = Date.now()) {
  const uit = new Map();
  const lijst = [...new Set((noteUris || []).filter(Boolean))];
  if (!lijst.length) return uit;
  let rijen = [];
  try { rijen = stmts().forNotes.all(JSON.stringify(lijst)); } catch { rijen = []; }
  const perNote = new Map();
  for (const r of rijen) {
    if (!perNote.has(r.note_uri)) perNote.set(r.note_uri, []);
    perNote.get(r.note_uri).push(r);
  }
  for (const uri of lijst) uit.set(uri, helpStatus(perNote.get(uri) || [], now));
  return uit;
}

/**
 * De markering als bericht. Bewust een gewone directe note met een
 * shaer:-markering, zoals de zwaai en de afwezigheidsmelding: dan reist het over
 * de bestaande bezorging, en de WARD leest het als wat het is -- er komt iemand.
 */
export function markerNote({ id, me, noteUri, kind, to }) {
  const k = kind === 'handled' ? 'handled' : 'pickup';
  return {
    id, type: 'Note', attributedTo: me, to,
    [k === 'handled' ? 'shaer:helpHandled' : 'shaer:helpPickup']: noteUri,
    content: k === 'handled'
      ? '<p>Deze hulpvraag is afgehandeld.</p>'
      : '<p>Ik kijk hiernaar.</p>',
  };
}

/** Leest een binnengekomen note als markering, of null als hij er geen is. */
export function parseMarker(object) {
  if (!object || typeof object !== 'object') return null;
  const pickup = object['shaer:helpPickup'];
  const handled = object['shaer:helpHandled'];
  if (typeof handled === 'string' && handled) return { kind: 'handled', noteUri: handled };
  if (typeof pickup === 'string' && pickup) return { kind: 'pickup', noteUri: pickup };
  return null;
}

export default { record, helpStatus, withWardship, statusOf, statusFor, markerNote, parseMarker };
