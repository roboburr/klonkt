// The Guardian PWA is built in the browser from a state blob, so the usual
// tests cannot reach it. These two failure modes bit during the rebuild and are
// cheap to guard: a renderer writing into a section that no longer exists, and
// a grouping key quietly dropped from a route so every panel comes up empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const client = read('../src/assets/js/guardian.js');
const page = read('../src/views/pages/guardian.ejs');
const route = read('../src/routes/guardian.js');

test('the client only touches element ids the page actually has', () => {
  // g-fatal is the exception: the crash banner is created by the client itself
  // (getElementById || createElement), precisely because the page may be too
  // broken to have it.
  const ids = new Set([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1])).add('g-fatal');
  const used = [...client.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `guardian.js writes into ${missing.join(', ')}, which the page does not have`);
});

test('the sections that moved into the panels are gone from the page', () => {
  for (const id of ['feed-section', 'follow-section', 'feed-list', 'follow-list']) {
    assert.ok(!page.includes(`id="${id}"`), `${id} moved into the per-ward panel and must not be a section of its own`);
  }
});

test('every panel section has something to group by', () => {
  // A child's panel is filled by matching these against the ward's actor URI.
  // Lose one and that section silently shows "nothing yet" for every child.
  assert.match(route, /authorUri: p\.author_uri/, "the wards' posts");
  assert.match(route, /wardUri: w\.uri/, 'follow requests on a local ward');
  assert.match(route, /wardUri: rev\.ward_uri/, 'follow requests forwarded from a remote ward');
  for (const key of ['authorUri', 'wardUri', 'actor_uri']) {
    assert.ok(client.includes(key), `the panel groups on ${key}`);
  }
});

test('the labels the panel renders are all served to it', () => {
  // uiStrings() picks the keys by hand, so a label used in the client but not
  // listed there renders as an empty string with no error anywhere. Two shapes
  // count as served: an entry in the keys array, and a direct s.foo = ...
  // assignment underneath it (wave/waved arrived that way).
  const served = new Set([
    ...[...route.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    ...[...route.matchAll(/\bs\.([a-z_]+)\s*=/g)].map((m) => m[1]),
  ]);
  const used = [...new Set([...client.matchAll(/T\.([a-z_]+)/g)].map((m) => m[1]))];
  const missing = used.filter((k) => !served.has(k));
  assert.deepEqual(missing, [], `uiStrings() does not serve: ${missing.join(', ')}`);
});
