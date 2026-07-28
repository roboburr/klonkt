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
