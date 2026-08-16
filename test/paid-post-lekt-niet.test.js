// Een betaalde post lekt zijn inhoud nergens (klonkt-demo-aki).
//
// Aanleiding (Bart, 15-8): https://boiert.eu/we-should-explore-at-least-something
// stond met 4555 tekens VOLLEDIG in de publieke outbox -- onbetekend op te
// halen. Die post bleek niet als `paid` gemarkeerd: "PAID" stond alleen in de
// waarschuwingstekst, en dat is tekst, geen poort.
//
// Dat de redactie op EEN plek hangt (de vroege return in buildNote) maakt hem
// kwetsbaar: elk pad dat post.content serveert zonder buildNote lekt meteen, en
// zonder foutmelding. Deze tests leggen vast dat geen enkele weg dat doet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'dev', 'Dev', 'u1');
const site = () => db.prepare("SELECT * FROM sites WHERE id = 's1'").get();

const GEHEIM = 'DIT IS DE BETAALDE INHOUD DIE NERGENS MAG STAAN';

function maak({ id, slug, paid = 0, fan = 0, nsfw = 0, cw = null }) {
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, excerpt, content,
              status, published_at, paid, fan_only, nsfw, content_warning)
              VALUES (?,?,?,?,?,?,?,'published',?,?,?,?,?)`)
    .run(id, 's1', 'u1', slug, 'Titel', 'Een teaser.',
         `<p>${GEHEIM}</p><p>en nog meer</p>`, '2026-08-15T12:00:00Z', paid, fan, nsfw, cw);
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

const alleTekst = (o) => JSON.stringify(o);

test('een betaalde post geeft een teaser, nooit de inhoud', () => {
  const note = AP.buildNote('https://ons.test', site(), maak({ id: 'p1', slug: 'betaald', paid: 1 }));
  assert.ok(!alleTekst(note).includes(GEHEIM), 'de inhoud staat nergens in het object');
  assert.match(note.content, /Een teaser/);
});

test('ook niet via de OUTBOX, het pad waar het misging', () => {
  // Bart zag hem juist daar: de outbox serveert Create-activiteiten en die
  // dragen het Note-object. Als de redactie daar niet meekomt, lekt alles.
  const p = maak({ id: 'p2', slug: 'betaald-2', paid: 1 });
  const ob = AP.buildOutbox('https://ons.test', site(), [p], []);
  assert.ok(!alleTekst(ob).includes(GEHEIM), 'ook de outbox draagt hem niet');
});

test('en niet voor een VRIEND, want de redactie kent geen publiek', () => {
  // outboxAudience geeft 'friend' aan iedere volger; fan_only laat die posts dan
  // mee. Een betaalde post mag dat NIET volgen -- betalen is iets anders dan
  // volgen.
  const p = maak({ id: 'p3', slug: 'betaald-vrienden', paid: 1, fan: 1 });
  const ob = AP.buildOutbox('https://ons.test', site(), [p], []);
  assert.ok(!alleTekst(ob).includes(GEHEIM));
});

test('een SENSITIVE betaalde post houdt zijn waarschuwing', () => {
  // Hier zat de tweede fout: de vroege return liet `sensitive` en `summary`
  // vallen, dus een betaalde post met een waarschuwing kwam ZONDER die
  // waarschuwing de deur uit. De teaser is publiek; dan hoort de waarschuwing
  // dat ook te zijn.
  const p = maak({ id: 'p4', slug: 'betaald-nsfw', paid: 1, nsfw: 1, cw: 'Smut' });
  const note = AP.buildNote('https://ons.test', site(), p);
  assert.ok(!alleTekst(note).includes(GEHEIM), 'inhoud nog steeds weg');
  assert.equal(note.sensitive, true, 'de vlag reist mee');
  assert.equal(note.summary, 'Smut', 'en de waarschuwingstekst ook');
});

test('een NIET-betaalde post lekt niets extra: die hoort gewoon leesbaar', () => {
  // De tegenproef, zodat de test niet slaagt door alles dicht te gooien.
  const note = AP.buildNote('https://ons.test', site(), maak({ id: 'p5', slug: 'gewoon' }));
  assert.ok(alleTekst(note).includes(GEHEIM), 'een gewone post draagt zijn inhoud wel');
});
