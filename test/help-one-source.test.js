// Eén weg naar de hulpvragen (Barts 429-jacht, 9-8).
//
// De PWA had een eigen kopie van de queue-query MET een afkap op 50, dus de
// fix die open vragen nooit meer afkapt (shaer-6wt) ging aan het paneel
// voorbij: juist de guardian met een caseload -- de jeugdzorgmedewerker uit
// die bead -- zag oude open vragen wegvallen. Dit legt vast dat er één bron
// is, dat die bron alles draagt wat een kaart nodig heeft, en dat open vragen
// ook boven de 50 blijven staan.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const Guardianship = await import('../src/services/guardianship/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'zorg', 'Zorg', 'u1');

// Een caseload: 80 hulpvragen van 80 ECHTE wards, allemaal open. Ruim boven
// de oude afkap. De relaties moeten er zijn: withWardship sluit een vraag van
// een oud-ward bewust (die is niet meer van jou), en zonder relatie zou dit
// dus per ongeluk het oud-ward-pad toetsen in plaats van de afkap.
const N = 80;
for (let i = 0; i < N; i++) {
  db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, status)
              VALUES ('zorg', 'guardian', ?, 'accepted')`).run(`https://elders/u/w${i}`);
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, note_url, actor_uri, actor_name, content, help_request, media_json, created_at)
              VALUES ('zorg', ?, ?, ?, ?, ?, 1, ?, datetime('now', ?))`)
    .run(`https://elders/n${i}`, `https://elders/p${i}`, `https://elders/u/w${i}`, `Ward ${i}`,
         `<p>hulp ${i}</p>`, '[{"url":"https://elders/plaatje.png","type":"image/png"}]', `-${i} minutes`);
}

test('alle open hulpvragen komen door, ook ver boven de oude afkap van 50', () => {
  const items = Guardianship.queues.helpItemsFor('zorg');
  const open = items.filter((h) => h.state.open);
  assert.equal(open.length, N, `alle ${N} open vragen, niet ${open.length}`);
});

test('de bron draagt wat een kaart nodig heeft (de reden dat de PWA een kopie had)', () => {
  const eerste = Guardianship.queues.helpItemsFor('zorg')[0];
  // Precies de velden waarvoor het paneel zijn eigen query hield.
  for (const veld of ['note_url', 'media_json', 'quote_json', 'embed_json', 'emoji_json', 'actor_emoji_json']) {
    assert.ok(veld in eerste, `${veld} ontbreekt -- dan splitst de query zich opnieuw`);
  }
  assert.equal(eerste.note_url, 'https://elders/p0');
});

test('afgehandelde vragen worden WEL afgekapt: geschiedenis vraagt niets', () => {
  // Zet alles op afgehandeld door een handled-notitie te plaatsen? Dat is de
  // weg van help.statusFor; hier volstaat de vorm: met historyLimit 5 mogen
  // er hoogstens 5 gesloten vragen mee, terwijl open er altijd allemaal zijn.
  const items = Guardianship.queues.helpItemsFor('zorg', 5);
  assert.equal(items.filter((h) => h.state.open).length, N);
  assert.ok(items.filter((h) => !h.state.open).length <= 5);
});
