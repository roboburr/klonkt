// One-time migration: convert the old Cirkels (pull-protocol circle_links) into
// ActivityPub follows with auto-boost ("feature an artist"). Run per instance:
//   cd ~/apps/<instance> && node scripts/migrate-circles.mjs
// Idempotent: followActor upserts ap_following, so re-running is safe.

import 'dotenv/config';
import db from '../src/config/database.js';
import ActivityPubService from '../src/services/ActivityPubService.js';

// A Klonkt site's AP actor is reachable from its root via content negotiation:
// an AP-Accept GET on the root 302s to /ap/users/<slug>.
async function resolveActor(siteUrl) {
  try {
    const r = await fetch(siteUrl, { headers: { Accept: 'application/activity+json' }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (loc) return loc; }
    if (r.ok) return siteUrl; // root already serves the actor
  } catch (e) { /* unreachable */ }
  return null;
}

let links = [];
try {
  links = db.prepare(`
    SELECT cl.remote_url AS url, s.id AS sid, s.slug AS slug
    FROM circle_links cl JOIN sites s ON s.id = cl.local_site_id
    WHERE cl.status = 'active'
  `).all();
} catch (e) { console.log('no circle_links table — nothing to migrate'); process.exit(0); }

if (!links.length) { console.log('no active circle_links — nothing to migrate'); process.exit(0); }

for (const l of links) {
  const actor = await resolveActor(l.url);
  if (!actor) { console.log(`SKIP ${l.slug} -> ${l.url} (actor unresolvable)`); continue; }
  try {
    const r = await ActivityPubService.followActor({ id: l.sid, slug: l.slug }, actor, true);
    console.log(`${l.slug} -> ${actor} : ${r && r.error ? 'ERR ' + r.error : 'OK (auto-boost)'}`);
  } catch (e) {
    console.log(`${l.slug} -> ${actor} : EXC ${e.message}`);
  }
}
process.exit(0);
