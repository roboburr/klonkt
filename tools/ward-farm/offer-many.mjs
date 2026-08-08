/**
 * Deze Klonkt biedt zich aan als guardian bij een reeks wards (FEP-633c 3.1).
 *
 * Bedoeld voor de caseload-test: honderd kinderen, een guardian. Draait tegen de
 * database van de instance zelf, zoals de andere scripts hier -- geen OAuth, geen
 * tweede weg. Wat het doet is precies wat de PWA-knop doet, honderd keer.
 *
 *   DATABASE_PATH=... PUBLIC_BASE_URL=... node offer-many.mjs \
 *     --slug dev --base https://wards.klonkt.com --from 1 --to 100
 *
 * ECHTE FEDERATIE, geen kortsluiting: de wards wonen op een andere origin, dus
 * elk aanbod gaat over de lijn en wordt daar ondertekend beantwoord. Dat is het
 * hele punt -- een test die de co-locatieroute neemt meet iets anders dan wat er
 * in productie gebeurt.
 *
 * VEILIG OM OPNIEUW TE DRAAIEN: een ward die al gecommit is wordt overgeslagen,
 * en een aanbod dat al openstaat wordt niet nog eens gestuurd. Zonder dat maakt
 * een tweede run honderd dubbele aanbiedingen bij mensen die al ja zeiden.
 */

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true]),
);

const slug = args.slug || 'dev';
const farmBase = (args.base || 'http://[::1]:3060').replace(/\/+$/, '');
const van = Number(args.from || 1);
const tot = Number(args.to || 100);
const pauze = Number(args.pauze || 150);

const AP = await import('../../src/services/ActivityPubService.js');
const Guardianship = await import('../../src/services/guardianship/index.js');
const dbMod = await import('../../src/config/database.js');
const db = dbMod.default;

const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
if (!site) { console.error(`geen site met slug "${slug}"`); process.exit(1); }

const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const me = AP.actorId(base, site.slug);
console.log(`[offer] ${me} biedt zich aan bij w${String(van).padStart(3, '0')}..w${String(tot).padStart(3, '0')} op ${farmBase}`);

const alBekend = new Set(Guardianship.listWards(site.slug).map((w) => w.other_uri));
let gestuurd = 0, overgeslagen = 0, mislukt = 0;

for (let i = van; i <= tot; i++) {
  const naam = `w${String(i).padStart(3, '0')}`;
  const ward = `${farmBase}/u/${naam}`;
  if (alBekend.has(ward)) { overgeslagen++; continue; }

  // Precies de vorm die handleOutbox verwacht: een Offer van een
  // Relationship{subject: ward, object: ik}. Door hem via de outbox te sturen
  // loopt dit langs dezelfde code als de knop in de PWA -- er is geen tweede pad
  // naar hetzelfde besluit, en dat is de les van vandaag.
  const activity = {
    type: 'Offer',
    to: [ward],
    object: {
      type: 'Relationship',
      subject: ward,
      object: me,
      // De exacte waarde die isGuardianRelationship accepteert. Mijn eerste
      // poging gebruikte een verzonnen URI en werd stil geweigerd.
      relationship: 'shaer:Guardian',
    },
  };

  try {
    const uit = await AP.ingestOutboxActivity(site, { id: site.owner_id, username: slug }, activity);
    if (uit && (uit.status === 201 || uit.status === 200)) gestuurd++;
    else { mislukt++; console.warn(`  ${naam}: ${uit && uit.status} ${uit && uit.error}`); }
  } catch (e) {
    mislukt++;
    console.warn(`  ${naam}: ${e.message}`);
  }
  // Een adempauze. Honderd handshakes tegelijk zegt meer over de bezorgwachtrij
  // dan over het paneel, en dit script is er om het paneel te kunnen bekijken.
  if (pauze) await new Promise((r) => setTimeout(r, pauze));
}

console.log(`[offer] verstuurd ${gestuurd}, overgeslagen ${overgeslagen}, mislukt ${mislukt}`);
console.log('[offer] de commit valt pas als elke ward heeft geaccepteerd; kijk over een minuut met listWards.');
process.exit(0);
