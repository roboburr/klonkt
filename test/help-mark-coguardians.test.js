// De markering hoort naar de MEDE-GUARDIANS te gaan (shaer-lgo).
//
// Gevonden op 11 augustus met de echte relatie: dev.klonkt.com is guardian van
// @mee@xn--zz9h.is.wildenvrij.nl, en die heeft er nog een -- boiert.eu. In
// ap_help_state stond geen enkele markering van boiert, en dev had er ook nooit
// een naartoe gestuurd.
//
// De oorzaak: de route leidde de mede-guardians af met
// listGuardians(uri.replace(/.*\/ap\/users\//, '')) -- de staart van de URI als
// slug. listGuardians kent alleen relaties van LOKALE sites, dus voor een ward
// elders was dat altijd leeg. En juist die ward is het punt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://oma.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const rel = await import('../src/services/guardianship/relations.js');
const G = await import('../src/services/guardianship/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'oma', 'Oma', 'u1');

const KIND = 'https://elders.test/ap/users/mee';

test('de oude afleiding gaf leeg voor een ward elders -- de fout, vastgelegd', () => {
  // Wat er stond: de staart van de URI als slug. Er is geen lokale site 'mee',
  // dus dit was altijd een lege lijst, en de markering ging alleen naar het kind.
  assert.deepEqual(rel.listGuardians(KIND.replace(/.*\/ap\/users\//, '')), []);
});

// De handshake krijgt zijn afhankelijkheden normaal bij het opstarten; hier
// alleen de twee die existingGuardiansOf raakt, met een NEPACTOR in plaats van
// het netwerk -- anders test dit of de testmachine internet heeft.
const gevraagd = [];
G.wireHandshake({
  localSlug: (uri) => {
    const m = String(uri).match(/^https:\/\/oma\.test\/ap\/users\/([^/?#]+)$/);
    return m ? m[1] : null;
  },
  fetchActor: async (uri) => {
    gevraagd.push(uri);
    return { id: uri, 'shaer:guardians': ['https://oma.test/ap/users/oma', 'https://elders2.test/ap/users/oom'] };
  },
});

test('voor een ward ELDERS komen ze uit shaer:guardians van zijn actor', async () => {
  const uit = await G.existingGuardiansOf(KIND);
  assert.deepEqual(gevraagd, [KIND], 'de actor van de ward wordt opgehaald');
  assert.deepEqual(uit, ['https://oma.test/ap/users/oma', 'https://elders2.test/ap/users/oom']);
});

test('voor een LOKALE ward blijft het de eigen tabel', async () => {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'kind', 'Kind', 'u1');
  rel.commitGuardianForWard('kind', 'https://oma.test/ap/users/oma', { handle: '@oma@oma.test' });
  const voor = gevraagd.length;
  const uit = await G.existingGuardiansOf('https://oma.test/ap/users/kind');
  assert.deepEqual(uit, ['https://oma.test/ap/users/oma'],
    'lokaal opzoeken blijft werken -- de fix mag dat pad niet slopen');
  assert.equal(gevraagd.length, voor, 'en haalt geen actor op die we zelf hosten');
});
