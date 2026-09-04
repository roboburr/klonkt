// De noodknop is niet door een vreemde uit te zetten (shaer-gt70).
//
// De markering op een hulpvraag ('ik kijk ernaar' / 'afgehandeld') werd van
// IEDEREEN aangenomen: de enige voorwaarde was dat de actor niet lokaal is.
// Ondertekening zegt WIE, niet OF HET MAG. Afgehandeld kent geen terugdraai en
// daarna verdwijnt de vraag uit de teller van elke guardian, dus een vreemde die
// de URI kende kon de noodknop van een kind uitzetten.
//
// De regel die er nu staat: de ward is de bron van waarheid over wie zijn
// guardians zijn, en WELKE ward erbij hoort komt uit onze eigen administratie.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;
const help = (await import('../src/services/guardianship/help.js')).default;

// Het kind woont hier; wij zijn zijn guardian-instantie en hebben zijn
// hulpvraag binnengekregen. Een tweede guardian woont elders.
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'Kid', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'gua', 'Guardian', 'u1');

const WARD = 'https://test.example/ap/users/kid';
const MEDE_GUARDIAN = 'https://elders.example/u/oma';
const VREEMDE = 'https://elders.example/u/vreemde';
const HULPVRAAG = 'https://test.example/ap/notes/hulp-1';

// De ward kent zijn guardians: dat is de lijst waar het antwoord vandaan komt.
db.prepare("INSERT INTO ap_guardianships (slug, role, other_uri, status) VALUES ('kid','ward',?,'accepted')").run(MEDE_GUARDIAN);
// En wij hebben de hulpvraag echt binnengekregen.
db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, content, help_request)
            VALUES ('gua', ?, ?, '<p>help</p>', 1)`).run(HULPVRAAG, WARD);

/** Een markering zoals hij over de lijn komt, van `van`. */
async function markeer(van, noteUri = HULPVRAAG, kind = 'handled') {
  const note = {
    id: `${van}/markering/${Math.random().toString(36).slice(2)}`,
    type: 'Note', attributedTo: van, to: ['https://test.example/ap/users/gua'],
    inReplyTo: noteUri,
    [kind === 'handled' ? 'shaer:helpHandled' : 'shaer:helpPickup']: noteUri,
    content: '<p>markering</p>',
    tag: [{ type: 'Mention', href: 'https://test.example/ap/users/gua', name: '@gua@test.example' }],
  };
  const act = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${note.id}#create`, type: 'Create', actor: van, object: note };
  const stil = console.warn; console.warn = () => {};
  try {
    await AP.handleInbox(
      { body: act, headers: {}, method: 'POST', originalUrl: '/ap/users/gua/inbox', rawBody: Buffer.from(JSON.stringify(act)) },
      'gua', { id: van },
    );
  } finally { console.warn = stil; }
}

const staat = () => help.statusOf(HULPVRAAG);

test('een vreemde krijgt de noodknop niet uit', async () => {
  await markeer(VREEMDE);
  assert.equal(staat().handled, null, 'een vreemde mag een hulpvraag niet afsluiten');
  assert.equal(staat().open, true, 'en de vraag staat dus nog open');
});

test('een guardian van deze ward mag het wel', async () => {
  await markeer(MEDE_GUARDIAN);
  assert.ok(staat().handled, 'een mede-guardian sluit hem wel af');
});

test('een markering voor een hulpvraag die wij niet hebben, telt niet', async () => {
  const ONBEKEND = 'https://elders.example/n/ergens-anders-gezien';
  await markeer(MEDE_GUARDIAN, ONBEKEND, 'pickup');
  assert.equal(help.statusOf(ONBEKEND).pickedUpBy.length, 0,
    'zonder eigen rij is er niets te markeren -- de note-URI komt van de afzender');
});

test('de verwerking valt niet om op de markering zelf', async () => {
  // Tweede vondst bij deze bead, gemeten: de markeerweg riep wakeGuardian(slug)
  // aan met een `slug` die in die scope niet bestaat. Gevolg: de markering werd
  // vastgelegd en daarna gooide de handler een ReferenceError -- het paneel
  // hoorde het nooit en de rest van de verwerking van die activiteit viel weg.
  // Deze toets faalt zodra iemand daar weer een naam neerzet die er niet is.
  const DERDE = 'https://test.example/ap/notes/hulp-3';
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, content, help_request)
              VALUES ('gua', ?, ?, '<p>help</p>', 1)`).run(DERDE, WARD);
  const note = {
    id: `${MEDE_GUARDIAN}/markering/heel`, type: 'Note', attributedTo: MEDE_GUARDIAN,
    to: ['https://test.example/ap/users/gua'], 'shaer:helpPickup': DERDE, content: '<p>ik kijk</p>',
    tag: [{ type: 'Mention', href: 'https://test.example/ap/users/gua', name: '@gua@test.example' }],
  };
  const act = { id: `${note.id}#create`, type: 'Create', actor: MEDE_GUARDIAN, object: note };
  const status = await AP.handleInbox(
    { body: act, headers: {}, method: 'POST', originalUrl: '/ap/users/gua/inbox', rawBody: Buffer.from(JSON.stringify(act)) },
    'gua', { id: MEDE_GUARDIAN },
  );
  assert.equal(status, 202, 'de inbox hoort netjes 202 te geven, niet te gooien');
  assert.equal(help.statusOf(DERDE).pickedUpBy.length, 1, 'en de oppik is vastgelegd');
});

test('guardian van een ANDERE ward is hier geen guardian', async () => {
  // Iemand kan een echte guardian zijn, maar van een ander kind. De vraag is
  // niet "is dit een guardian" maar "is dit een guardian van DEZE ward".
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s3', 'kid2', 'Kid2', 'u1');
  const ANDERE = 'https://elders.example/u/opa';
  db.prepare("INSERT INTO ap_guardianships (slug, role, other_uri, status) VALUES ('kid2','ward',?,'accepted')").run(ANDERE);
  const TWEEDE = 'https://test.example/ap/notes/hulp-2';
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, content, help_request)
              VALUES ('gua', ?, ?, '<p>help</p>', 1)`).run(TWEEDE, WARD);
  await markeer(ANDERE, TWEEDE);
  assert.equal(help.statusOf(TWEEDE).handled, null, 'guardian van een ander kind blijft hier een vreemde');
});
