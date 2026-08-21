/**
 * The Guardian PWA (FEP-633c): a separate, installable corner of Klonkt for
 * guardians. One place to add and manage wards, a message centre for
 * incoming help requests and adoption traffic, and its own push channel
 * (alert types 'help' and 'guardian', web-push slice reused).
 *
 * Everything is scoped to a site the logged-in user OWNS: the guardian acts
 * as one of their own actors (?site=slug picks one when they own several).
 * Views carry no inline scripts (CSP): logic lives in /assets/js/guardian.js.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import AP from '../services/ActivityPubService.js';
import * as Guardianship from '../services/guardianship/index.js';
import { t as i18nT, resolveLang } from '../services/i18n.js';
import { injectCspNonce, renderNoteBody, formatDateTime } from '../middleware/render.js';
import { emojiName } from '../services/NoteRender.js';

const router = express.Router();
const __dir = path.dirname(fileURLToPath(import.meta.url));

/** The acting site: ?site=slug when owned, else the user's first site. */
function siteForUser(req) {
  const userId = req.session.user.id;
  const want = String(req.query.site || req.body?.site || '').trim();
  if (want) {
    const s = db.prepare('SELECT * FROM sites WHERE slug = ? AND owner_id = ?').get(want, userId);
    if (s) return s;
  }
  return db.prepare('SELECT * FROM sites WHERE owner_id = ? ORDER BY id LIMIT 1').get(userId);
}

/** Everything the dashboard shows, one shape for page and API. */
function uiStrings(L) {
  const keys = ['sent', 'sent_retry', 'sending', 'not_found', 'failed', 'network',
    'pending', 'active', 'retract', 'release', 'release_confirm', 'open', 'push_unavailable',
    'embeds_on', 'embeds_off', 'embeds_propose', 'embeds_waiting',
    'accept', 'reject', 'complete', 'awaiting_others', 'coguard',
    // The per-ward panel: everything about one child in one place.
    'settings_title', 'panel_open', 'panel_close', 'panel_help', 'panel_help_empty',
    'panel_follow', 'panel_follow_empty', 'follow_out_line', 'panel_posts', 'panel_posts_empty',
    'panel_actions', 'badge_help', 'badge_follow', 'badge_follow_one', 'help_empty',
    // Releasing a ward: a deliberate two-step answer, never one click.
    'release_title', 'release_effect', 'release_local', 'release_step_down',
    'release_last', 'release_unknown', 'release_yes', 'release_no',
    // Availability (FEP-633c 3.6): the dots, the step-away, the lapse.
    'avail_available', 'avail_away', 'avail_dormant', 'panel_guards', 'panel_guards_remote',
    'lapse_propose', 'lapse_line', 'lapse_tally', 'lapse_note', 'lapse_agree', 'lapse_disagree', 'voted',
    'away_title', 'away_sub', 'away_week', 'away_month', 'away_done',
    // A gated-setting proposal from a fellow guardian (5.6).
    'gated_title', 'gated_line_on', 'gated_line_off', 'gated_agree', 'gated_disagree',
    'play_propose', 'play_on', 'play_off',
    // The status of a proposal this guardian sent (5.6).
    'prop_line', 'prop_embeds', 'prop_play', 'prop_on', 'prop_off',
    'prop_st_open', 'prop_st_accepted', 'prop_st_rejected', 'prop_st_expired',
    'panel_guards_far',
    // Het gate-paneel per ward (shaer-ahy.1): een rij per gate, met het soort en
    // de drempel erbij. De namen volgen de catalogus in gated.js.
    'gate_externalEmbeds', 'gate_externalPlayback', 'gate_externalThreads',
    // De twee richtingen van §5.3, met woorden die niet op elkaar lijken:
    // "Volgverzoeken" komt naar het kind toe, "Zelf iemand volgen" gaat ervan
    // weg. Zonder dat verschil in de tekst zijn de rijen niet uit elkaar te
    // houden zodra ze naast elkaar staan (shaer-p729).
    'gate_follows', 'gate_following',
    'gate_kind_setting', 'gate_kind_perRequest', 'gate_kind_handover',
    'gate_unknown', 'gate_always', 'gate_threshold', 'gate_threshold_unknown',
    'gate_irreversible', 'gate_waiting', 'gate_blocked', 'gate_propose',
    // Oppikken en afhandelen van een hulpvraag (shaer-lgo).
    'help_pick', 'help_close', 'help_picked_by', 'help_handled_by', 'help_handled_note',
    'help_close_ask', 'help_close_yes', 'help_just_now', 'help_hours', 'help_days', 'help_former_ward',
  'warn_reversible', 'warn_irreversible', 'warn_unknown', 'warn_tally_elsewhere', 'warn_decides', 'warn_not_last', 'warn_go', 'warn_back',
    'help_archive', 'help_archive_hide', 'panel_history',
    // Het logboek (§4.2): onbekende soorten vallen terug op hun ruwe naam.
    'log_show', 'log_hide', 'evr_not_a_teapot',
    'ev_offer_rejected', 'ev_offer_refused', 'ev_committed', 'ev_guardian_left',
    'ev_coguardian_left', 'ev_gated_outcome', 'ev_lapse_opened',
    'gate_propose_open', 'gate_propose_close', 'gate_default_off',
    'gate_images', 'gate_messages', 'gate_compose', 'gate_replies', 'gate_music', 'gate_quoteCards', 'gate_asked',
    'gate_customEmoji', 'gate_publicProfile', 'gate_accountMove', 'gate_independence',
    'gate_unavailable', 'gate_planned_note', 'gates_summary', 'gates_show', 'gates_hide'];
  const s = Object.fromEntries(keys.map((k) => [k, i18nT(L, `guardian.${k}`)]));
  s.wave = i18nT(L, 'guardian.wave');
  s.waved = i18nT(L, 'guardian.waved');
  return s;
}

function dashboardState(site, L) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  // EEN weg naar de hulpvragen (Barts 429-jacht, 9-8): dit scherm had een
  // eigen kopie van de queue-query, met een afkap op 50 -- dus de fix die open
  // vragen nooit meer afkapt (shaer-6wt) ging aan het paneel voorbij, en juist
  // de guardian met een caseload zag oude open vragen wegvallen. Nu dezelfde
  // bron als de apps: open vragen volledig, geschiedenis afgekapt.
  const helpItems = Guardianship.queues.helpItemsFor(site.slug).map((h) => ({
    ...h,
    // The dashboard is built in the browser, so it gets the body finished: the
    // same partial de Krant and Berichten use. A 🛟 often carries a screenshot
    // and a link to the post it is about; both belong in the card.
    body_html: renderNoteBody(h, L),
    name_html: emojiName(h.actor_name || '', h.actor_emoji_json),
    // In the site's own timezone, the same as everywhere else in Klonkt. The
    // PWA used to slice the raw UTC string, so a 20:20 call for help read 18:20.
    when_text: formatDateTime(h.published || h.created_at),
  }));
  return {
    site: site.slug,
    me,
    // Committed wards, each carrying the gated settings a guardian may change.
    // `embeds` is null for a ward we do not host: that setting lives on the
    // ward's own server, so we show it as not-adjustable rather than lying.
    // `guardians` (FEP-633c 3.6): the fellow guardians of a LOCAL ward with
    // their availability; null for a remote ward, whose server tracks it.
    wards: Guardianship.listWards(site.slug).map((w) => ({
      ...w,
      embeds: wardEmbedSetting(w.other_uri),
      playback: wardPlaybackSetting(w.other_uri),
      guardians: Guardianship.queues.wardGuardianStatuses(w.other_uri),
      // What THIS guardian proposed for this ward and how it stands (5.6):
      // open, accepted, rejected, or expired when the window ran out and the
      // ward's server had nothing to write home. The answer is a real
      // Accept/Reject from the ward's server, not a guess from here.
      proposals: Guardianship.gated.listSent(site.slug, w.other_uri).map((p) => ({
        feature: p.feature, value: !!p.value, created: p.created_at,
        status: Guardianship.gated.sentStatus(p, Date.now()),
      })),
      // Alles wat voor dit kind gated is op EEN plek, met per gate het soort en
      // de drempel (shaer-ahy.1). Losse knoppen lieten een guardian zelf
      // uitzoeken wat er allemaal geldt; wat niet verstelbaar is stond nergens.
      gates: Guardianship.queues.wardGates(site.slug, w.other_uri),
    })),
    offers: Guardianship.offersCollection(`${me}/queues/offers`, site.slug, me).orderedItems,
    // Running lapses (3.6.3) this guardian or its local wards are party to.
    lapses: Guardianship.availability.lapseQueueItems(site.slug, me, Date.now()),
    // Gated-setting proposals another guardian opened on a ward we share
    // (5.6), forwarded here by the ward's server. Without answering these the
    // threshold is never met and the proposal simply expires.
    gatedReviews: Guardianship.gated.listGatedReviews(site.slug).map((r) => ({
      id: r.id, ward: r.ward_uri, proposer: r.proposer, feature: r.feature, value: !!r.value,
      // Wat er blijft hangen als dit doorgaat (shaer-nf9). Alleen bij OPENZETTEN:
      // dichtzetten laat niets nieuws door en hoeft dus niet gewaarschuwd te
      // worden -- een waarschuwing die overal staat wordt nergens gelezen.
      consequence: r.value ? Guardianship.gated.gateConsequence(r.feature) : null,
      // Maakt JOUW antwoord dit af (shaer-8vt)? De telling loopt op de server van
      // het kind, dus dit is het enige wat we erover weten -- en zonder dat
      // weet niemand dat hij de doorslag geeft.
      decisive: r.decisive !== 0,
    })),
    help: helpItems,
    strings: uiStrings(L),
  };
}


// ── The PWA page ─────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const site = siteForUser(req);
  const L = resolveLang(req);
  if (!site) return res.status(404).send('No site for this account.');
  const sites = db.prepare('SELECT slug, title FROM sites WHERE owner_id = ? ORDER BY id').all(req.session.user.id);
  // This standalone PWA page is rendered directly (not through renderPage), so
  // the CSP nonce must be injected here — otherwise strict-dynamic blocks
  // guardian.js and the whole dashboard is dead (buttons do nothing).
  res.render('pages/guardian', {
    state: dashboardState(site, L),
    sites,
    lang: L,
    t: (k, v) => i18nT(L, k, v),
    cspNonce: res.locals.cspNonce,
  }, (err, html) => {
    if (err) { console.error('[guardian] render error', err); return res.status(500).send('Internal Server Error'); }
    res.send(injectCspNonce(html, res.locals.cspNonce));
  });
});

// ── JSON state for refreshes ─────────────────────────────────────────────
/**
 * De staat van het paneel, desgewenst als LANGE POLL (Barts opdracht, 9-8).
 *
 * Zonder `wait` gedraagt de route zich exact zoals altijd. Met `wait` blijft het
 * antwoord hangen tot er iets gebeurt dat de guardian moet verwerken, of tot de
 * tijd om is -- dan een lege 304.
 *
 * EERST KIJKEN, DAN WACHTEN. Veranderde er iets tussen het vorige antwoord en
 * dit verzoek, dan is de merksteen nu al anders en gaat het antwoord METEEN de
 * deur uit. Zou je eerst gaan wachten, dan blijft nieuws dat net in dat gaatje
 * viel vijfentwintig seconden liggen -- en juist bij een hulpvraag is dat de
 * verkeerde vertraging.
 *
 * WAKKER OP ALLES. De guardianship-module zendt veertien soorten gebeurtenissen
 * uit en die wekken allemaal (wakeGuardian); daarnaast wekt de tijdlijn (onNews),
 * want de berichten van je wards staan in ditzelfde scherm.
 */
router.get('/api/state', requireAuth, async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const stuur = () => AP.sendMaybe304(req, res, dashboardState(site, resolveLang(req)), { contentType: 'application/json' });

  const wachtS = Math.min(Math.max(parseInt(req.query.wait, 10) || 0, 0), 50);
  const merk = req.headers['if-none-match'];
  if (!wachtS || !merk) return stuur();

  // Is er nu al iets anders? Dan niet wachten.
  const nu = AP.etagFor(JSON.stringify(dashboardState(site, resolveLang(req))));
  if (nu !== merk) return stuur();

  await new Promise((klaar) => {
    let af = false;
    const eind = () => { if (af) return; af = true; clearTimeout(t); offG(); offN(); klaar(); };
    const offG = AP.onGuardian(site.slug, eind);
    const offN = AP.onNews(site.slug, eind);
    const t = setTimeout(eind, wachtS * 1000);
    // Hing de client op, dan houdt niemand dit antwoord meer vast.
    res.on('close', eind);
  });
  if (res.writableEnded) return undefined;
  return stuur();
});

// ── Meekijken (FEP-633c §5, interop-hoofdroute): a committed guardian FOLLOWS
//    its wards, so their posts (incl. followers-only) are DELIVERED to the
//    guardian's inbox → timeline. The follow is the mechanism; no new fetch.
//    First contact also backfills the ward's recent PUBLIC posts as a cold
//    start so the corner is not empty before delivery catches up.
function ensureWardConnections(site) {
  let wards;
  try { wards = Guardianship.listWards(site.slug); } catch { return; }
  for (const w of wards) {
    const already = db.prepare('SELECT 1 FROM ap_following WHERE slug = ? AND actor_uri = ?')
      .get(site.slug, w.other_uri);
    if (already) continue;
    // Follow (guardian's server auto-accepts today; §5.3 gating is a later fase).
    AP.followActor(site, w.other_uri).catch(() => { /* retried by the queue */ });
    // Cold start: pull recent public posts now so oma sees something at once.
    AP.backfillFromOutbox(site.slug, w.other_uri).catch(() => { /* best-effort */ });
  }
}

// ── The wards' corner: your wards' posts, read-only. No reply, no share; a
//    guardian watches, it does not publish (Robins besluit).
router.get('/api/feed', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const L = resolveLang(req);
  ensureWardConnections(site);
  const wardUris = new Set(Guardianship.listWards(site.slug).map((w) => w.other_uri));
  // Only show the wards you actually guard (the timeline can hold more).
  const items = AP.getTimeline(site.slug, 60, 0)
    .filter((p) => wardUris.has(p.author_uri))
    .map((p) => ({
      id: p.id,
      author: p.author_handle || p.author_name || p.author_uri,
      authorUri: p.author_uri,   // the grouping key: which child's panel this belongs in
      authorName: p.author_name,
      authorIcon: p.author_icon,
      content: p.content,
      url: p.url,
      published: p.published || p.created_at,
      when_text: formatDateTime(p.published || p.created_at),
      cw: p.cw || null,
      // Zelfde valkuil als in note-body.ejs: kapotte json gooit, maar geldige json
      // van het verkeerde type niet. Zonder deze wacht neemt één vreemde note van
      // een remote server het hele guardian-paneel mee, en dat is precies het
      // scherm dat het moet doen als er iets aan de hand is.
      media: (() => { try { const m = JSON.parse(p.media_json || '[]'); return Array.isArray(m) ? m : []; } catch { return []; } })(),
      // Een post van je ward hoort er hetzelfde uit te zien als in de Krant en
      // in Berichten: dezelfde partial, dus opmaak, media, quote-kaart en
      // embed. Tot nu toe kreeg de PWA alleen kale content -- een guardian zag
      // een lege regel waar een foto stond. `content` blijft ernaast staan voor
      // een client die nog uit de cache draait.
      body_html: renderNoteBody(p, L),
    }));
  res.json({ items, following: wardUris.size });
});

// ── Follow-gating (FEP-633c §5.3): pending follows on MY wards, for me to
//    approve. Ward and guardian are co-located on the family Klonkt here, so
//    the guardian reads its wards' pending follows locally.
function wardSlugsOf(site) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return Guardianship.listWards(site.slug)
    .map((w) => (w.other_uri.startsWith(base) ? { slug: w.other_uri.split('/').pop(), uri: w.other_uri } : null))
    .filter(Boolean);
}

router.get('/api/follow-requests', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const items = [];
  const host = (() => { try { return new URL(process.env.PUBLIC_BASE_URL || '').host; } catch { return ''; } })();
  // wardUri is the grouping key for the per-ward panel: the handle is for
  // reading, the URI is what identifies the child across both cases below.
  // Local wards (guardian co-located): read the pending follows directly.
  for (const w of wardSlugsOf(site)) {
    for (const f of Guardianship.follows.listForWard(w.slug)) {
      items.push({ id: f.id, direction: 'incoming', ward: `@${w.slug}@${host}`, wardUri: w.uri, follower: f.follower_handle || f.follower_name || f.follower_uri, followerIcon: f.follower_icon, remote: false, created: f.created_at });
    }
    // §5.3 andersom (shaer-p729): wat dit kind zelf heeft gevraagd. Stond hier
    // niet, dus een guardian met een LOKALE ward zag uitgaande verzoeken in de
    // PWA helemaal niet -- ze wachtten op iemand die er nooit naar keek.
    for (const o of Guardianship.outgoing.listForWard(w.slug)) {
      items.push({ id: o.id, direction: 'outgoing', ward: `@${w.slug}@${host}`, wardUri: w.uri, target: o.target_handle || o.target_uri, remote: false, created: o.created_at });
    }
  }
  // Remote wards: the copies forwarded here as Offer(Follow) (cross-instance).
  for (const rev of Guardianship.follows.listReviews(site.slug)) {
    const wardName = (() => { try { const u = new URL(rev.ward_uri); return `@${u.pathname.split('/').pop()}@${u.host}`; } catch { return rev.ward_uri; } })();
    // De richting stond in de tabel en werd hier weggelaten. Zonder haar leest
    // een uitgaand verzoek als een inkomend: de follower IS dan de ward, dus de
    // kaart zei "je kind wil je kind volgen" en het doel viel weg.
    const uitgaand = rev.direction === 'outgoing';
    items.push({
      id: rev.id, direction: uitgaand ? 'outgoing' : 'incoming',
      ward: wardName, wardUri: rev.ward_uri,
      follower: uitgaand ? undefined : (rev.follower_handle || rev.follower_uri),
      target: uitgaand ? (rev.target_handle || rev.target_uri) : undefined,
      followerIcon: uitgaand ? undefined : rev.follower_icon,
      remote: true, created: rev.created_at,
    });
  }
  res.json({ items });
});

// Het logboek (§4.2): wat er is gebeurd, met de reden erbij. GEEN wachtrij --
// hier staat niets dat om een antwoord vraagt, en daarom hoort het ingeklapt.
// Het bestaat omdat een weigering anders alleen te merken was doordat er iets
// uit een lijst verdween, en "het is weg" vertelt een ward niet waarom.
router.get('/api/events', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  res.json({ items: AP.listGuardianEvents(site.slug, 50) });
});

router.post('/api/follow/:id', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';

  // Remote ward: a forwarded copy. Send my Accept/Reject back to the ward,
  // which tallies quorum and returns the Accept(Follow) to the follower.
  const review = Guardianship.follows.getReview(site.slug, req.params.id);
  if (review) {
    try { await AP.sendFollowDecision(site, review, decision); }
    catch { return res.status(502).json({ error: 'delivery' }); }
    Guardianship.follows.removeReview(site.slug, req.params.id);
    return res.json({ ok: true, outcome: decision === 'reject' ? 'rejected' : 'sent' });
  }

  // Local ward: decide directly (quorum on this instance).
  const pending = Guardianship.follows.getPending(req.params.id);
  if (!pending) return res.status(404).json({ error: 'gone' });
  const allGuardians = Guardianship.listGuardians(pending.ward_slug).map((g) => g.other_uri);
  if (!allGuardians.includes(me)) return res.status(403).json({ error: 'not_a_guardian' });
  // Acting from the dashboard is an answer (3.6), and the quorum runs over
  // the available set (3.5): both applied here, the same as over the wire.
  Guardianship.availability.oneAnswer(me, Date.now());
  const guardians = Guardianship.availability.availableSet(pending.ward_slug, allGuardians, Date.now());
  const r = Guardianship.follows.decide(pending.id, me, decision, guardians);
  try {
    if (r.outcome === 'approved') { await AP.acceptGatedFollow(r.follow); Guardianship.follows.remove(r.follow.id); }
    else if (r.outcome === 'rejected') { await AP.rejectGatedFollow(r.follow); Guardianship.follows.remove(r.follow.id); }
  } catch (e) { return res.status(502).json({ error: 'delivery', outcome: r.outcome }); }
  res.json({ ok: true, outcome: r.outcome });
});

// ── §5.3, the other direction (shaer-p729): the ward wants to follow SOMEONE,
//    and the guardians decide. Same quorum arithmetic and the same availability
//    rules as the inbound gate above; only the question is turned around, which
//    is why it gets its own endpoint rather than a flag on that one.
router.post('/api/outgoing-follow/:id', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';

  const pending = Guardianship.outgoing.getPending(req.params.id);
  if (!pending) return res.status(404).json({ error: 'gone' });
  const allGuardians = Guardianship.listGuardians(pending.ward_slug).map((g) => g.other_uri);
  if (!allGuardians.includes(me)) return res.status(403).json({ error: 'not_a_guardian' });
  Guardianship.availability.oneAnswer(me, Date.now());
  const guardians = Guardianship.availability.availableSet(pending.ward_slug, allGuardians, Date.now());
  const r = Guardianship.outgoing.decide(pending.id, me, decision, guardians);
  try {
    // Only on approval does anything leave the building. A refusal is a local
    // fact: the follow was never sent, so there is nothing out there to undo
    // and nobody to inform that a child asked about them.
    if (r.outcome === 'approved') await AP.performApprovedFollow(r.follow);
  } catch { return res.status(502).json({ error: 'delivery', outcome: r.outcome }); }
  res.json({ ok: true, outcome: r.outcome });
});

// ── Wave (FEP-633c §5, shaer:wave): a gentle "thinking of you" from a
//    guardian to a ward. A private direct note, never a feed post. Warmth
//    without publishing (Robins besluit).
router.post('/api/wave', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const wardUri = String(req.body?.ward || '').trim();
  // Only wave at a ward you actually guard.
  const isWard = Guardianship.listWards(site.slug).some((w) => w.other_uri === wardUri);
  if (!wardUri || !isWard) return res.status(403).json({ error: 'not_your_ward' });
  const text = String(req.body?.text || '').trim().slice(0, 200) || '👋 thinking of you';
  const r = await AP.deliverDirectNote(site, { recipients: [wardUri], text, wave: true }).catch(() => null);
  if (!r) return res.status(502).json({ error: 'delivery' });
  res.json({ ok: true, delivered: r.delivered });
});

// ── Een hulpvraag oppikken of afsluiten (shaer-lgo) ───────────────
// Gaat naar de WARD en naar de MEDE-GUARDIANS. De ward hoort te weten dat er
// iemand komt -- dat is de helft van de gerustheid -- en de anderen dat het
// loopt, zodat niemand denkt dat de ander het al doet.
//
// OPPIKKEN mag stapelen: twee mensen die tegelijk reageren is geen probleem.
// AFSLUITEN kent geen terugdraai; leeft de vraag nog, dan wordt hij opnieuw
// gesteld. De stevige bevestiging zit in de client, net als bij het loslaten van
// een ward: nooit een window.confirm.
router.post('/api/help/:kind', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const kind = req.params.kind === 'handled' ? 'handled' : 'pickup';
  const noteUri = String(req.body?.note || '').trim();
  const wardUri = String(req.body?.ward || '').trim();
  if (!noteUri || !/^https?:\/\//i.test(noteUri)) return res.status(400).json({ error: 'no_note' });
  // Alleen over een hulpvraag van een kind dat je echt bewaakt.
  const isWard = Guardianship.listWards(site.slug).some((w) => w.other_uri === wardUri);
  if (!isWard) return res.status(403).json({ error: 'not_your_ward' });

  const me = AP.actorId((process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''), site.slug);
  // Onze eigen kopie meteen, zonder op bezorging te wachten: het scherm van
  // degene die klikt hoort niet te liegen omdat een andere server traag is.
  // MET onze eigen handle. Die stond hier op null, en "door wie" was juist de
  // hele vraag van deze bead: een binnengekomen markering draagt de handle van
  // de afzender wel, dus onze EIGEN rij was de enige zonder naam. Op het scherm
  // viel dat terug op de kale URI.
  Guardianship.help.record(noteUri, me, kind, AP.deriveHandle(me));

  // DE MEDE-GUARDIANS, en dit ging mis (shaer-lgo, gevonden 11-8 met @mee).
  //
  // Hier stond listGuardians(wardUri.replace(/.*\/ap\/users\//, '')): de staart
  // van de URI als slug. listGuardians kent alleen relaties van LOKALE sites,
  // dus voor een ward elders leverde dat altijd een lege lijst -- en juist die
  // ward is het hele punt, want een ward op je eigen instance heeft geen
  // federatie nodig. De markering ging dus alleen naar het kind en nooit naar
  // de andere guardian. Precies de faalstand waar deze bead voor bestaat:
  // iedereen denkt dat de ander het oppakt.
  //
  // Erger nog: had er toevallig een lokale site met die naam bestaan, dan
  // waren het DIENS guardians geweest.
  //
  // existingGuardiansOf kende de goede weg al -- lokaal opzoeken, en anders
  // shaer:guardians uit de actor van de ward. Die stond alleen niet aan deze
  // route vast.
  const anderen = await Guardianship.existingGuardiansOf(wardUri).catch(() => []);
  const ontvangers = [wardUri, ...anderen].filter((u) => u && u !== me);
  const r = await AP.deliverDirectNote(site, {
    recipients: ontvangers,
    text: kind === 'handled' ? 'Deze hulpvraag is afgehandeld.' : 'Ik kijk hiernaar.',
    helpMark: { kind, noteUri },
  }).catch(() => null);
  // Bezorging kan mislukken; de eigen staat staat er dan toch. Dat melden we,
  // want "verstuurd" zeggen terwijl het niet aankwam is hier het ergste soort
  // stilte.
  res.json({ ok: true, delivered: r ? r.delivered : 0, recipients: ontvangers.length });
});

// ── Adopt a ward: handle → resolve → C2S Offer through the same pipeline
//    the Shaer apps use (one path, one behavior).
router.post('/adopt', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const handle = String(req.body?.handle || '').trim();
  if (!handle) return res.status(400).json({ error: 'empty_handle' });
  const wardUri = /^https?:\/\//i.test(handle) ? handle : await AP.webfingerResolve(handle).catch(() => null);
  if (!wardUri) return res.status(404).json({ error: 'not_found' });   // the handle does not resolve to an account
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const r = await AP.ingestOutboxActivity(site, req.session.user, {
    type: 'Offer',
    object: { type: 'Relationship', subject: wardUri, relationship: 'shaer:Guardian', object: me },
  });
  // 403/400 = a real refusal (e.g. you are a ward yourself); anything else the
  // offer is recorded and delivery is retried in the background.
  if (!r || (r.status >= 400 && r.status !== 502)) return res.status(r?.status || 500).json({ error: r?.error || 'offer_failed' });
  res.json({ ok: true, ward: wardUri, delivered: r.delivered !== false });
});

// ── Answer an offer (co-guardian accept/reject, or the candidate's final
//    "complete"). All three are a C2S Accept/Reject on the offer id; the
//    handshake module decides when it commits (§3.1).
// ── Step away (FEP-633c 3.6.1): the guardian declares itself unavailable ──
// One direct note with shaer:away and an endTime to every ward, the same path
// Shaer takes over C2S, and the only path: a ward on this instance receives
// that note through the loopback and applies the absence in its own inbox
// handler, exactly as a ward elsewhere does. This route used to write the
// local wards itself as well, which meant the wire version could break without
// anyone here noticing.
router.post('/api/away', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const days = Math.min(365, Math.max(1, parseInt(req.body?.days, 10) || 0));
  if (!days) return res.status(400).json({ error: 'away_needs_an_end' });
  const wards = Guardianship.listWards(site.slug).map((w) => w.other_uri);
  if (!wards.length) return res.status(409).json({ error: 'no_wards' });
  const until = Date.now() + days * 24 * 3600 * 1000;
  const L = resolveLang(req);
  const text = i18nT(L, 'guardian.away_msg', { date: new Date(until).toLocaleDateString('nl-NL') });
  const r = await AP.deliverDirectNote(site, { recipients: wards, text, awayUntil: until }).catch(() => null);
  if (!(r && r.id)) return res.status(502).json({ error: 'away_failed' });
  res.json({ ok: true, until });
});

// ── Propose a lapse (FEP-633c 3.6.3) against a dormant co-guardian ────────
// The same C2S pipeline the Shaer apps would use: an Offer of shaer:Lapse.
// A local ward opens directly; a remote ward gets the proposal delivered,
// because the ward's server is the one that tallies and enforces.
router.post('/api/lapse', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const ward = String(req.body?.ward || '').trim();
  const target = String(req.body?.target || '').trim();
  if (!ward || !target) return res.status(400).json({ error: 'missing_ward_or_target' });
  if (!Guardianship.listWards(site.slug).some((w) => w.other_uri === ward)) {
    return res.status(403).json({ error: 'not_my_ward' });
  }
  const r = await AP.ingestOutboxActivity(site, req.session.user, {
    type: 'Offer', object: { type: 'shaer:Lapse', 'shaer:ward': ward, object: target },
  });
  if (!r || r.status >= 400) return res.status(r?.status || 500).json({ error: r?.error || 'lapse_failed' });
  res.json({ ok: true, lapse: r.id });
});

// ── Answer a forwarded gated-setting proposal (FEP-633c 5.6) ─────────────
// The decision belongs to the ward's server, so the answer travels there as an
// Accept/Reject on the offer id, exactly like a gated follow's decision.
router.post('/api/gated/:id', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const review = Guardianship.gated.getGatedReview(site.slug, req.params.id);
  if (!review) return res.status(404).json({ error: 'gone' });
  const agree = req.body?.answer !== 'reject';
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const activity = {
    id: `${me}#gated-${Date.now().toString(36)}`,
    type: agree ? 'Accept' : 'Reject', actor: me, to: [review.ward_uri], object: review.id,
  };
  try { await AP.deliverToActor(site, review.ward_uri, activity); }
  catch { return res.status(502).json({ error: 'delivery' }); }
  Guardianship.gated.removeGatedReview(site.slug, review.id);
  res.json({ ok: true, answer: agree ? 'accept' : 'reject' });
});

router.post('/offer', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const offerId = String(req.body?.offer || '').trim();
  const answer = req.body?.answer === 'reject' ? 'Reject' : 'Accept';
  if (!offerId) return res.status(400).json({ error: 'empty_offer' });
  const r = await AP.ingestOutboxActivity(site, req.session.user, { type: answer, object: offerId });
  if (!r || r.status >= 400) return res.status(r?.status || 500).json({ error: r?.error || 'answer_failed' });
  res.json({ ok: true, committed: !!r.committed, readyToCommit: !!r.readyToCommit });
});

// ── PWA assets served no-cache, so an update is never masked by the 1-year
//    /assets cache or a stuck install (that was the whole "nothing works after
//    a deploy" bug). Small files; the browser revalidates and gets a 304 when
//    unchanged, the fresh file when changed.
function pwaAsset(rel, type) {
  return (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type(type);
    res.sendFile(path.join(__dir, '..', 'assets', rel));
  };
}
router.get('/app.js', pwaAsset('js/guardian.js', 'application/javascript'));
router.get('/app.css', pwaAsset('css/guardian.css', 'text/css'));

// ── Manage: release a committed ward (local Undo; federation is Fase 4). ──
/**
 * What actually happens if this guardian releases this ward?
 *
 * Releasing is not one action but two very different ones, and the difference
 * is the number of guardians the child has left (FEP-633c):
 *   - more than one → §3.3, you step down and the child stays a ward;
 *   - you are the last → §3.4, that is emancipation, and the FEP is explicit
 *     that no single guardian decides it alone (three consenting adults, or a
 *     majority plus two witnesses).
 * On top of that, today's release is LOCAL: the Undo is not federated yet
 * (relations.js, fase 4), so the ward's server keeps listing this guardian.
 * A guardian pressing the button would otherwise believe the child is released.
 *
 * Answered on demand rather than in the dashboard state: for a ward we do not
 * host this reaches out to that ward's server, and nobody should pay for that
 * on every refresh.
 */
router.get('/wards/release-check', requireAuth, async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.query.uri || '').trim();
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  if (!Guardianship.listWards(site.slug).some((w) => w.other_uri === uri)) {
    return res.status(403).json({ error: 'not_my_ward' });
  }
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const local = !!base && uri.startsWith(`${base}/`);
  let guardians = null;   // null = we could not find out; say so rather than guess
  if (local) {
    const slug = uri.replace(/\/+$/, '').split('/').pop();
    try { guardians = Guardianship.listGuardians(slug).length; } catch { /* stays null */ }
  } else {
    const doc = await AP.fetchActor(uri).catch(() => null);
    const g = doc && doc['shaer:guardians'];
    if (Array.isArray(g)) guardians = g.length;
    else if (typeof g === 'string') guardians = 1;
    else if (g && Array.isArray(g.items)) guardians = g.items.length;
    else if (doc) guardians = 0;   // the actor answered and names no guardians
  }
  res.json({
    guardians,
    last: guardians === null ? null : guardians <= 1,
    local,
  });
});

// ── The fellow guardians of a ward, wherever it lives ─────────────────────
// A guardian looking at a ward's panel should see who else holds a seat: that
// is the child's safety net, and "dit kind woont op een andere server" is not
// an answer. For a local ward the availability rides along (we do that
// bookkeeping). For a remote ward we read the PUBLIC membership from its
// actor document (shaer:guardians, §2.1) and nothing more: availability is
// the ward's server's private ledger (§3.6.1) and stays there. Fetched on
// panel-open rather than into the dashboard, so one slow remote server does
// not hold the whole screen hostage.
router.get('/wards/guardians', requireAuth, async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.query.uri || '').trim();
  if (!Guardianship.listWards(site.slug).some((w) => w.other_uri === uri)) {
    return res.status(403).json({ error: 'not_my_ward' });
  }
  const local = Guardianship.queues.wardGuardianStatuses(uri);
  if (local) return res.json({ local: true, guardians: local });
  const doc = await AP.fetchActor(uri).catch(() => null);
  let g = doc && doc['shaer:guardians'];
  if (g && Array.isArray(g.items)) g = g.items;             // a Collection
  const guardians = (Array.isArray(g) ? g : (typeof g === 'string' ? [g] : []))
    .filter((x) => typeof x === 'string')
    .map((u) => {
      try { const p = new URL(u); return { uri: u, handle: `@${p.pathname.replace(/\/+$/, '').split('/').pop()}@${p.host}` }; }
      catch { return { uri: u, handle: u }; }
    });
  res.json({ local: false, guardians });
});

router.post('/wards/remove', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.body?.uri || '').trim();
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  // Ending a guardianship is an Undo of the Relationship that travels to the
  // ward and the other guardians (§3.2), not a local delete. Same call the
  // Guardian apps reach over C2S, so the two cannot drift apart.
  const r = await Guardianship.endGuardianship(site, uri);
  if (r.status >= 400) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, delivered: r.delivered, guardiansLeft: r.guardiansLeft });
});

/**
 * The external-embeds setting of a ward we host: true/false when a guardian has
 * decided, null when it is still on auto (which means off for a ward) or when
 * the ward lives elsewhere and the setting is not ours to show.
 */
function wardEmbedSetting(uri) { return wardGateSetting(uri, 'external_embeds'); }
/** The playback gate of a ward we host (5.6): the heavier sibling. */
function wardPlaybackSetting(uri) { return wardGateSetting(uri, 'external_playback'); }

function wardGateSetting(uri, column) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !String(uri || '').startsWith(`${base}/`)) return null;
  const slug = String(uri).trim().replace(/\/+$/, '').split('/').pop();
  const row = slug ? db.prepare(`SELECT ${column === 'external_playback' ? 'external_playback' : 'external_embeds'} AS v FROM sites WHERE slug = ?`).get(slug) : null;
  if (!row) return null;
  return row.v === null || row.v === undefined ? false : row.v === 1;
}

// ── Gated feature: may this ward see external (non-fediverse) embeds? ──
// The first real gated setting (FEP-633c §5-style). The gate itself is applied
// server-side when the feed is serialised, so this endpoint is the only way it
// can move, and only a committed guardian of THAT ward may move it.
router.post('/wards/embeds', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  // Niet meer alleen embeds/playback: elke gate uit de catalogus met een kolom
  // is voorstelbaar (8-8, "maak ze allemaal functioneel"). De oude regel
  // HERSCHREEF een onbekende feature stilletjes naar externalEmbeds -- een
  // voorstel voor de ene poort dat op de andere landt is precies het soort
  // fout dat een guardian nooit mag overkomen. Onbekend wordt nu geweigerd.
  const feature = String(req.body?.feature || 'shaer:externalEmbeds');
  if (!Guardianship.gated.featureColumn(feature)) return res.status(400).json({ error: 'unknown_feature' });
  req.body = { ...req.body, feature };
  return proposeGated(req, res);
});
function proposeGated(req, res) {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  // De hele afweging staat in AP.proposeGate, zodat de apps langs dezelfde weg
  // kunnen voorstellen (shaer-8ru). Deze route is nog maar de PWA-deur ernaartoe.
  const uit = AP.proposeGate(site, req.body?.uri, req.body?.feature, req.body?.allow === true);
  const { status, ...rest } = uit;
  return res.status(status === 200 ? 200 : status).json(rest);
}

// ── The installable identity: own scope so the Guardian corner installs as
//    its own app next to the site PWA.
router.get('/manifest.webmanifest', (req, res) => {
  const site = res.locals.site;
  res.set('Cache-Control', 'no-cache');
  res.json({
    id: `klonkt-guardian-${site?.slug || 'guardian'}`,
    name: 'Klonkt Guardian',
    short_name: 'Guardian',
    description: 'Ward management and help requests for guardians.',
    scope: '/guardian/',
    start_url: '/guardian?source=pwa',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#141a24',
    theme_color: '#ff6b35',
    lang: site?.language || 'nl',
    icons: [
      { src: '/guardian/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  });
});

// The buoy mark, in the guardian accent (mirrors the site favicon pattern).
router.get('/icon.svg', (req, res) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#ff6b35"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="36">&#128735;</text>
</svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Losse guardian-accounts (guardian-lite: /invite + /join, user + site met
// guardian_only=1) zijn verwijderd op 31-7-2026. Een instance is een eigenaar;
// zo'n account was de laatste multi-user-rest en zette bovendien andermans
// wachtwoordhash, sessie en PRIVATE actor-sleutel in jouw database, wat een
// verhuizing (shaer-qw6q) onmogelijk netjes maakte. Een guardian hoort een
// eigen Klonkt te hebben; de adoptie loopt dan gewoon over de federatie.

export default router;
