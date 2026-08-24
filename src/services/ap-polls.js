/**
 * ap-polls.js — de peilingen (stap 8 van shaer-drc).
 *
 * Beide kanten van een fediverse-poll:
 *   - VREEMDE polls: parsePoll (het AS2 Question-formaat naar onze compacte
 *     vorm) en de twee stemhandelingen (voteOnPoll uit de tijdlijncache,
 *     voteOnRemotePoll op URL).
 *   - EIGEN polls: de definitie op posts.poll_json, de telling uit de
 *     stembiljetten (poll_votes), de Question-vorm op een note, het innemen
 *     van een biljet en de gebundelde Update(Question) naar de volgers.
 *
 * Vier werktuigen uit de dienstlaag komen via wirePolls binnen; de rest wijst
 * omlaag (db, ap-core, ap-transport).
 */
import db from '../config/database.js';
import { actorId, AP_CONTEXT } from './ap-core.js';
import { fetchActor, getOrCreateKeys, deliverWithRetry } from './ap-transport.js';

// De werktuigen uit de dienstlaag; ActivityPubService vult ze onderaan.
let deliverUpdate, rid, movedRefusal, actorUriOf;
export function wirePolls(deps) {
  ({ deliverUpdate, rid, movedRefusal, actorUriOf } = deps);
}

// Parse a fediverse poll (an ActivityStreams `Question` — the Mastodon-standard poll form)
// into our compact shape. `oneOf` = single choice, `anyOf` = multiple; each option is a Note
// with a `name` and a `replies` collection whose `totalItems` is that option's vote count.
export function parsePoll(o) {
  if (!o || o.type !== 'Question') return null;
  const raw = Array.isArray(o.oneOf) ? o.oneOf : (Array.isArray(o.anyOf) ? o.anyOf : null);
  if (!raw || !raw.length) return null;
  const options = raw.slice(0, 12).map((opt) => ({
    name: String((opt && opt.name) || '').slice(0, 300),
    count: Math.max(0, Number(opt && opt.replies && opt.replies.totalItems) || 0),
  })).filter((x) => x.name);
  if (!options.length) return null;
  const endTime = o.endTime || (typeof o.closed === 'string' ? o.closed : null);
  const closed = !!o.closed || (endTime ? Date.parse(endTime) <= Date.now() : false);
  return { multiple: Array.isArray(o.anyOf), options, endTime, closed, voters: Number(o.votersCount) || null, voted: null };
}

// ── Polls WE host (a local post with a poll) ──────────────────────
// Parse the poll definition stored on our own post (posts.poll_json). Counts are
// NOT stored here — they're derived from the poll_votes ballots so a re-render always
// reflects the authoritative tally.
export function parseOwnPoll(pollJson) {
  if (!pollJson) return null;
  let d; try { d = typeof pollJson === 'string' ? JSON.parse(pollJson) : pollJson; } catch { return null; }
  if (!d || !Array.isArray(d.options)) return null;
  const options = d.options.map((o) => ({ name: String((o && o.name != null ? o.name : o) || '').slice(0, 300) })).filter((o) => o.name);
  if (options.length < 2) return null;
  const endTime = d.endTime || null;
  const closed = !!d.closed || (endTime ? Date.parse(endTime) <= Date.now() : false);
  return { multiple: !!d.multiple, options, endTime, closed };
}

// Live tally of a hosted poll from its ballots: per-option counts + unique voters.
export function pollTally(postId) {
  const counts = {}; let voters = 0;
  try {
    for (const r of db.prepare('SELECT choice, COUNT(*) AS n FROM poll_votes WHERE post_id = ? GROUP BY choice').all(postId)) counts[r.choice] = r.n;
    voters = db.prepare('SELECT COUNT(DISTINCT actor_uri) AS n FROM poll_votes WHERE post_id = ?').get(postId).n || 0;
  } catch { /* table may not exist yet */ }
  return { counts, voters };
}

// Render-ready view of a hosted poll (options with counts + percentages, totals, state).
// Voting is fediverse-only, so this is display-only on the site.
export function ownPollView(post) {
  const poll = parseOwnPoll(post && post.poll_json);
  if (!poll) return null;
  const { counts, voters } = pollTally(post.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const denom = poll.multiple ? voters : total; // multiple-choice %: share of voters (can sum >100%)
  const options = poll.options.map((o) => {
    const count = counts[o.name] || 0;
    return { name: o.name, count, pct: denom ? Math.round((count / denom) * 100) : 0 };
  });
  return { multiple: poll.multiple, options, total, voters, endTime: poll.endTime, closed: poll.closed };
}

// Attach the AS2 Question shape to a note built for a hosted poll. Mastodon renders a
// status with either media OR a poll (never both), so a poll federates as content +
// options with no media attachment. oneOf = single choice, anyOf = multiple.
export function applyPollToNote(note, postId, poll) {
  const { counts, voters } = pollTally(postId);
  const opts = poll.options.map((o) => ({
    type: 'Note',
    name: o.name,
    replies: { type: 'Collection', totalItems: counts[o.name] || 0 },
  }));
  note.type = 'Question';
  note[poll.multiple ? 'anyOf' : 'oneOf'] = opts;
  if (poll.endTime) note.endTime = new Date(poll.endTime).toISOString();
  // Once closed, Mastodon expects a `closed` timestamp (the effective end).
  if (poll.closed) note.closed = poll.endTime ? new Date(poll.endTime).toISOString() : new Date().toISOString();
  note.votersCount = voters;
  delete note.attachment;   // media ATTACHMENTS + a poll are mutually exclusive on Mastodon
  // Keep note.image: it's the cover, which Mastodon ignores on a Question anyway
  // (same as on any Note) but Klonkt reads to show the cover in feeds/the Cirkel.
  // Deleting it stripped the cover off every boosted poll.
  return note;
}

// Record an inbound ballot on one of OUR polls. A vote arrives as a Create(Note) whose
// `name` is the chosen option and `inReplyTo` is our poll note — the Mastodon-standard
// vote form. Returns { handled } — handled=true means it was addressed to a poll (so the
// caller must NOT also store it as a reply), false means "not a poll, fall through".
export function recordPollBallot(postId, actorUri, rawChoice) {
  const choice = String(rawChoice == null ? '' : rawChoice).slice(0, 300);
  if (!choice) return { handled: false };
  let post; try { post = db.prepare('SELECT poll_json FROM posts WHERE id = ?').get(postId); } catch { return { handled: false }; }
  const poll = post && parseOwnPoll(post.poll_json);
  if (!poll) return { handled: false };               // not a poll → let the reply logic handle it
  if (poll.closed) return { handled: true };          // voting closed → drop
  if (!poll.options.some((o) => o.name === choice)) return { handled: true }; // unknown option → drop
  try {
    // Single choice = one ballot per actor: ignore a later/different vote. Multiple choice
    // allows one ballot per distinct option (the UNIQUE(post,actor,choice) dedupes repeats).
    if (!poll.multiple && db.prepare('SELECT 1 FROM poll_votes WHERE post_id = ? AND actor_uri = ? LIMIT 1').get(postId, actorUri)) return { handled: true };
    db.prepare('INSERT OR IGNORE INTO poll_votes (post_id, actor_uri, choice) VALUES (?, ?, ?)').run(postId, actorUri, choice);
  } catch { return { handled: true }; }
  schedulePollUpdate(postId);
  return { handled: true };
}

// Coalesce a burst of votes into ONE Update(Question) per poll: the first vote schedules a
// refresh ~15s out; further votes in that window ride the same pending update (which carries
// the accumulated tally). Non-follower voters re-fetch the Question (live tally) themselves.
const _pollUpdTimers = new Map();
function schedulePollUpdate(postId) {
  if (_pollUpdTimers.has(postId)) return;
  const t = setTimeout(() => { _pollUpdTimers.delete(postId); deliverPollUpdate(postId).catch(() => { /* best-effort */ }); }, 15000);
  if (t.unref) t.unref();
  _pollUpdTimers.set(postId, t);
}

// Push the fresh poll tally (or closed state) to followers as Update(Question).
export async function deliverPollUpdate(postId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !postId) return;
  let post, site;
  try {
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post || !post.poll_json) return;
    site = db.prepare('SELECT * FROM sites WHERE id = ?').get(post.site_id);
  } catch { return; }
  if (site) await deliverUpdate(site, post);
}

// Vote on a remote fediverse poll (a cached Question). A ballot = a Create(Note) carrying only a
// `name` (the chosen option) + inReplyTo the Question, addressed to the poll's author — the
// Mastodon-standard vote. Records our choice locally + optimistically bumps the counts; the
// author's Update(Question) refreshes the authoritative totals when it arrives.
export async function voteOnPoll(site, questionId, choices) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !questionId) return { error: 'config' };
  let row; try { row = db.prepare('SELECT author_uri, poll_json FROM ap_timeline WHERE id = ? AND slug = ? LIMIT 1').get(questionId, site.slug); } catch { /* ignore */ }
  if (!row || !row.poll_json) return { error: 'not_found' };
  let poll; try { poll = JSON.parse(row.poll_json); } catch { return { error: 'not_found' }; }
  if (poll.closed) return { error: 'closed' };
  if (poll.voted) return { error: 'already' };
  const valid = new Set(poll.options.map((o) => o.name));
  const picks = (Array.isArray(choices) ? choices : [choices]).map(String).filter((c) => valid.has(c));
  if (!picks.length) return { error: 'invalid' };
  const chosen = poll.multiple ? [...new Set(picks)] : [picks[0]];
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const authorUri = row.author_uri || null;
  const author = authorUri ? await fetchActor(authorUri).catch(() => null) : null;
  const inbox = author && (author.inbox || (author.endpoints && author.endpoints.sharedInbox));
  if (!inbox) return { error: 'unreachable' };
  for (const name of chosen) {
    const nid = `${me}/votes/${Date.now()}-${rid()}`;
    const note = { id: nid, type: 'Note', attributedTo: me, to: authorUri ? [authorUri] : [], name, inReplyTo: questionId, published: new Date().toISOString() };
    const create = { '@context': AP_CONTEXT, id: `${nid}/activity`, type: 'Create', actor: me, to: note.to, object: note };
    deliverWithRetry(site.slug, inbox, create, `${me}#main-key`, keys.private_pem);
  }
  // Local optimistic update (authoritative counts arrive via the author's Update(Question)).
  poll.voted = poll.multiple ? chosen : chosen[0];
  for (const o of poll.options) if (chosen.includes(o.name)) o.count = (o.count || 0) + 1;
  if (poll.voters != null) poll.voters += 1;
  try { db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(poll), questionId, site.slug); } catch { /* ignore */ }
  return { ok: true };
}

// Vote on ANY fediverse poll by URL (the interact page) — no timeline cache needed. Fetches
// the Question fresh, validates the choice(s), and casts the Mastodon-standard ballot (a
// Create(Note) with `name` + inReplyTo) straight to the poll's author. Used for polls you find
// by URL, not just ones from accounts you follow (which go through voteOnPoll via /news).
export async function voteOnRemotePoll(site, questionUrl, choices) {
  const _mv = movedRefusal(site, 'poll-vote'); if (_mv) return _mv;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !/^https?:\/\//i.test(String(questionUrl || ''))) return { error: 'config' };
  const q = await fetchActor(questionUrl).catch(() => null); // AP GET (SSRF-guarded)
  if (!q || q.type !== 'Question' || !q.id) return { error: 'not_found' };
  const poll = parsePoll(q);
  if (!poll) return { error: 'not_found' };
  if (poll.closed) return { error: 'closed' };
  const valid = new Set(poll.options.map((o) => o.name));
  const picks = (Array.isArray(choices) ? choices : [choices]).map(String).filter((c) => valid.has(c));
  if (!picks.length) return { error: 'invalid' };
  const chosen = poll.multiple ? [...new Set(picks)] : [picks[0]];
  const authorUri = actorUriOf(q.attributedTo);
  const author = authorUri ? await fetchActor(authorUri).catch(() => null) : null;
  const inbox = author && (author.inbox || (author.endpoints && author.endpoints.sharedInbox));
  if (!inbox) return { error: 'unreachable' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  for (const name of chosen) {
    const nid = `${me}/votes/${Date.now()}-${rid()}`;
    const note = { id: nid, type: 'Note', attributedTo: me, to: [authorUri], name, inReplyTo: q.id, published: new Date().toISOString() };
    const create = { '@context': AP_CONTEXT, id: `${nid}/activity`, type: 'Create', actor: me, to: note.to, object: note };
    deliverWithRetry(site.slug, inbox, create, `${me}#main-key`, keys.private_pem);
  }
  return { ok: true };
}
