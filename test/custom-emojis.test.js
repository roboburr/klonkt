// FEP-9098: Klonkt keeps inbound custom-emoji tags and serves them on the C2S inbox read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { extractEmojiTags, timelineEmojis } = await import('../src/services/ActivityPubService.js');
const AP = { extractEmojiTags, timelineEmojis };

test('extractEmojiTags keeps only Emoji tags; timelineEmojis round-trips', () => {
  const tag = [
    { type: 'Mention', href: 'https://s/u/x' },
    { type: 'Emoji', name: ':wave:', icon: { type: 'Image', url: 'https://s/wave.png' } },
    { type: 'Hashtag', name: '#hi' },
  ];
  const json = AP.extractEmojiTags(tag);
  assert.ok(json);
  const back = AP.timelineEmojis(json);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, ':wave:');
  assert.equal(back[0].icon.url, 'https://s/wave.png');
});

test('no emojis → null / undefined (nothing served)', () => {
  assert.equal(AP.extractEmojiTags([{ type: 'Mention' }]), null);
  assert.equal(AP.timelineEmojis(null), undefined);
  assert.equal(AP.timelineEmojis('not json'), undefined);
});
