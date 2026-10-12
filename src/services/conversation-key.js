/**
 * Zachte groepen (shaer-mbji): een gesprek is de SET deelnemers, niet één
 * tegenpartij.
 *
 * Een direct bericht aan Anna en Ben bestond al als groep op de draad --
 * ap_outbox.to_actors droeg de hele set -- maar elke lezing hier sleutelde op
 * één `other`. Een uitgaand bericht aan twee mensen viel daardoor in twee
 * gesprekken uiteen, en een binnenkomend bericht van Anna aan jou en Ben kwam
 * alleen bij Anna terecht: Ben viel eruit. Een gesprek met drie mensen bestond
 * zo alleen als losse één-op-één-bubbels die elk een deel ervan droegen.
 *
 * DE SLEUTEL:
 *
 *   één ander   -> zijn actor-URI, kaal. Precies wat het altijd was, dus elk
 *                  bestaand gesprek, elke leesmarkering en elke ?with=-URL
 *                  blijft geldig. Niets te migreren.
 *   meer        -> de URI's gesorteerd, gescheiden door één spatie. Een URI kan
 *                  geen ongecodeerde spatie bevatten, dus de scheiding is
 *                  ondubbelzinnig, en sorteren maakt {Anna, Ben} en {Ben, Anna}
 *                  hetzelfde gesprek.
 *
 * Ikzelf zit nooit in de sleutel: ik ben in elk gesprek, dus mij noemen zegt
 * niets en zou dezelfde groep twee sleutels geven, afhankelijk van wie hem
 * begon.
 *
 * ZACHT BETEKENT: WIE GEADRESSEERD IS, ZIT ERIN. Geen aanmaakstap, geen
 * eigenaar. Komt Carla er halverwege bij, dan is {Anna, Ben, Carla} een ander
 * gesprek dan {Anna, Ben} -- en dat klopt, want een antwoord daar bereikt
 * Carla en een antwoord in de oude bubbel niet. `context` (FEP-7888) reist mee
 * en wordt bewaard, maar voegt hier geen bubbels samen: een bubbel die Carla
 * toont terwijl je antwoord haar niet bereikt, zou liegen over wie meeleest.
 *
 * Puur, zonder afhankelijkheden: de inbox, de bezorging en de lezing gebruiken
 * allemaal dezelfde sleutel, en dat kan alleen als hij op één plek staat.
 */

const PUBLIC = new Set([
  'https://www.w3.org/ns/activitystreams#Public',
  'as:Public',
  'Public',
]);

/** Is dit een persoon, en niet een publiek of een volgerslijst? */
export function isPersonalAddress(uri) {
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) return false;
  if (PUBLIC.has(uri)) return false;
  return !/\/followers\/?$/.test(uri);
}

const lijst = (v) => (Array.isArray(v) ? v : (v ? [v] : []))
  .map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' ? x.id : null)))
  .filter((x) => typeof x === 'string');

/**
 * De andere deelnemers van een binnenkomende note: de afzender plus iedere
 * persoon in to/cc, zonder mij. Gesorteerd en ontdubbeld.
 */
export function participantsOf(note, author, me) {
  const set = new Set();
  if (isPersonalAddress(author)) set.add(author);
  for (const u of [...lijst(note && note.to), ...lijst(note && note.cc)]) {
    if (isPersonalAddress(u)) set.add(u);
  }
  set.delete(me);
  return [...set].sort();
}

/** De gesprekssleutel van een set andere deelnemers. */
export function conversationKey(others) {
  const set = [...new Set((others || []).filter(isPersonalAddress))].sort();
  return set.join(' ');
}

/** De deelnemers achter een sleutel. Een kale URI is een gesprek met één. */
export function participantsOfKey(key) {
  return String(key || '').split(' ').filter(isPersonalAddress);
}

/** Een groep: meer dan één ander. */
export function isGroupKey(key) {
  return participantsOfKey(key).length > 1;
}

/** De context van een note (FEP-7888): een string of een object met een id. */
export function contextOf(note) {
  const c = note && note.context;
  const id = typeof c === 'string' ? c : (c && typeof c === 'object' ? c.id : null);
  return typeof id === 'string' && /^https?:\/\//i.test(id) ? id : null;
}
