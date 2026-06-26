// Backfill missing Cirkel/timeline covers: re-fetch each coverless ap_timeline
// note (as ActivityPub) and pull its cover from the now-exposed `image` (or an
// image attachment). Run on a CONSUMER instance AFTER the publisher deployed the
// buildNote `image` fix:  cd ~/apps/<instance> && node scripts/backfill-cirkel-covers.mjs

import 'dotenv/config';
import db from '../src/config/database.js';

function hasImg(mj) {
  try { return JSON.parse(mj || '[]').some((m) => m.url && (!m.type || /image/i.test(m.type))); } catch { return false; }
}
async function fetchNote(url) {
  try { const r = await fetch(url, { headers: { Accept: 'application/activity+json' } }); if (r.ok) return await r.json(); } catch { /* skip */ }
  return null;
}
function coverFrom(note) {
  if (!note) return null;
  const atts = (Array.isArray(note.attachment) ? note.attachment : []).filter((a) => a && a.url && (/image/i.test(a.mediaType || '') || !a.mediaType));
  if (atts.length) return { url: atts[0].url, type: atts[0].mediaType || 'image/jpeg' };
  const im = Array.isArray(note.image) ? note.image[0] : note.image;
  const iu = im && (typeof im === 'string' ? im : im.url);
  if (iu) return { url: iu, type: (im && im.mediaType) || 'image/jpeg' };
  return null;
}

let rows = [];
try { rows = db.prepare('SELECT id, media_json FROM ap_timeline').all().filter((r) => !hasImg(r.media_json)); } catch { console.log('no ap_timeline'); process.exit(0); }
let fixed = 0;
for (const r of rows) {
  const cov = coverFrom(await fetchNote(r.id));
  if (!cov) continue;
  let arr = []; try { arr = JSON.parse(r.media_json || '[]'); } catch { /* reset */ }
  arr.push(cov);
  try { db.prepare('UPDATE ap_timeline SET media_json = ? WHERE id = ?').run(JSON.stringify(arr), r.id); fixed++; } catch { /* skip */ }
}
console.log(`backfilled ${fixed}/${rows.length} coverless timeline posts`);
process.exit(0);
