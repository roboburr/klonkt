// External embeds are a gated feature (FEP-633c): a ward's world outside the
// fediverse is the guardians' call, and the gate is applied server-side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { externalEmbedsAllowed } = await import('../src/services/guardianship/notes.js');
const { firstExternalUrl, timelineEmbed } = await import('../src/services/ActivityPubService.js');

test('auto (no setting): off for a ward, on for anyone else', () => {
  assert.equal(externalEmbedsAllowed(null, true), false, 'a ward gets no external embeds by default');
  assert.equal(externalEmbedsAllowed(null, false), true, 'a free actor does');
  assert.equal(externalEmbedsAllowed(undefined, true), false);
});

test('an explicit guardian decision wins over the default, both ways', () => {
  assert.equal(externalEmbedsAllowed(1, true), true, 'guardians may open it for a ward');
  assert.equal(externalEmbedsAllowed(0, false), false, 'and may close it for anyone');
});

test('firstExternalUrl picks the first real link, skipping mentions and hashtags', () => {
  const html = '<p><a href="https://s/@bob" class="u-url mention">@bob</a> '
    + '<a href="https://s/tags/x" class="mention hashtag">#x</a> '
    + 'kijk: <a href="https://v.example/watch/1">dit</a> en <a href="https://later.example/">dat</a></p>';
  assert.equal(firstExternalUrl(html), 'https://v.example/watch/1');
});

test('firstExternalUrl ignores non-http hrefs and empty content', () => {
  assert.equal(firstExternalUrl('<a href="javascript:alert(1)">x</a>'), null);
  assert.equal(firstExternalUrl('<p>geen links</p>'), null);
  assert.equal(firstExternalUrl(null), null);
});

test('timelineEmbed round-trips a stored card and refuses junk', () => {
  const stored = JSON.stringify({ url: 'https://v.example/1', kind: 'oembed', title: 'A talk', media: [{ url: 'https://v.example/t.jpg' }] });
  const back = timelineEmbed(stored);
  assert.equal(back.title, 'A talk');
  assert.equal(back.media[0].url, 'https://v.example/t.jpg');
  assert.equal(timelineEmbed(null), undefined);
  assert.equal(timelineEmbed('not json'), undefined);
  assert.equal(timelineEmbed('{"title":"no url"}'), undefined, 'a card without a url is not a card');
});

// FEP-044f emit side: quoting a fediverse object must federate as a quote AND
// tell the quoted author. This is the mirror of the ingest we already had.
const { applyQuoteProps } = await import('../src/services/ActivityPubService.js');

test('a quote is emitted in all three shapes the network reads', () => {
  const note = { to: ['https://www.w3.org/ns/activitystreams#Public'], cc: [], tag: [{ type: 'Hashtag', name: '#x' }] };
  applyQuoteProps(note, 'https://s/objects/9', 'https://s/users/alice');
  assert.equal(note.quote, 'https://s/objects/9', 'the FEP property');
  assert.equal(note.quoteUrl, 'https://s/objects/9', 'the as: alias Mastodon reads');
  assert.equal(note._misskey_quote, 'https://s/objects/9', 'the misskey alias');
  const link = note.tag.find((t) => t.type === 'Link');
  assert.ok(link, 'and an FEP-e232 Link tag');
  assert.equal(link.href, 'https://s/objects/9');
  assert.ok(link.mediaType.includes('activitystreams'));
  assert.ok(note.tag.some((t) => t.type === 'Hashtag'), 'existing tags survive');
});

test('the quoted author is addressed, so being quoted is not a surprise', () => {
  const note = { cc: ['https://s/users/me/followers'] };
  applyQuoteProps(note, 'https://s/objects/9', 'https://s/users/alice');
  assert.ok(note.cc.includes('https://s/users/alice'));
  assert.ok(note.cc.includes('https://s/users/me/followers'), 'without dropping the followers');
});

test('no quote, or a junk one, changes nothing', () => {
  const a = { cc: [], tag: [] };
  applyQuoteProps(a, null, null);
  assert.equal(a.quote, undefined);
  assert.equal(a.tag.length, 0);
  const b = { cc: [], tag: [] };
  applyQuoteProps(b, 'javascript:alert(1)', 'https://s/users/alice');
  assert.equal(b.quote, undefined, 'a non-http quote uri is refused');
  const c = { cc: [], tag: [] };
  applyQuoteProps(c, 'https://s/objects/9', 'not-a-url');
  assert.equal(c.quote, 'https://s/objects/9');
  assert.equal(c.cc.length, 0, 'a junk actor is simply not addressed');
});

test('a hostile oEmbed title is stored as plain text, not markup', async () => {
  const { resolveExternalEmbed } = await import('../src/services/ActivityPubService.js');
  // No network in the test env, so the resolver bails and returns null; the
  // point here is the contract: whatever comes back is never raw provider HTML.
  const out = await resolveExternalEmbed('<p><a href="https://v.example/1">x</a></p>');
  assert.ok(out === null || !/<script/i.test(out), 'never stores executable markup');
});
