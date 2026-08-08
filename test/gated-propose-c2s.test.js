// Een gate voorstellen vanuit de app (shaer-8ru, FEP-633c 5.6).
//
// De PWA stelde al voor over een eigen route; de apps konden alleen KIJKEN. Wat
// hier bewaakt wordt is niet dat het werkt, maar dat het langs DEZELFDE weg gaat:
// een tweede implementatie ernaast geeft vroeg of laat een ander antwoord, en bij
// de antwoordpoort was dat vandaag precies het gat (de innamepoort zat alleen in
// C2S, het webpad liep eromheen).
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://oma.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');
const Guardianship = await import('../src/services/guardianship/index.js');
const rel = await import('../src/services/guardianship/relations.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'oma', 'Oma', 'u1');
const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const user = { id: 'u1', username: 'u1' };
const KIND = 'https://elders.test/ap/users/kind';
rel.commitWardForGuardian('oma', KIND, { handle: '@kind' });

const offer = (ward, feature, value) => ({
  type: 'Offer',
  object: { type: 'shaer:GatedSetting', 'shaer:ward': ward, 'shaer:feature': feature, 'shaer:value': value },
});

test('een guardian stelt een gate voor vanuit de app', async () => {
  const uit = await AP.ingestOutboxActivity(site(), user, offer(KIND, 'shaer:images', true));
  assert.equal(uit.status, 201);
  assert.equal(uit.state, 'open');
  // Het spoor van wat we stuurden: zonder rij kan het antwoord van de
  // ward-server nergens landen, en zegt het scherm nooit meer dan een knoptekst.
  const sent = Guardianship.gated.listSent('oma', KIND);
  assert.ok(sent.some((p) => p.feature === 'shaer:images'), 'het voorstel is vastgelegd');
});

test('niet voor een kind dat niet van jou is', async () => {
  // Zonder deze regel kan iedereen met een token een instelling van een vreemd
  // kind aanvragen.
  const uit = await AP.ingestOutboxActivity(site(), user, offer('https://elders.test/ap/users/vreemde', 'shaer:images', true));
  assert.equal(uit.status, 403);
  assert.equal(uit.error, 'not_your_ward');
});

test('een onbekende feature wordt GEWEIGERD, niet herschreven', () => {
  // De oude route herschreef een onbekende naam stilletjes naar externalEmbeds.
  // Een voorstel voor de ene poort dat op de andere landt is het soort fout dat
  // een guardian nooit mag overkomen.
  const uit = AP.proposeGate(site(), KIND, 'shaer:ietsNieuws', true);
  assert.equal(uit.status, 400);
  assert.equal(uit.error, 'unknown_feature');
});

test('een Offer dat GEEN gate-voorstel is wordt niet stilletjes geslikt', async () => {
  const uit = await AP.ingestOutboxActivity(site(), user, { type: 'Offer', object: { type: 'Note', content: 'hoi' } });
  assert.equal(uit.status, 400);
  assert.equal(uit.error, 'unsupported_offer');
});

test('de app en de PWA lopen door DEZELFDE functie', async () => {
  // Niet dat ze hetzelfde doen, maar dat er maar een plek is die het doet: de
  // C2S-weg boekt zijn voorstel in hetzelfde register waar de PWA uit leest.
  const voor = Guardianship.gated.listSent('oma', KIND).length;
  await AP.ingestOutboxActivity(site(), user, offer(KIND, 'shaer:music', true));
  const na = Guardianship.gated.listSent('oma', KIND);
  assert.equal(na.length, voor + 1);
  assert.ok(na.some((p) => p.feature === 'shaer:music'));
});
