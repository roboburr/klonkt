// Een slug is een LOKALE sleutel en mag niet uit een vreemde URI komen.
//
// Robins vraag (11-8): waar communiceren we nog op <slug>, want op een
// AP-oppervlak mag dat niet. In de inbox werd hij geraden met
// slugFromActorUrl -- die knipt de staart van een pad af zonder naar de host te
// kijken. De uri's komen daar uit `to`, uit de relatie en uit act.object, dus
// van de AFZENDER. Een activiteit gericht aan andermans actor met dezelfde
// padstaart als een van onze sites kwam zo bij ONZE site terecht.
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
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'dev', 'Dev', 'u1');

test('een vreemde actor met onze padstaart levert GEEN lokale slug', () => {
  // Dit is de aanval in een regel: elders heet ook iemand /ap/users/dev.
  assert.equal(AP.localSlugOf('https://elders.example/ap/users/dev'), null);
});

test('onze eigen actor levert hem wel', () => {
  assert.equal(AP.localSlugOf('https://ons.test/ap/users/dev'), 'dev');
});

test('en een site die niet bestaat ook niet, ook al is de host de onze', () => {
  // De staart is niet genoeg: hij moet ook echt een site zijn.
  assert.equal(AP.localSlugOf('https://ons.test/ap/users/bestaatniet'), null);
});

test('een pad dat er alleen op lijkt telt niet', () => {
  assert.equal(AP.localSlugOf('https://ons.test/elders/ap/users/dev'), null);
  assert.equal(AP.localSlugOf('https://kwaad.test/ons.test/ap/users/dev'), null);
});
