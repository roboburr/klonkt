// Een ANTWOORD dat als vermelding/bericht binnenkomt hoort zijn ouder te
// houden (Robins melding, 26-8). Dat deed het niet: ap_mentions had geen
// kolom voor inReplyTo, dus de ouder viel bij het opslaan op de grond en de
// C2S-lezing kon hem niet serveren. Een client kan een gesprek alleen
// teruglopen langs inReplyTo, dus elk antwoord kwam aan als het BEGIN van een
// gesprek.
//
// Getoetst op de keten, niet op een kolom: binnen via handleInbox, eruit via
// dezelfde leesweg die de app gebruikt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');

const mij = 'https://test.example/ap/users/kid';

/** Een binnenkomende directe note, zoals de inbox hem van de andere kant krijgt. */
async function binnen(note) {
  const act = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${note.id}#create`, type: 'Create', actor: note.attributedTo, object: note,
  };
  // preVerified: de handtekening zelf is hier niet het onderwerp, en zonder
  // netwerk valt er niets op te halen.
  await AP.handleInbox(
    { body: act, headers: {}, method: 'POST', originalUrl: '/ap/users/kid/inbox', rawBody: Buffer.from(JSON.stringify(act)) },
    'kid',
    { id: note.attributedTo },
  );
}

const note = (id, extra = {}) => ({
  id, type: 'Note', attributedTo: 'https://pruts.nl/ap/users/bart',
  content: `<p>${id}</p>`, to: [mij],
  tag: [{ type: 'Mention', href: mij, name: '@kid@test.example' }],
  published: '2026-08-26T10:00:00Z',
  ...extra,
});

test('een binnengekomen antwoord houdt zijn ouder, van opslag tot lezing', async () => {
  await binnen(note('https://pruts.nl/notes/1'));
  await binnen(note('https://pruts.nl/notes/2', { inReplyTo: 'https://pruts.nl/notes/1' }));

  const berichten = AP.getDirectMessages('kid', 20);
  const kop = berichten.find((m) => m.object_uri === 'https://pruts.nl/notes/2');
  const eerste = berichten.find((m) => m.object_uri === 'https://pruts.nl/notes/1');
  assert.ok(kop && eerste, 'allebei de berichten kwamen binnen');
  assert.equal(kop.in_reply_to, 'https://pruts.nl/notes/1', 'het antwoord draagt zijn ouder');
  assert.equal(eerste.in_reply_to, null, 'en wie niets beantwoordt heeft er geen');

  // Dezelfde rij zoals een gesprek hem opvraagt: een keten teruglopen gebeurt
  // langs deze weg, niet langs de inbox-lijst.
  const [uitGesprek] = AP.messageRowsByUri('kid', ['https://pruts.nl/notes/2']);
  assert.equal(uitGesprek.in_reply_to, 'https://pruts.nl/notes/1', 'ook via de gesprekslezing');
});

test('de ouder mag alleen een http(s)-adres zijn, in beide AS2-vormen', async () => {
  // AS2 staat een string of een object toe. Alleen de string erkennen laat
  // hetzelfde gat open voor iedereen die de objectvorm stuurt.
  await binnen(note('https://pruts.nl/notes/3', { inReplyTo: { id: 'https://pruts.nl/notes/1', type: 'Note' } }));
  const [obj] = AP.messageRowsByUri('kid', ['https://pruts.nl/notes/3']);
  assert.equal(obj.in_reply_to, 'https://pruts.nl/notes/1', 'de objectvorm telt net zo goed');

  // En een vreemde mag langs dit veld geen ander schema binnensmokkelen.
  await binnen(note('https://pruts.nl/notes/4', { inReplyTo: 'javascript:alert(1)' }));
  const [vies] = AP.messageRowsByUri('kid', ['https://pruts.nl/notes/4']);
  assert.equal(vies.in_reply_to, null, 'geen javascript:-adres in de kolom');
});
