// Een markering op een hulpvraag draagt zijn context (26-8).
//
// Barts vraag: in Berichten staat "Ik kijk hiernaar." maar een tik erop geeft
// niets -- welke context heeft dat bericht? Geen, bleek: de verwijzing reisde
// alleen als shaer:-veld, en dat veld haalt de berichtenlezing niet. De
// tik-route van de clients volgt inReplyTo, en die stond er niet op.
//
// Deze toets legt het contract vast op de plek die alle wegen delen:
// deliverDirectNote. De guardian-knop en het C2S-pad komen daar allebei doorheen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const help = (await import('../src/services/guardianship/help.js')).default;

const BASE = 'https://test.example';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)')
  .run('s1', 'oppas', 'Oppas', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)')
  .run('s2', 'kind', 'Kind', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('oppas');

const HULPVRAAG = 'https://elders.test/notes/help-123';

test('de oppak-markering is een antwoord op de hulpvraag', async () => {
  // Naar een LOKALE ontvanger: dan loopt de bezorging over de loopback en
  // raakt deze toets geen netwerk.
  const r = await AP.deliverDirectNote(site, {
    recipients: [`${BASE}/ap/users/kind`],
    text: 'Ik kijk hiernaar.',
    helpMark: { kind: 'pickup', noteUri: HULPVRAAG },
  });
  assert.ok(r && r.id, 'bezorging levert een id');

  // De outbox-rij: inReplyTo hoort op de hulpvraag te staan, ook al gaf de
  // aanroeper hem niet mee. Dat is de hele reparatie.
  const rij = db.prepare('SELECT in_reply_to FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(rij.in_reply_to, HULPVRAAG);

  // En de note die de deur uit gaat zegt het in gewoon AS2.
  const note = AP.buildReplyNote(BASE, site, db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id));
  assert.equal(note.inReplyTo, HULPVRAAG);
});

test('een meegegeven inReplyTo wint van de markering', async () => {
  // Wie expliciet ergens op antwoordt, antwoordt daarop. De markering vult
  // alleen het gat.
  const r = await AP.deliverDirectNote(site, {
    recipients: [`${BASE}/ap/users/kind`],
    text: 'Deze hulpvraag is afgehandeld.',
    inReplyTo: 'https://elders.test/notes/iets-anders',
    helpMark: { kind: 'handled', noteUri: HULPVRAAG },
  });
  const rij = db.prepare('SELECT in_reply_to FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(rij.in_reply_to, 'https://elders.test/notes/iets-anders');
});

test('een gewoon bericht krijgt er geen inReplyTo bij', async () => {
  const r = await AP.deliverDirectNote(site, {
    recipients: [`${BASE}/ap/users/kind`],
    text: 'gewoon een berichtje',
  });
  const rij = db.prepare('SELECT in_reply_to FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(rij.in_reply_to, null);
});

test('markerNote zelf draagt de verwijzing ook als inReplyTo', () => {
  const n = help.markerNote({ id: 'x', me: 'https://g/u/a', noteUri: HULPVRAAG, kind: 'pickup', to: ['https://w/u/k'] });
  assert.equal(n.inReplyTo, HULPVRAAG);
  assert.equal(n['shaer:helpPickup'], HULPVRAAG);
});
