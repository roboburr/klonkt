// NoteRender: web-side FEP-9098 emoji + FEP-044f quote rendering (mirrors Shaer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emojiMap, emojiHtml, emojiName, parseQuote, escapeHtml } from '../src/services/NoteRender.js';

test('emojiMap normalises both the tag-array and the map form', () => {
  const fromTags = emojiMap(JSON.stringify([{ type: 'Emoji', name: ':wave:', icon: { url: 'https://s/w.png' } }]));
  assert.equal(fromTags[':wave:'], 'https://s/w.png');
  const fromMap = emojiMap(JSON.stringify({ ':blob:': 'https://s/b.png' }));
  assert.equal(fromMap[':blob:'], 'https://s/b.png');
  assert.deepEqual(emojiMap(null), {});
  assert.deepEqual(emojiMap('not json'), {});
});

test('emojiHtml swaps known shortcodes for <img>, leaves tags/attributes/code alone', () => {
  const html = '<p>hi :wave: <a href="https://x/:wave:">link</a></p><code>:wave:</code>';
  const out = emojiHtml(html, JSON.stringify({ ':wave:': 'https://s/w.png' }));
  assert.ok(out.includes('<img class="emoji" src="https://s/w.png"'));   // text shortcode replaced
  assert.ok(out.includes('href="https://x/:wave:"'));                    // attribute untouched
  assert.ok(out.includes('<code>:wave:</code>'));                        // code untouched
  assert.equal((out.match(/<img /g) || []).length, 1);                   // only the text one
});

test('emojiHtml with no emojis returns the content unchanged', () => {
  assert.equal(emojiHtml('<p>plain</p>', null), '<p>plain</p>');
});

test('emojiName escapes the name then renders its emoji', () => {
  const out = emojiName('Laura :bongoCat: <b>', JSON.stringify({ ':bongoCat:': 'https://s/c.png' }));
  assert.ok(out.includes('&lt;b&gt;'));                    // HTML-escaped
  assert.ok(out.includes('<img class="emoji" src="https://s/c.png"'));
  assert.ok(!out.includes('Laura :bongoCat:'));            // literal shortcode consumed (still in alt=)
});

test('emojiName without emojis just escapes', () => {
  assert.equal(emojiName('A & B <x>', null), 'A &amp; B &lt;x&gt;');
});

test('escapeHtml escapes the five entities', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('parseQuote returns the object only with a url', () => {
  assert.equal(parseQuote(JSON.stringify({ url: 'https://s/q', author: { name: 'A' } })).url, 'https://s/q');
  assert.equal(parseQuote(JSON.stringify({ author: { name: 'A' } })), null);   // no url
  assert.equal(parseQuote(null), null);
  assert.equal(parseQuote('nope'), null);
});
