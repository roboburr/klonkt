// FEP-633c §5.3, the direction that was never gated (bead shaer-p729).
//
// A ward's own follow used to go straight out; the guardians got a note
// afterwards, which is informing, not gating — the door is already open by the
// time the message lands. Now it waits, with two exceptions that are not
// favours but the same decision already taken: the ward's own guardian, and
// someone a guardian already admitted through the inbound gate.
//
// The mutual shortcut only counts followers who came through that gate. A
// follower a free actor collected before it was ever a ward was never seen by
// a guardian, so following them back is a new question. Rows that predate the
// marker are grandfathered (Barts besluit, 3-8).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');

const BASE = 'https://test.example';
const local = (slug) => `${BASE}/ap/users/${slug}`;
const STRANGER = 'https://elders.example/users/stranger';
const PAL = 'https://elders.example/users/pal';
const OLDPAL = 'https://elders.example/users/oldpal';

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
let n = 0;
function site(slug) {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)')
    .run(`s${++n}`, slug, slug, 'u1', n === 1 ? 1 : 0);
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
}
const guards = (slug, other) =>
  db.prepare("INSERT INTO ap_guardianships (slug, role, other_uri, status) VALUES (?, 'ward', ?, 'accepted')")
    .run(slug, other);
const follower = (slug, uri, gateApproved) =>
  db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox, gate_approved) VALUES (?,?,?,?)')
    .run(slug, uri, `${uri}/inbox`, gateApproved ? 1 : 0);

const kid = site('kid');
site('mum');
guards('kid', local('mum'));          // kid is a ward, watched by mum
follower('kid', PAL, true);           // came through the §5.3 gate
follower('kid', OLDPAL, false);       // followed back when kid was still free

const free = site('freebird');        // no guardians at all

test('a free actor is not gated at all', async () => {
  assert.equal(await AP.gateOutgoingFollow(free, STRANGER), null,
    'guardianship is the only thing that gates a follow; a free account keeps its own counsel');
});

test('a stranger has to wait for the guardians', async () => {
  const held = await AP.gateOutgoingFollow(kid, STRANGER);
  assert.ok(held, 'held, not sent');
  assert.equal(held.status, 'pending');
  assert.equal(held.target_uri, STRANGER);
});

test('following your own guardian needs nobody\'s permission', async () => {
  assert.equal(await AP.gateOutgoingFollow(kid, local('mum')), null,
    'asking mum whether you may follow mum is not a question');
});

test('a follower the guardians already admitted may be followed back', async () => {
  assert.equal(await AP.gateOutgoingFollow(kid, PAL), null,
    'a guardian said yes to this person by name; asking twice teaches people to stop reading');
});

test('but a follower from before the guardians existed is a fresh question', async () => {
  const held = await AP.gateOutgoingFollow(kid, OLDPAL);
  assert.ok(held, 'never went through the gate, so nobody ever vetted them');
  assert.equal(held.status, 'pending');
});

test('asking twice does not queue the same request twice', async () => {
  const again = await AP.gateOutgoingFollow(kid, STRANGER);
  assert.ok(again);
  assert.equal(G.outgoing.listForWard('kid').filter((o) => o.target_uri === STRANGER).length, 1);
});

test('the guardians see it in their own queue, apart from the inbound one', () => {
  const q = G.outgoingFollowsCollection(`${local('kid')}/queues/outgoing-follows`, 'kid', local('mum'));
  const mine = q.orderedItems.filter((o) => o['shaer:target'] === STRANGER);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]['shaer:direction'], 'outgoing',
    'a guardian must be able to tell "wants to follow your ward" from "your ward wants to follow"');
  assert.equal(mine[0]['shaer:myVote'], false);
});

test('a guardian approving lets it through from then on', async () => {
  const pending = G.outgoing.listForWard('kid').find((o) => o.target_uri === STRANGER);
  const r = G.outgoing.decide(pending.id, local('mum'), 'approve', [local('mum')]);
  assert.equal(r.outcome, 'approved');
  assert.equal(await AP.gateOutgoingFollow(kid, STRANGER), null,
    'the row stays behind as the record, so an unfollow and refollow is not a second question');
});

test('a refusal is remembered too, and does not re-ask by re-tapping', async () => {
  const held = await AP.gateOutgoingFollow(kid, OLDPAL);
  const r = G.outgoing.decide(held.id, local('mum'), 'reject', [local('mum')]);
  assert.equal(r.outcome, 'rejected');
  const again = await AP.gateOutgoingFollow(kid, OLDPAL);
  assert.equal(again.status, 'denied', 'tapping follow again does not put it back in front of mum');
});

// ── De poort zit in followActor, niet alleen in C2S (Barts melding 8-8) ──
//
// Esmee's volgverzoeken kwamen nooit bij haar guardians aan. Niet omdat een
// guardian elders ze niet kon beantwoorden -- die weg werkt -- maar omdat er
// nooit een verzoek werd aangemaakt: de poort stond in `case 'Follow'` van de
// C2S-outbox, en dus alleen als je via Shaer volgt. Vanuit Klonkts eigen
// webinterface liep je er zo omheen.
//
// Dezelfde deur-naast-de-poort als bij de antwoordpoort (shaer-r4c), en de reden
// dat die mutatie 0 fouten gaf: er stond niets op.

test('een ward die vanaf het WEB volgt wordt ook tegengehouden', async () => {
  const uit = await AP.followActor(kid, 'https://elders.example/users/webvriend');
  assert.equal(uit.held, true, 'vastgehouden, niet gevolgd');
  assert.equal(uit.status, 'pending');
  // En er ligt echt iets voor de guardians, anders is "held" een leeg gebaar.
  assert.ok(G.outgoing.findFor('kid', 'https://elders.example/users/webvriend'));
});

test('ook als het kind met een HANDLE volgt', async () => {
  // De poort staat NA het oplossen. Zou hij alleen naar de ruwe invoer kijken,
  // dan is elke @naam@server een sluiproute -- de fout die we hier repareren,
  // een maat kleiner.
  const uit = await AP.followActor(kid, 'https://elders.example/users/handlevriend');
  assert.equal(uit.held, true);
});

test('een goedgekeurd verzoek komt er WEL doorheen', async () => {
  // Zonder deze doorlaat stuit een goedgekeurd verzoek opnieuw op de poort en
  // wacht het voor eeuwig -- de poort zou zichzelf voeden.
  const uit = await AP.followActor(kid, 'https://elders.example/users/webvriend', false, { approved: true });
  assert.notEqual(uit.held, true);
});

test('een site ZONDER guardians merkt er niets van', async () => {
  // Een volwassen account is geen ward. Zou de poort daar ook dichtklappen, dan
  // kan niemand op deze instance nog iemand volgen.
  const vrij = site('vrij');
  const uit = await AP.followActor(vrij, 'https://elders.example/users/iemand');
  assert.notEqual(uit && uit.held, true);
});

// ── shaer:following als eigen poort (shaer-p729) ──────────────────────────
// De uitgaande kant stond als één rij met de inkomende in het paneel, en dan
// telt een guardian de ene richting en hoort niets over de andere. Nu twee
// poorten. Het VERSCHIL tussen die twee is opzet: §5.3 eist dat een Follow
// NAAR een ward langs de guardians gaat, dus die staat vast aan. Over deze
// richting zegt de FEP niets, dus die is van ons -- en dan hoort hij ook echt
// losgelaten te kunnen worden.

test('onbeslist betekent dicht voor een ward, net als bij de andere poorten', async () => {
  const wim = site('wim');
  guards('wim', local('mum'));
  const held = await AP.gateOutgoingFollow(wim, 'https://elders.example/users/nieuw');
  assert.ok(held, 'niemand heeft er iets over besloten, dus vragen we');
});

test('de guardians kunnen de poort openzetten, en dan vraagt het kind niets meer', async () => {
  const zoe = site('zoe');
  guards('zoe', local('mum'));
  db.prepare('UPDATE sites SET gate_following = 1 WHERE slug = ?').run('zoe');
  const zoeSite = db.prepare('SELECT * FROM sites WHERE slug = ?').get('zoe');
  assert.equal(await AP.gateOutgoingFollow(zoeSite, 'https://elders.example/users/nieuw'), null,
    'een kind dat erin gegroeid is hoeft niet eeuwig te blijven vragen');
});

test('en weer dicht is ook een besluit', async () => {
  const zoeSite = db.prepare('SELECT * FROM sites WHERE slug = ?').get('zoe');
  db.prepare('UPDATE sites SET gate_following = 0 WHERE slug = ?').run('zoe');
  const dicht = db.prepare('SELECT * FROM sites WHERE slug = ?').get('zoe');
  assert.ok(await AP.gateOutgoingFollow(dicht, 'https://elders.example/users/weer'),
    'terugdraaien kan: de poort is reversible');
  assert.equal(zoeSite.gate_following, 1, '(en de oude rij was echt open)');
});

test('de twee richtingen tellen apart in het paneel', async () => {
  const queues = await import('../src/services/guardianship/queues.js');
  const rows = queues.wardGates('mum', local('kid'));
  const namen = rows.map((r) => r.feature);
  assert.ok(namen.includes('shaer:follows'), 'wie het kind wil volgen');
  assert.ok(namen.includes('shaer:following'), 'en wie het kind wil volgen -- andersom');
  const uit = rows.find((r) => r.feature === 'shaer:following');
  assert.equal(uit.adjustable, true, 'deze mag verzet worden');
  const inn = rows.find((r) => r.feature === 'shaer:follows');
  assert.equal(inn.adjustable, false, 'en deze niet: §5.3 laat er geen ruimte voor');
});
