// A Shaer detail-view Reply is followers-only: buildNote(isReply) with
// visibility 'friends' addresses the parent author + followers, but NOT Public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { buildNote } = await import('../src/services/ActivityPubService.js');

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const base = 'https://test.example';
const site = { slug: 'kid' };
const row = (visibility) => ({
  id: 'reply-1', in_reply_to: 'https://mastodon.social/@alice/1',
  content: '<p>hi</p>', to_actor: 'https://mastodon.social/users/alice', visibility,
});

test('followers-only reply: author in to, followers in cc, NO Public', () => {
  const note = buildNote(base, site, row('friends'), { isReply: true });
  assert.deepEqual(note.to, ['https://mastodon.social/users/alice']);
  assert.deepEqual(note.cc, [`${base}/ap/users/kid/followers`]);
  assert.ok(!note.cc.includes(PUBLIC));
  assert.equal(note.inReplyTo, 'https://mastodon.social/@alice/1');
});

test('default reply stays quiet-public: author in to, Public + followers in cc', () => {
  const note = buildNote(base, site, row(null), { isReply: true });
  assert.deepEqual(note.to, ['https://mastodon.social/users/alice']);
  assert.ok(note.cc.includes(PUBLIC));
  assert.ok(note.cc.includes(`${base}/ap/users/kid/followers`));
});

test('direct note addresses only its recipients (no Public/followers)', () => {
  const note = buildNote(base, site, {
    id: 'dm-1', content: '<p>x</p>', visibility: 'direct',
    to_actors: JSON.stringify(['https://s/u/bob']),
  }, { isReply: true });
  assert.deepEqual(note.to, ['https://s/u/bob']);
  assert.deepEqual(note.cc, []);
});
