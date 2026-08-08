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
import { carriesGuardians } from './context.js';

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
export async function deliverDirectNote(site, { recipients, text, html, language, inReplyTo, attachments, helpRequest, wave, awayUntil, helpMark, gateRequest }) {
  const { actorId, fetchActor, localActor, deliverTo, deriveHandle, escHtml, linkUrls, linkHashtags,
          getOutboxRow, buildReplyNote, AP_CONTEXT, getOrCreateKeys, deliver, enqueueDelivery } = deps;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const list = [...new Set((recipients || []).filter((u) => /^https?:\/\//i.test(String(u || ''))))].slice(0, 8);
  if (!base || !site || !site.slug || !list.length || !String(text || '').trim()) return null;
  const me = actorId(base, site.slug);
  // Resolve every recipient for a mention anchor + a delivery inbox.
  const resolved = [];
  const teapots = [];
  for (const uri of list) {
    // An actor we host is read from our own database, not fetched from our own
    // hostname: that request has to leave the machine and come back, and when
    // it does not, the recipient is silently dropped from the note. Everything
    // that decides anything still runs below, for local and remote alike.
    const a = (localActor && localActor(uri)) || await fetchActor(uri).catch(() => null);
    if (!a || !(a.inbox || (a.endpoints && a.endpoints.sharedInbox))) continue;
    // FEP-633c §4.1: an escalation addressed to a "guardian" that carries
    // guardians of its own goes nowhere. There is no grand-guardian, so we
    // MUST NOT recurse to that actor's guardians — and we fail SOFTLY: drop
    // this one target and keep delivering to the rest, because a malformed
    // guardian must never cost a child the guardians who are fine.
    //
    // Only for a call for help. An ordinary direct note is not an escalation,
    // and a ward is perfectly entitled to message another ward.
    if (helpRequest && carriesGuardians(a)) { teapots.push(uri); continue; }
    resolved.push({ uri, inbox: (a.endpoints && a.endpoints.sharedInbox) || a.inbox, local: !!a.local, handle: deriveHandle(uri), url: a.url || uri });
  }
  if (teapots.length) console.warn('[AP] not a teapot: escalation dropped for malformed guardian(s)', teapots.join(', '));
  if (!resolved.length) {
    // Every guardian was malformed. §4 does not say what to do here because
    // §4.1 assumes there are others to continue to — but a ward whose whole
    // safety net is broken has just called for help into nothing, which is the
    // one outcome this FEP exists to prevent. Say so loudly; the caller can
    // tell "nobody was reachable" from "nobody was valid".
    if (teapots.length) console.error('[AP] EVERY guardian of', site.slug, 'is malformed: the call for help reached no one');
    return null;
  }
  const mention = resolved.map((r) => {
    const disp = r.handle && r.handle[0] === '@' ? r.handle : '@' + (r.handle || '');
    return `<a href="${escHtml(r.url)}" class="u-url mention" data-actor="${escHtml(r.uri)}">${escHtml(disp)}</a> `;
  }).join('');
  // Rijk antwoord: `html` is de HTML uit de reply-editor, hier gesaneerd; `text`
  // blijft de platte versie (het `source`-veld en de no-JS-fallback). Levert de
  // sanitizer niets bruikbaars op, dan valt hij terug op de escaped tekst --
  // een leeggepoetste editor mag geen leeg bericht versturen.
  const richClean = html ? deps.sanitizeHtml(String(html)) : '';
  const rich = richClean && deps.htmlToPlainText(richClean).trim() ? richClean : '';
  const body = escHtml(String(text).trim()).replace(/\r?\n/g, '<br>');
  // De mention-anker blijft een eigen alinea vooraan: de ontvanger moet in het
  // bericht genoemd staan, ook als de rijke inhoud met een kop of lijst begint.
  const content = rich
    ? `<p>${mention}</p>${linkUrls(linkHashtags(base, rich))}`
    : `<p>${mention}${linkUrls(linkHashtags(base, body))}</p>`;
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
  // Markering op een hulpvraag (shaer-lgo): een gewone directe note die er een
  // shaer:-eigenschap bij draagt, net als de zwaai. Zo reist het over dezelfde
  // bezorging, ziet de ward het als bericht ("er komt iemand"), en houden de
  // mede-guardians er staat aan over.
  if (helpMark && helpMark.noteUri) {
    note[helpMark.kind === 'handled' ? 'shaer:helpHandled' : 'shaer:helpPickup'] = helpMark.noteUri;
  }
  // Een kind dat zelf om een poort vraagt (shaer-8ru). Alleen de naam van de
  // feature reist mee -- geen vrije tekst, zie gatereq.js.
  if (gateRequest) note['shaer:gateRequest'] = String(gateRequest);
  const create = {
    '@context': AP_CONTEXT,
    id: note.id + '#create', type: 'Create', actor: me,
    published: note.published, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${me}#main-key`;
  let delivered = 0;
  // A recipient on this machine takes the loopback (deliverToActor), which
  // hands the Create to the same inbox handler an HTTP POST would reach: the
  // note is stored, the mention is stored, and a shaer:away on it is applied,
  // all by the code that does it for everyone else. A hairpin POST to our own
  // hostname is not that code path, it is a second one that only appears to be.
  for (const r of resolved.filter((x) => x.local)) {
    const res = await deliverTo(site, r.uri, create).catch(() => null);
    if (res && res.delivered) delivered++;
  }
  // Remote: one POST per inbox, so two guardians on the same server share it.
  for (const inbox of [...new Set(resolved.filter((x) => !x.local).map((r) => r.inbox))]) {
    let ok = false;
    try { const st = await deliver(inbox, create, keyId, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, create);
  }
  console.log('[AP] direct note', site.slug, '→', resolved.length, 'recipient(s), delivered', delivered);
  return { id, content, delivered, teapots };
}

export default { wireDelivery, c2sVisibility, deliverDirectNote };
