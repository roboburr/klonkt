// Everything on this machine behaves as if every Klonkt were somewhere else.
//
// Co-location is a TRANSPORT detail: a delivery to a local actor is looped back
// into the same inbox handler instead of crossing a socket, and nothing above
// that line knows the difference. The rule exists because two bugs in one week
// came from a second, local-only path hiding a broken remote one:
//   - the Undo never reached a co-located ward (you cannot HTTP your own inbox);
//   - the gated proposal was broken over the wire, while the local shortcut
//     recorded the vote directly and looked perfectly fine on the dashboard.
//
// So the scenario below runs TWICE, all-local and all-remote, and both runs must
// land in the same place. A shortcut that decides something for a local party
// shows up here as a difference between the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');

const BASE = 'https://test.example';
const local = (slug) => `${BASE}/ap/users/${slug}`;
const remote = (name) => `https://${name}.test/u/${name}`;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
let n = 0;
function site(slug) {
  db.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)')
    .run(`s${++n}`, slug, slug, 'u1', n === 1 ? 1 : 0);
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
}
const guardianship = (slug, role, other) =>
  db.prepare(`INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, status, offer_id)
              VALUES (?,?,?,'accepted','o')`).run(slug, role, other);

/**
 * One ward with three guardians, in a chosen topology. `local` puts all three
 * on this instance, `remote` puts them elsewhere. The ward is local either way:
 * the ward's server is the one under test, because it is the one that tallies.
 */
function world(prefix, topology) {
  const wardSlug = `${prefix}ward`;
  const wardSite = site(wardSlug);
  const guardians = ['a', 'b', 'c'].map((g) => {
    if (topology !== 'local') return remote(`${prefix}${g}`);
    site(`${prefix}${g}`);                                 // a real site, so the loopback lands somewhere
    guardianship(`${prefix}${g}`, 'guardian', local(wardSlug));
    return local(`${prefix}${g}`);
  });
  for (const g of guardians) guardianship(wardSlug, 'ward', g);
  return { wardSlug, wardSite, guardians, topology };
}

// Deliveries are recorded and then handed to the real deliverToActor, so a
// local recipient travels the same loopback the deployment uses. That is the
// point: the test drives the road production drives.
const sent = [];
G.wireHandshake({
  selfId: (slug) => local(slug),
  localSlug: (u) => (u && u.startsWith(`${BASE}/ap/users/`) ? u.split('/').pop() : null),
  deriveHandle: (u) => `@${String(u).split('/').pop()}`,
  fetchActor: async (u) => ({ id: u, inbox: `${u}/inbox` }),
  deliverTo: async (fromSite, toUri, activity) => {
    sent.push({ from: fromSite.slug, to: toUri, activity });
    return AP.deliverToActor(fromSite, toUri, activity);
  },
  onEvent: null,
});

/** What the ward's server holds about one gated decision. */
function gatedState(wardSlug, feature) {
  const votes = db.prepare('SELECT guardian_uri, value FROM ap_gated_votes WHERE slug = ? AND feature = ?')
    .all(wardSlug, feature);
  return {
    voted: votes.length,
    yes: votes.filter((v) => v.value === 1).length,
    setting: db.prepare('SELECT external_embeds FROM sites WHERE slug = ?').get(wardSlug).external_embeds,
  };
}

/**
 * Guardian A proposes link previews. The ward's server records A's own answer
 * (§3.1's one-step clause) and forwards to B and C. Then B agrees, and two of
 * three settles it.
 */
async function proposeAndSettle({ wardSlug, wardSite, guardians }) {
  const [A, B] = guardians;
  const offerId = `${A}/gated/1`;
  const offer = G.gated.buildGatedOffer(offerId, A, local(wardSlug), 'shaer:externalEmbeds', true);
  await G.handleGuardianshipInbox(wardSite, offer);
  const afterPropose = gatedState(wardSlug, 'shaer:externalEmbeds');
  await G.handleGuardianshipInbox(wardSite, { id: `${B}/accept/1`, type: 'Accept', actor: B, object: offerId });
  return { afterPropose, afterSecond: gatedState(wardSlug, 'shaer:externalEmbeds') };
}

const localRun = await proposeAndSettle(world('loc', 'local'));
const remoteRun = await proposeAndSettle(world('rem', 'remote'));

test('a gated decision reaches the same state whether the guardians are local or remote', () => {
  assert.deepEqual(localRun.afterPropose, remoteRun.afterPropose,
    'the tally after one proposal must not depend on where the guardians live');
  assert.deepEqual(localRun.afterSecond, remoteRun.afterSecond,
    'nor the outcome after the second answer');
  // And the shared state is the RIGHT one, so "identical" cannot be satisfied
  // by both sides being equally broken.
  assert.equal(localRun.afterPropose.voted, 1, 'one voice after the proposal');
  assert.equal(localRun.afterPropose.setting, null, 'one voice does not open a gate');
  assert.equal(localRun.afterSecond.setting, 1, 'two of three does');
  assert.equal(localRun.afterSecond.voted, 0, 'and the settled decision is cleared');
});

test('the other guardians are told, local ones no less than remote ones', () => {
  const fwd = sent.filter((x) => x.activity.object && x.activity.object['shaer:feature']);
  assert.equal(fwd.filter((x) => x.to.startsWith(BASE)).length, 2,
    'a guardian on this machine is forwarded to, not skipped for being nearby');
  assert.equal(fwd.filter((x) => !x.to.startsWith(BASE)).length, 2, 'and so is one elsewhere');
  for (const x of fwd) {
    // The forward is signed by the ward's key, so the body must name the ward.
    // Its absence is what made boiert.eu answer 401 to every forward.
    assert.match(x.activity.actor, /ward$/, 'the ward relays it under its own name');
    assert.ok(x.activity['shaer:proposer'], 'with the proposer carried alongside');
  }
});

test('a local guardian ends up with a review it can actually answer', () => {
  // The loopback is only worth having if it produces the same effect on the
  // receiving side as an HTTP delivery would: a stored proposal, on the
  // guardian's own dashboard.
  for (const g of ['a', 'b', 'c'].slice(1)) {
    const reviews = G.gated.listGatedReviews(`loc${g}`);
    assert.equal(reviews.length, 1, `guardian loc${g} holds the forwarded proposal`);
    assert.equal(reviews[0].feature, 'shaer:externalEmbeds');
    assert.equal(reviews[0].proposer, local('loca'), 'and can see who proposed it');
  }
});

// ── §3.6.1 away: the other activity that has to cross the same gap ──
// A guardian declaring itself away rides a direct note. Direct notes did NOT
// take the loopback: they resolved an inbox and POSTed to it, so a note to a
// ward on this machine went out to our own hostname and back, or nowhere. Two
// hand-written shortcuts existed to paper over it (one in the C2S outbox, one
// in the Guardian PWA route), which is the pattern this file is about.
const awaySite = site('awguard');
const awayWard = site('awward');
guardianship('awward', 'ward', local('awguard'));
guardianship('awguard', 'guardian', local('awward'));
const AWAY_UNTIL = Date.now() + 9 * 24 * 3600 * 1000;
const awayNote = await AP.deliverDirectNote(awaySite, {
  recipients: [local('awward')], text: 'even weg', awayUntil: AWAY_UNTIL,
});

test('a guardian on this machine can declare itself away to a ward on this machine', () => {
  assert.ok(awayNote && awayNote.id, 'the note was built');
  assert.equal(awayNote.delivered, 1, 'and it was delivered, not silently dropped for being local');
  assert.equal(G.availability.effective('awward', local('awguard'), Date.now()), 'away',
    'the ward server recorded the absence, through the inbox handler like anyone else');
});

test('the same note read from the wire produces the same state for a remote guardian', () => {
  // The body the loopback carried is the body an HTTP POST would carry, so
  // replaying it from a remote actor must land in exactly the same place. This
  // is what makes the two paths one path rather than two that agree today.
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(awayNote.id);
  const note = AP.buildReplyNote(BASE, awaySite, row);
  assert.equal(note['shaer:away'], true, 'shaer:away rides on the note itself (§3.6.1)');
  assert.ok(note.endTime, 'with an end: an absence without one is dropped, never guessed');

  const rw = site('awward2');
  const far = remote('farg');
  guardianship('awward2', 'ward', far);
  // The same note, re-addressed to the second ward and sent by a guardian
  // elsewhere: the mention tag is how a recipient recognises itself, so it
  // travels along. Nothing else about the body changes.
  const readdressed = JSON.parse(JSON.stringify(note).split(local('awward')).join(local('awward2')));
  const create = { type: 'Create', actor: far, to: [local('awward2')], object: { ...readdressed, id: `${note.id}#2`, attributedTo: far } };
  return AP.handleInbox(
    { body: create, ip: '1.2.3.4', protocol: 'https', get: () => 'test.example', headers: {} },
    rw.slug, { id: far },
  ).then(() => {
    assert.equal(G.availability.effective('awward2', far, Date.now()),
      G.availability.effective('awward', local('awguard'), Date.now()),
      'a remote guardian and a co-located one leave the ward in the same state');
  });
});

test('the loopback still checks the signer against the actor', async () => {
  // The loopback hands the inbox a verified signer instead of a signature. If
  // that were taken on faith, a local delivery would be the one place where a
  // forged actor passes. It is not: the same check runs.
  site('mmward'); const b = site('mmguard');
  const status = await AP.handleInbox(
    { body: { type: 'Offer', actor: local('someone-else'), object: {} }, ip: 'loopback', protocol: 'https', get: () => 'test.example', headers: {} },
    b.slug,
    { id: local('mmward') },              // signed as mmward, body claims someone else
  );
  assert.equal(status, 401, 'signer mismatch is refused on the loopback too');
});

test('no guardianship decision takes a shortcut for a local party', () => {
  // A guard, not a proof. Every place that asks "is this actor one of ours?"
  // must sit in a function that is allowed to ask: one that WRITES what this
  // instance hosts after a decision, or READS local state for display. Never
  // one that decides instead of delivering.
  //
  // Adding a name here should feel like a decision. If a new function needs a
  // local branch in a decision path, that is the bug, not this list.
  const allowed = {
    existingGuardiansOf: 'reads our own guardian list instead of fetching our own actor doc',
    candidateFitness: '§4.2: same question, same source — is this candidate a ward? Our table, not a self-fetch',
    applyCommitLocally: '§3.1.4: each instance writes the side of the commit it hosts',
    endGuardianship: '§3.2: same, for the ward side of the Undo, after the fanout',
    proposeGated: 'reads the tally back for the screen, after delivering',
    wardGuardianStatuses: 'availability of a ward we host: our own state, for our own screen',
    wardGateSetting: 'the gate of a ward we host: our own column, for our own screen',
    'route /wards/release-check': 'counts a ward\'s guardians: ours from the table, someone else\'s from their actor doc',
    // Known second path, NOT blessed: a gated follow reaches a co-located
    // guardian through the shared database instead of an Offer, and the answer
    // travels back the same way. Listed so this guard keeps passing while it
    // exists, not so it can be forgotten. Removing this line is the definition
    // of that job being done.
    wardSlugsOf: 'TODO: gated follows still take the shared-database path for a local guardian',
    // Tweede plek van diezelfde sluiproute, aangekomen met Fase 2 (shaer-jdb):
    // followsCollection vult de wachtrij voor een ward op DEZE instance uit
    // ap_pending_follows. Hoort mee te verdwijnen met wardSlugsOf hierboven --
    // niet apart, want het is een sluiproute en geen tweede probleem.
    slugOf: 'TODO: idem, nu ook in de follows-wachtrij (shaer-h6u)',
  };
  // De hele module, niet twee bestanden. Het commentaar hierboven zegt "elke
  // plek die vraagt of deze actor van ons is", en dat werd tot nu toe afgemeten
  // aan twee namen -- waardoor een nieuwe sluiproute in een DERDE bestand er
  // geruisloos doorheen kwam. Dat is precies hoe deze er kwam.
  const files = [
    ...fs.readdirSync('src/services/guardianship').filter((f) => f.endsWith('.js'))
      .map((f) => `src/services/guardianship/${f}`),
    'src/routes/guardian.js',
  ];
  // Only top-level declarations name a scope; an indented `const base = ...` is
  // a local and would otherwise take the blame for its enclosing function. A
  // route handler is an anonymous arrow, so it is named after its path.
  const declares = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\()/;
  const routes = /^router\.\w+\(\s*['"`]([^'"`]+)/;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let fn = '<top level>';
    for (const [i, line] of lines.entries()) {
      const d = line.match(declares);
      const r = line.match(routes);
      if (d) fn = d[1] || d[2];
      else if (r) fn = `route ${r[1]}`;
      // The idioms for "this URI is on this machine": ask the helper, or
      // compare the URI against our own base.
      if (!/localSlug\b|\.startsWith\(\s*(?:`\$\{base\}|base\b)/.test(line)) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;                 // a comment about it is fine
      assert.ok(allowed[fn], `${f}:${i + 1} branches on co-location inside ${fn}(), which is not on the list:\n    ${line.trim()}`);
    }
  }
});
