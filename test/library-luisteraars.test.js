// Luisteraars: wie de BIBLIOTHEEK volgt (shaer-0nh).
//
// Het hele punt is een NEGATIEVE garantie: deze accounts krijgen de muziek en
// NIET de gewone posts. Wie zich op een platenkast abonneert heeft niet om de
// Krant gevraagd. Daarom een eigen tabel en geen vlag: zolang ze ergens anders
// staan kan een postbezorging ze niet per ongeluk meenemen, en dat is een fout
// die aan onze kant onzichtbaar zou zijn.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const { luisteraars } = await import('../src/services/music/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'band', 'De Band', 'u1');

const VER = 'https://open.audio/federation/actors/iemand';

test('een luisteraar erbij, en volgen is idempotent', () => {
  assert.equal(luisteraars.voegToe('band', { actorUri: VER, inbox: `${VER}/inbox`, name: 'Iemand', handle: '@iemand@open.audio' }), true);
  assert.equal(luisteraars.telling('band'), 1);
  // Twee keer volgen is geen twee luisteraars -- remote servers sturen een
  // Follow gerust nog eens.
  luisteraars.voegToe('band', { actorUri: VER, inbox: `${VER}/inbox`, name: 'Iemand Anders' });
  assert.equal(luisteraars.telling('band'), 1);
  assert.equal(luisteraars.lijst('band')[0].name, 'Iemand Anders', 'en de laatste gegevens winnen');
});

test('ze staan NIET tussen de gewone volgers -- dat is de hele garantie', () => {
  const gewoon = db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ?').get('band').n;
  assert.equal(gewoon, 0,
    'een luisteraar in ap_followers zou de Krant bezorgen bij iemand die alleen muziek wilde');
});

test('weggaan werkt meteen', () => {
  assert.equal(luisteraars.verwijder('band', VER), true);
  assert.equal(luisteraars.telling('band'), 0);
  assert.equal(luisteraars.verwijder('band', VER), false, 'en twee keer weggaan is geen fout');
});

test('de inboxen worden ontdubbeld op de gedeelde inbox', () => {
  // Twee luisteraars op dezelfde instance horen EEN bezorging te krijgen.
  luisteraars.voegToe('band', { actorUri: `${VER}/a`, inbox: `${VER}/a/inbox`, sharedInbox: 'https://open.audio/inbox' });
  luisteraars.voegToe('band', { actorUri: `${VER}/b`, inbox: `${VER}/b/inbox`, sharedInbox: 'https://open.audio/inbox' });
  luisteraars.voegToe('band', { actorUri: 'https://elders.test/u/c', inbox: 'https://elders.test/u/c/inbox' });
  assert.deepEqual(luisteraars.inboxen('band').sort(),
    ['https://elders.test/u/c/inbox', 'https://open.audio/inbox']);
});

test('een luisteraar van een ANDERE site telt hier niet mee', () => {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'ander', 'Ander', 'u1');
  luisteraars.voegToe('ander', { actorUri: VER, inbox: `${VER}/inbox` });
  assert.equal(luisteraars.telling('ander'), 1);
  assert.equal(luisteraars.isLuisteraar('band', VER), false);
});
