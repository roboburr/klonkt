// YouTube-playlists in een post (Bart, 17-8): dezelfde parsing als de Klonkt
// hub, zodat een link naar een album ook als album speelt.
//
// Tot nu toe hield detectProvider alleen de video-id vast en gooide `list=`
// weg, en een kale `youtube.com/playlist?list=…` herkende hij niet als YouTube.
// Een link naar een album speelde daarmee het eerste nummer en stopte.
//
// De ref kent drie vormen, gelijk aan die van de hub, zodat één ref tussen de
// twee heen en weer kan zonder vertaling:
//   "<video>" | "<video>?list=<L>" | "list:<L>"
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { default: AudioEmbedService } = await import('../src/services/AudioEmbedService.js');
const det = (u) => AudioEmbedService.detectProvider(u);

test('een gewone video blijft precies wat hij was', () => {
  const r = det('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(r.provider, 'youtube');
  assert.equal(r.id, 'dQw4w9WgXcQ');
  assert.equal(r.list, null);
  assert.equal(r.ref, 'dQw4w9WgXcQ');
});

test('een video BINNEN een playlist houdt allebei', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123def456',
    'https://www.youtube.com/watch?list=PLabc123def456&v=dQw4w9WgXcQ',   // andere volgorde
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;list=PLabc123def456', // uit een gebakken href
    'https://youtu.be/dQw4w9WgXcQ?list=PLabc123def456',
  ]) {
    const r = det(u);
    assert.equal(r.ref, 'dQw4w9WgXcQ?list=PLabc123def456', u);
    assert.equal(r.id, 'dQw4w9WgXcQ', u);
    assert.equal(r.list, 'PLabc123def456', u);
  }
});

test('een kale playlist wordt herkend, en heeft geen video', () => {
  const r = det('https://www.youtube.com/playlist?list=PLabc123def456');
  assert.equal(r.provider, 'youtube');
  assert.equal(r.id, null);
  assert.equal(r.ref, 'list:PLabc123def456');
});

// Dit is de val: `videoseries` is EXACT elf tekens, net als een video-id. Geen
// enkele lengteregel vangt hem; hij moet bij naam genoemd worden. Ik liep er bij
// het bouwen zelf in, met een grenscontrole die eroverheen leek te gaan.
test('videoseries is een markering, geen video-id', () => {
  for (const u of [
    'https://www.youtube.com/embed/videoseries?list=PLabc123def456',
    'https://www.youtube-nocookie.com/embed/videoseries?list=PLabc123def456',  // wat een embed zelf uitzendt
  ]) {
    const r = det(u);
    assert.ok(r, u);
    assert.equal(r.id, null, 'videoseries mag nooit als video-id doorgaan: ' + u);
    assert.equal(r.ref, 'list:PLabc123def456', u);
  }
});

test('een link zonder video en zonder lijst levert niets op', () => {
  assert.equal(det('https://www.youtube.com/watch?x=1'), null);
  assert.equal(det('javascript:alert(1)//youtu.be/dQw4w9WgXcQ'), null, 'het schema-slot blijft dicht');
});

test('de placeholder draagt de ref, niet alleen de video', () => {
  const html = AudioEmbedService.generateIframe('youtube', det('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123def456'));
  assert.match(html, /data-embed-ref="dQw4w9WgXcQ\?list=PLabc123def456"/);
  const kaal = AudioEmbedService.generateIframe('youtube', det('https://www.youtube.com/playlist?list=PLabc123def456'));
  assert.match(kaal, /data-embed-ref="list:PLabc123def456"/);
});

test('de iframe-terugval laat de playlist niet stilletjes vallen', () => {
  assert.match(AudioEmbedService.youtubeIframe({ ref: 'list:PLabc123def456' }),
    /embed\/videoseries\?list=PLabc123def456/);
  assert.match(AudioEmbedService.youtubeIframe({ ref: 'dQw4w9WgXcQ?list=PLabc123def456' }),
    /embed\/dQw4w9WgXcQ\?list=PLabc123def456/);
  assert.match(AudioEmbedService.youtubeIframe({ id: 'dQw4w9WgXcQ' }), /embed\/dQw4w9WgXcQ"/);
});
