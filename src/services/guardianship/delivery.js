/**
 * Guardianship (FEP-633c) — the direct-note delivery leg.
 *
 * A direct note (private mention, shaer-tqc) is the ward's call-for-help
 * carrier: addressed to specific actors only, no Public, no followers
 * fan-out. Moved here from ActivityPubService (guardianship refactor);
 * behavior is unchanged.
 *
 * This module has NO import back into ActivityPubService: the AP helpers it
 * needs (actor fetch, key material, delivery, note building) are provided
 * once via wireDelivery(deps) at ActivityPubService load time.
 */
import crypto from 'crypto';
import db from '../../config/database.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

let deps = null;
/** Called once by ActivityPubService with the shared AP helpers. */
export function wireDelivery(d) { deps = d; }

// Addressing → visibility. Arrays or bare strings; unknown shapes read as the
// safest bucket they match.
export function c2sVisibility(object) {
  const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');
  const to = arr(object.to), cc = arr(object.cc);
  const isPublic = (x) => x === PUBLIC || x === 'as:Public' || x === 'Public';
  const isFollowers = (x) => /\/followers\/?$/.test(x);
  if (to.some(isPublic)) return 'public';
  if (cc.some(isPublic)) return 'quiet';
  if (to.some(isFollowers) || cc.some(isFollowers)) return 'friends';
  if (!to.length && !cc.length) return 'public';   // no addressing at all: legacy client, keep old behavior
  return 'direct';
}

// A direct note: a NEW conversation (or a direct reply) addressed to specific
// actors only. Stored in ap_outbox with visibility 'direct' + the recipient
// list, delivered to exactly those inboxes: no followers fan-out, no Public,
// so no boosts and no timelines. The same S2S leg a Mastodon DM takes, so a
// guardian on any instance receives it as a private mention (the ward
// call-for-help path).
export async function deliverDirectNote(site, { recipients, text, language, inReplyTo, attachments, helpRequest, wave, awayUntil }) {
  const { actorId, fetchActor, deriveHandle, escHtml, linkUrls, linkHashtags,
          getOutboxRow, buildReplyNote, AP_CONTEXT, getOrCreateKeys, deliver, enqueueDelivery } = deps;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const list = [...new Set((recipients || []).filter((u) => /^https?:\/\//i.test(String(u || ''))))].slice(0, 8);
  if (!base || !site || !site.slug || !list.length || !String(text || '').trim()) return null;
  const me = actorId(base, site.slug);
  // Resolve every recipient for a mention anchor + a delivery inbox.
  const resolved = [];
  for (const uri of list) {
    const a = await fetchActor(uri).catch(() => null);
    if (!a || !(a.inbox || (a.endpoints && a.endpoints.sharedInbox))) continue;
    resolved.push({ uri, inbox: (a.endpoints && a.endpoints.sharedInbox) || a.inbox, handle: deriveHandle(uri), url: a.url || uri });
  }
  if (!resolved.length) return null;
  const mention = resolved.map((r) => {
    const disp = r.handle && r.handle[0] === '@' ? r.handle : '@' + (r.handle || '');
    return `<a href="${escHtml(r.url)}" class="u-url mention" data-actor="${escHtml(r.uri)}">${escHtml(disp)}</a> `;
  }).join('');
  const body = escHtml(String(text).trim()).replace(/\r?\n/g, '<br>');
  const content = `<p>${mention}${linkUrls(linkHashtags(base, body))}</p>`;
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9-]+)?$/.test(String(language || '')) ? language : null;
  // Attachments: same rules as deliverReply (own /media/ uploads only,
  // image/audio/video, max 4) — the help-buoy capture rides this.
  const media = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && typeof a.url === 'string' && /^\/media\/[\w./-]+$/.test(a.url)
      && /^(image|audio|video)\//.test(String(a.mediaType || '')))
    .slice(0, 4)
    .map((a) => ({ url: a.url, mediaType: String(a.mediaType), name: String(a.name || '').slice(0, 120) }));
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, language, attachments, visibility, to_actors, help_request, wave, away_until, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(id, site.slug, '', null, inReplyTo || null, resolved[0].uri, resolved[0].handle, content, lang, media.length ? JSON.stringify(media) : null, 'direct', JSON.stringify(resolved.map((r) => r.uri)), helpRequest ? 1 : 0, wave ? 1 : 0, awayUntil || null);
  const row = getOutboxRow(id);
  const note = buildReplyNote(base, site, row);
  const create = {
    '@context': AP_CONTEXT,
    id: note.id + '#create', type: 'Create', actor: me,
    published: note.published, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${me}#main-key`;
  let delivered = 0;
  for (const inbox of [...new Set(resolved.map((r) => r.inbox))]) {
    let ok = false;
    try { const st = await deliver(inbox, create, keyId, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, create);
  }
  console.log('[AP] direct note', site.slug, '→', resolved.length, 'recipient(s), delivered', delivered);
  return { id, content, delivered };
}

export default { wireDelivery, c2sVisibility, deliverDirectNote };
