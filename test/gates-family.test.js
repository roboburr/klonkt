// De gate-familie functioneel (shaer-ahy.1, Barts opdracht 8-8): niet alleen
// een toets in het paneel, maar een poort die echt dichtkan -- bij de
// AFLEVERING (wat dicht is wordt nooit geserialiseerd) of bij de INNAME (wat
// de ward niet mag versturen wordt aan de outbox geweigerd).
//
// De twee dingen die hier stil kunnen breken: een poort die dicht lijkt maar
// niets tegenhoudt (een guardian waant het kind beschermd), en een poort die
// het hulpkanaal mee afsluit (de boei MOET door elke dichte deur heen).
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');
const Guardianship = await import('../src/services/guardianship/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'kind', 'Kind', 'u1');
const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const user = { id: 'u1', username: 'u1' };

test('elke beschikbare gate in de catalogus heeft een kolom', () => {
  // De bewaker van de bedrading: een catalogusrij zonder kolom is een toets
  // die nergens op aangesloten is, en dat merkt pas iemand die erop drukt.
  for (const g of Guardianship.gated.GATE_CATALOGUE.filter((x) => x.available !== false)) {
    if (g.fixed) continue;   // shaer:follows is een stroom, geen stand
    assert.ok(Guardianship.gated.featureColumn(g.feature), `${g.feature} mist een kolom`);
  }
});

test('de generieke regel: expliciet wint, de automatiek sluit voor een ward', () => {
  assert.equal(Guardianship.wardGateAllowed(null, false), true);
  assert.equal(Guardianship.wardGateAllowed(null, true), false);
  assert.equal(Guardianship.wardGateAllowed(1, true), true);    // guardians openden hem
  assert.equal(Guardianship.wardGateAllowed(0, false), false);  // expliciete 0 wint ook zonder wardstatus
});

test('gateAttachments: beeld en muziek dicht laten de rest staan, leeg wordt undefined', () => {
  const atts = [
    { type: 'Document', mediaType: 'image/webp', url: 'https://x/p.webp' },
    { type: 'Audio', mediaType: 'audio/mpeg', url: 'https://x/a.mp3' },
    { type: 'Document', mediaType: 'video/mp4', url: 'https://x/v.mp4' },
  ];
  const zonderBeeld = AP.gateAttachments(atts, { images: false });
  assert.deepEqual(zonderBeeld.map((a) => a.mediaType), ['audio/mpeg', 'video/mp4']);
  const zonderMuziek = AP.gateAttachments(atts, { audio: false });
  assert.deepEqual(zonderMuziek.map((a) => a.mediaType), ['image/webp', 'video/mp4']);
  // Alles weg is undefined, zoals de serialisatie een leeg veld overal weglaat.
  assert.equal(AP.gateAttachments([atts[0]], { images: false }), undefined);
  // En de poort open verandert niets.
  assert.equal(AP.gateAttachments(atts, {}).length, 3);
});

test('stripEmojiTags haalt alleen de Emoji-tags weg', () => {
  const tags = [
    { type: 'Emoji', name: ':hartje:', icon: { url: 'https://x/h.png' } },
    { type: 'Mention', href: 'https://x/u', name: '@u' },
    { type: 'Hashtag', name: '#muziek' },
  ];
  const uit = AP.stripEmojiTags(tags);
  assert.deepEqual(uit.map((t) => t.type), ['Mention', 'Hashtag']);
  assert.equal(AP.stripEmojiTags([tags[0]]), undefined);
});

test('compose dicht weigert een eigen post aan de outbox, maar geen antwoord', async () => {
  db.prepare("UPDATE sites SET gate_compose = 0 WHERE slug = 'kind'").run();
  const post = { type: 'Create', object: { type: 'Note', content: '<p>hoi</p>', to: ['https://www.w3.org/ns/activitystreams#Public'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, post);
  assert.equal(uit.status, 403);
  assert.equal(uit.error, 'gated_compose');
  // Een antwoord is meedoen aan een gesprek, geen eigen podium: dat valt
  // onder messages/het gesprek, niet onder compose.
  const reply = { type: 'Create', object: { type: 'Note', content: '<p>ja!</p>', inReplyTo: 'https://elders/x', to: ['https://www.w3.org/ns/activitystreams#Public'] } };
  const uit2 = await AP.ingestOutboxActivity(site(), user, reply);
  assert.notEqual(uit2.error, 'gated_compose');
  db.prepare("UPDATE sites SET gate_compose = NULL WHERE slug = 'kind'").run();
});

// ── Antwoorden: een eigen poort (shaer-r4c) ─────────────────────────────
//
// Hier stond de aanname dat een antwoord meedoen is en geen eigen podium, en
// dus onder compose door mocht. Bart heeft die teruggedraaid: meedoen aan een
// gesprek valt ook onder een poort. Wat deze toetsen bewaken is dat het een
// EIGEN poort is en geen aanhangsel van compose -- anders is hij in het paneel
// wel te zien maar niet los te zetten.

test('replies dicht weigert een antwoord', async () => {
  db.prepare("UPDATE sites SET gate_replies = 0 WHERE slug = 'kind'").run();
  const reply = { type: 'Create', object: { type: 'Note', content: '<p>ja!</p>', inReplyTo: 'https://elders/x', to: ['https://www.w3.org/ns/activitystreams#Public'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, reply);
  assert.equal(uit.status, 403);
  assert.equal(uit.error, 'gated_replies');
  db.prepare("UPDATE sites SET gate_replies = NULL WHERE slug = 'kind'").run();
});

test('replies dicht laat een EIGEN post staan', async () => {
  // Los van compose, en dat is de hele reden dat het een eigen rij is: je kunt
  // willen dat een kind een podium heeft zonder in vreemde draadjes te duiken.
  db.prepare("UPDATE sites SET gate_replies = 0 WHERE slug = 'kind'").run();
  const post = { type: 'Create', object: { type: 'Note', content: '<p>hoi</p>', to: ['https://www.w3.org/ns/activitystreams#Public'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, post);
  assert.notEqual(uit.error, 'gated_replies');
  assert.notEqual(uit.error, 'gated_compose');
  db.prepare("UPDATE sites SET gate_replies = NULL WHERE slug = 'kind'").run();
});

test('compose dicht laat een antwoord staan zolang replies open is', async () => {
  // De andere richting van dezelfde onafhankelijkheid. Zou compose ook
  // antwoorden dichtzetten, dan is de nieuwe rij een knop die niets doet.
  db.prepare("UPDATE sites SET gate_compose = 0, gate_replies = 1 WHERE slug = 'kind'").run();
  const reply = { type: 'Create', object: { type: 'Note', content: '<p>ja!</p>', inReplyTo: 'https://elders/x', to: ['https://www.w3.org/ns/activitystreams#Public'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, reply);
  assert.notEqual(uit.error, 'gated_compose');
  assert.notEqual(uit.error, 'gated_replies');
  db.prepare("UPDATE sites SET gate_compose = NULL, gate_replies = NULL WHERE slug = 'kind'").run();
});

test('replies dicht houdt ook een DIRECT antwoord tegen', async () => {
  // Een prive-antwoord is allebei: meedoen aan een gesprek en een bericht. Dan
  // mag allebei hem tegenhouden. Zou alleen de messages-poort gelden, dan is
  // dat het gat waar een dichte replies-poort omheen loopt.
  db.prepare("UPDATE sites SET gate_replies = 0, gate_messages = 1 WHERE slug = 'kind'").run();
  const dm = { type: 'Create', object: { type: 'Note', content: '<p>psst</p>', inReplyTo: 'https://elders/x', to: ['https://elders/ap/users/vreemde'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, dm);
  assert.equal(uit.error, 'gated_replies');
  db.prepare("UPDATE sites SET gate_replies = NULL, gate_messages = NULL WHERE slug = 'kind'").run();
});

test('replies dicht laat de REDDINGSBOEI door, ook als die een antwoord is', async () => {
  // Het gevaarlijkste dat deze poort kan doen. Een kind dat om hulp vraagt in
  // een draadje waar het misgaat, is precies het geval waarvoor de boei bestaat.
  db.prepare("UPDATE sites SET gate_replies = 0 WHERE slug = 'kind'").run();
  const hulp = { type: 'Create', object: { type: 'Note', content: '<p>🛟</p>', 'shaer:helpRequest': true, inReplyTo: 'https://elders/x', to: ['https://elders/ap/users/oma'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, hulp);
  assert.notEqual(uit.error, 'gated_replies');
  db.prepare("UPDATE sites SET gate_replies = NULL WHERE slug = 'kind'").run();
});

test('messages dicht weigert een direct bericht, maar NOOIT de reddingsboei', async () => {
  db.prepare("UPDATE sites SET gate_messages = 0 WHERE slug = 'kind'").run();
  const dm = { type: 'Create', object: { type: 'Note', content: '<p>psst</p>', to: ['https://elders/ap/users/vreemde'] } };
  const uit = await AP.ingestOutboxActivity(site(), user, dm);
  assert.equal(uit.status, 403);
  assert.equal(uit.error, 'gated_messages');
  // De boei gaat door elke dichte deur heen: een poort die het hulpkanaal
  // afsnijdt beschermt niemand.
  const hulp = { type: 'Create', object: { type: 'Note', content: '<p>🛟</p>', 'shaer:helpRequest': true, to: ['https://elders/ap/users/oma'] } };
  const uit2 = await AP.ingestOutboxActivity(site(), user, hulp);
  assert.notEqual(uit2.error, 'gated_messages');
  db.prepare("UPDATE sites SET gate_messages = NULL WHERE slug = 'kind'").run();
});

test('accountMove dicht weigert de verhuizing voordat er iets vertrekt', async () => {
  db.prepare("UPDATE sites SET gate_account_move = 0 WHERE slug = 'kind'").run();
  const uit = await AP.moveAccount(site(), '@iemand@elders.example');
  assert.equal(uit.error, 'guarded_account');
  db.prepare("UPDATE sites SET gate_account_move = NULL WHERE slug = 'kind'").run();
});

test('replies dicht houdt OOK het webpad tegen, niet alleen de app', async () => {
  // routes/posts.js roept deliverReply rechtstreeks aan en gaat nooit langs
  // ingestOutboxActivity. Een poort die alleen in C2S staat heeft een deur
  // ernaast -- en die deur is de eigen webinterface van het kind.
  db.prepare("UPDATE sites SET gate_replies = 0 WHERE slug = 'kind'").run();
  const parent = { id: 'https://elders/x', attributedTo: 'https://elders/ap/users/vreemde' };
  const uit = await AP.deliverReply(site(), { postId: '', postSlug: null, parent, text: 'ja!' });
  assert.equal(uit, null);
  db.prepare("UPDATE sites SET gate_replies = NULL WHERE slug = 'kind'").run();
});

// ── De soort-poorten: ook bij het VERSTUREN, en film heeft er nu een ──────
//
// Twee gaten die naast elkaar stonden en elkaar versterkten (shaer-qc9o en
// shaer-mxh2). gate_images en gate_music golden alleen bij het SERVEREN: wat
// een ward niet te zien kreeg mocht hij wel plaatsen, dus het stond bij
// iedereen behalve bij hemzelf. En film had helemaal geen poort, dus de
// zwaarste soort van de drie was de enige die altijd door mocht.
//
// Samen betekende dat: een kind met plaatjes en muziek dicht kon een half uur
// video de wereld in sturen, en het paneel van de guardian zei dat alles wat
// er te sluiten viel gesloten was.

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const beeld = { type: 'Document', mediaType: 'image/jpeg', url: 'https://klonkt.test/media/x.jpg' };
const film = { type: 'Document', mediaType: 'video/mp4', url: 'https://klonkt.test/media/x.mp4' };
const geluid = { type: 'Audio', mediaType: 'audio/mpeg', url: 'https://klonkt.test/media/x.mp3' };

/** Alle poorten open, behalve die je noemt. Zo toetst elke zaak zijn eigen
 *  weigering en niet een die van een vorige toets bleef staan. */
function poorten(dicht = {}) {
  const kolommen = ['gate_compose', 'gate_replies', 'gate_messages', 'gate_images', 'gate_music', 'gate_video'];
  const zet = kolommen.map((k) => `${k} = ${dicht[k] === 0 ? 0 : 1}`).join(', ');
  db.prepare(`UPDATE sites SET ${zet} WHERE slug = 'kind'`).run();
}

test('film wordt bij het serveren weggeknipt als de video-poort dicht is', () => {
  const atts = [beeld, geluid, film];
  assert.deepEqual(AP.gateAttachments(atts, { video: false }).map((a) => a.mediaType), ['image/jpeg', 'audio/mpeg']);
  // Ook als hij als AS2-Video binnenkomt zonder mediaType: de soort staat dan
  // in `type`, en een poort die alleen naar mediaType kijkt mist hem.
  assert.equal(AP.gateAttachments([{ type: 'Video', url: 'https://x/v' }], { video: false }), undefined);
});

test('een bijlage van een dichte soort wordt aan de outbox geweigerd', async () => {
  for (const [kolom, bijlage, fout] of [
    ['gate_images', beeld, 'gated_images'],
    ['gate_music', geluid, 'gated_music'],
    ['gate_video', film, 'gated_video'],
  ]) {
    poorten({ [kolom]: 0 });
    const post = { type: 'Create', object: { type: 'Note', content: '<p>kijk</p>', to: [PUBLIC], attachment: [bijlage] } };
    const uit = await AP.ingestOutboxActivity(site(), user, post);
    assert.equal(uit.status, 403, `${kolom} dicht hoort te weigeren`);
    assert.equal(uit.error, fout);
  }
});

test('een dichte poort raakt alleen zijn eigen soort', async () => {
  poorten({ gate_images: 0 });
  const post = { type: 'Create', object: { type: 'Note', content: '<p>luister</p>', to: [PUBLIC], attachment: [geluid] } };
  const uit = await AP.ingestOutboxActivity(site(), user, post);
  assert.notEqual(uit.error, 'gated_images', 'muziek hoort niet op de beeldpoort te stuiten');
});

test('de reddingsboei gaat door een dichte beeldpoort heen', async () => {
  // Een hulpvraag draagt vaak juist een schermafdruk: dat is het bewijs van
  // waar het kind van schrikt. Een dichte beeldpoort mag precies het kanaal
  // niet sluiten dat hem veilig houdt.
  poorten({ gate_images: 0, gate_video: 0, gate_music: 0 });
  const boei = {
    type: 'Create',
    object: {
      type: 'Note', content: '<p>help</p>', 'shaer:helpRequest': true,
      to: ['https://elders.test/u/oma'], attachment: [beeld],
    },
  };
  const uit = await AP.ingestOutboxActivity(site(), user, boei);
  assert.notEqual(uit.error, 'gated_images', 'de boei hoort door elke dichte deur heen te gaan');
});
