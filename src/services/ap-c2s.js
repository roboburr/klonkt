/**
 * ap-c2s.js — de Client-to-Server-inname (stap 4 van shaer-drc).
 *
 * De C2S-tegenhanger van handleInbox: een eigen client (Shaer, R9999) POST een
 * activity op de outbox en dit blok vertaalt hem naar DEZELFDE machinerie die
 * het web gebruikt (deliverReply, sendInteraction, followActor, deliverCreate).
 *
 * Anders dan ap-transport is dit een COORDINATOR: hij roept de dienstlaag aan,
 * en de regel van shaer-drc verbiedt een import uit ActivityPubService.js.
 * Daarom het patroon dat guardianship al bewees: de dienstlaag geeft zijn
 * werktuigen bij het laden door via wireC2S, en de verhuisde functies staan
 * hier byte-voor-byte ongewijzigd -- ze merken niet dat hun buren injectie
 * werden. Wat WEL rechtstreeks geimporteerd wordt, wijst omlaag: db, ap-core,
 * de sanitizer en guardianship.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';
import * as Guardianship from './guardianship/index.js';
import { PUBLIC, actorId } from './ap-core.js';

// Dezelfde twee als de re-exports in ActivityPubService: het directe-note-been
// en de zichtbaarheidsregel wonen in guardianship, hier alleen kortgesloten
// zodat de verhuisde regels ongewijzigd blijven.
const c2sVisibility = Guardianship.c2sVisibility;
const deliverDirectNote = Guardianship.deliverDirectNote;

// De werktuigen uit de dienstlaag. ActivityPubService vult ze onderaan zijn
// eigen evaluatie met wireC2S -- ruim voordat er een verzoek kan binnenkomen.
// Een aanroep VOOR de koppeling is een programmeerfout en mag hard vallen.
let proposeGate, deriveHandle, resolveRemoteNote, deliverReply, markRead,
  postIdFromNoteUrl, sendInteraction, setReaction, gateOutgoingFollow,
  followActor, unfollowActor, blockTarget, unblock, deliverDelete,
  deliverOutboxDelete, bakePostContent, bakePostContentWithMentions,
  deliverCreate;
export function wireC2S(deps) {
  ({ proposeGate, deriveHandle, resolveRemoteNote, deliverReply, markRead,
    postIdFromNoteUrl, sendInteraction, setReaction, gateOutgoingFollow,
    followActor, unfollowActor, blockTarget, unblock, deliverDelete,
    deliverOutboxDelete, bakePostContent, bakePostContentWithMentions,
    deliverCreate } = deps);
}

// ── ActivityPub Client-to-Server: ingest an activity POSTed to the outbox ──
// The C2S counterpart of handleInbox: a native/web client (Shaer) posts an
// activity here and we translate it onto the SAME delivery machinery the web UI
// uses (deliverReply / sendInteraction / followActor / deliverCreate). Returns
// { status, id?, url?, error? }. Auth + site-ownership are checked by the route.
const c2sIdOf = (x) => (typeof x === 'string' ? x : (x && (x.id || x.href))) || null;

export async function ingestOutboxActivity(site, user, activity) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !activity || typeof activity !== 'object') return { status: 400, error: 'invalid_activity' };

  // AP §6: a client MAY POST a bare object; the server wraps it in a Create.
  let type = activity.type;
  let object = activity.object;
  if (type === 'Note' || type === 'Article') { object = activity; type = 'Create'; }
  if (Array.isArray(type)) type = type.find((t) => typeof t === 'string');

  // FEP-633c: the adoption handshake (Offer/Accept/Reject on a guardianship
  // Relationship) belongs to the guardianship module; anything else falls
  // through to the switch below.
  if (type === 'Offer' || type === 'Accept' || type === 'Reject') {
    const g = await Guardianship.handleGuardianshipOutbox(site, activity).catch(() => null);
    if (g) return g;
  }
  // Een gate-voorstel uit de app (5.6, shaer-8ru): een Offer van een
  // shaer:GatedSetting, de vorm die 5.6 al beschrijft.
  //
  // HIER, EN GEEN `case` IN DE SWITCH. Dat was hij eerst, en die claimde ELKE
  // Offer: wat geen gate-voorstel was kreeg 400 unsupported_offer -- ook de
  // adoptie-handshake, en straks elke Offer-vorm die we nog toevoegen. Barts
  // honderd aanbiedingen liepen er meteen op stuk. Alleen claimen wat je
  // herkent, en de rest laten doorlopen.
  if (type === 'Offer') {
    const gs = Guardianship.gated.parseGatedSetting(activity.object);
    if (gs) {
      const uit = proposeGate(site, gs.ward, gs.feature, gs.value);
      return uit.status === 200 ? { ...uit, status: 201, id: uit.offerId } : uit;
    }
  }

  try {
    switch (type) {
      case 'Create': {
        if (!object || typeof object !== 'object') return { status: 400, error: 'missing_object' };
        // Innamepoorten (shaer-ahy.1, 8-8): wat de ward niet mag versturen
        // wordt HIER geweigerd, niet in de app verstopt -- een knop die de
        // client alleen verbergt is geen poort. De reddingsboei gaat ALTIJD
        // voor: een hulpvraag aan de guardians mag door elke dichte deur heen,
        // anders sluit een messages-poort precies het kanaal af dat het kind
        // veilig houdt.
        {
          const isWard = (() => { try { return Guardianship.listGuardians(site.slug).length > 0; } catch { return false; } })();
          const isHelp = object['shaer:helpRequest'] === true || object.helpRequest === true;
          // Een poortverzoek van het kind zelf (shaer-8ru) gaat langs de
          // messages-poort. Dat lijkt een gat en is het niet: het verzoek draagt
          // ALLEEN de naam van de feature, geen vrije tekst, dus er ontstaat geen
          // kanaal om omheen die poort te praten. Zonder deze uitzondering kan
          // een kind met berichten dicht nergens meer om vragen -- en dan is de
          // hele weg dood op precies het moment dat hij nodig is.
          const isGateReq = !!Guardianship.gatereq.parseRequest(object);
          const direct = c2sVisibility(object) === 'direct';
          if (!isHelp && !isGateReq) {
            if (direct && !Guardianship.wardGateAllowed(site.gate_messages, isWard)) {
              return { status: 403, error: 'gated_messages' };
            }
            if (!direct && !object.inReplyTo && !Guardianship.wardGateAllowed(site.gate_compose, isWard)) {
              return { status: 403, error: 'gated_compose' };
            }
            // Meedoen aan een gesprek is ook iets (Bart, 8-8). Hier stond de
            // aanname dat een antwoord geen eigen podium is en dus onder compose
            // door mocht. Dat is teruggedraaid: antwoorden heeft een EIGEN poort,
            // los van compose in beide richtingen -- je kunt willen dat een kind
            // meepraat zonder podium, en ook andersom.
            //
            // Geldt ook voor een DIRECT antwoord, bovenop de messages-poort: een
            // privé-antwoord is allebei, en dan mag allebei hem tegenhouden.
            if (object.inReplyTo && !Guardianship.wardGateAllowed(site.gate_replies, isWard)) {
              return { status: 403, error: 'gated_replies' };
            }
          }
        }
        // Client sends `source` (plain/markdown) + `content` (HTML). deliverReply
        // re-escapes, so it needs plain text; a top-level post keeps sanitized HTML.
        const plain = (object.source && object.source.content) || HtmlSanitizerService.toPlainText(object.content || '');
        // A picture (or a recording) can be the whole message: media-only
        // notes pass here; c2sCreatePost validates the attachments themselves.
        if (!plain.trim() && !object.content && !(Array.isArray(object.attachment) && object.attachment.length)) {
          return { status: 400, error: 'empty_note' };
        }
        // Direct (private mention, shaer-tqc): NOT a post. Delivered over the
        // outbox machinery to the addressed inboxes only; shows under Messages.
        if (c2sVisibility(object) === 'direct') {
          const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');
          const recipients = [...new Set([...arr(object.to), ...arr(object.cc)])]
            .filter((u) => /^https?:\/\//i.test(u) && !/\/followers\/?$/.test(u) && u !== PUBLIC);
          if (!recipients.length) return { status: 400, error: 'no_recipients' };
          // AS2 attachments (e.g. the help-buoy capture, uploaded via
          // uploadMedia): normalize our own absolute /media/ URLs to relative
          // so the deliverReply-style validation applies unchanged.
          const atts = (Array.isArray(object.attachment) ? object.attachment : [])
            .map((a) => a && typeof a === 'object' ? {
              url: String(a.url || '').replace(new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ''),
              mediaType: String(a.mediaType || ''),
              name: String(a.name || '').slice(0, 120),
            } : null)
            .filter(Boolean);
          const help = object['shaer:helpRequest'] === true || object.helpRequest === true;
          // FEP-633c 3.6.1: a guardian here declaring itself away to its
          // wards. An away without a (future) end fails loudly, exactly as
          // the daemon refuses it: stored quietly it would be a nominal
          // guardian holding a seat.
          let awayUntil = null;
          if (Guardianship.availability.isAway(object)) {
            awayUntil = Guardianship.availability.parseEndTime(object.endTime);
            if (!awayUntil || awayUntil <= Date.now()) return { status: 400, error: 'away_needs_an_end' };
            // No local shortcut here: the note below reaches a ward on this
            // instance through the loopback, and its inbox handler applies the
            // absence like it does for a ward anywhere else. One path.
          }
          const gateReq = Guardianship.gatereq.parseRequest(object);
          // Een hulpvraag oppikken of afsluiten vanuit de app (5.2.1, shaer-lgo).
          // De markering IS al een gewone directe note met een shaer:-eigenschap,
          // dus hier hoeft niets nieuws bij: de app stuurt precies wat de PWA
          // stuurt, en het gaat over dezelfde bezorging naar de mede-guardians.
          //
          // We boeken hem ook LOKAAL. Zonder dat zou de guardian die de knop
          // indrukt zijn eigen markering pas zien als hij bij zichzelf
          // terugkomt -- en die weg bestaat niet.
          const mark = Guardianship.help.parseMarker(object);
          if (mark) {
            const base2 = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
            // Met de VOLLEDIGE handle. Hier stond `@${site.slug}` -- zonder host,
            // dus een derde vorm naast de kale URI van de PWA-route en de echte
            // handle die een binnengekomen markering draagt. Drie spellingen van
            // dezelfde naam, en "door wie" was de hele vraag van shaer-lgo.
            const mij = actorId(base2, site.slug);
            Guardianship.help.record(mark.noteUri, mij, mark.kind, deriveHandle(mij));
          }
          const r = await deliverDirectNote(site, { recipients, text: plain, language: object.language || null, inReplyTo: typeof object.inReplyTo === 'string' ? object.inReplyTo : null, attachments: atts, helpRequest: help, awayUntil, gateRequest: gateReq && gateReq.feature, helpMark: mark });
          if (!r || !r.id) return { status: 502, error: 'direct_failed' };
          return { status: 201, id: r.id, url: `${base}/ap/notes/${r.id}` };
        }
        if (object.inReplyTo) {
          const parent = await resolveRemoteNote(c2sIdOf(object.inReplyTo), { asSlug: site.slug }).catch(() => null);
          if (!parent) return { status: 502, error: 'cannot_resolve_inReplyTo' };
          // The attachments ride along (Robins melding, 30-7: "502
          // reply_failed" op een reply met een foto): deliverReply validates
          // them itself (own /media only, image|audio|video, max 4) and a
          // media-only reply is a valid reply there. Dropping them here made
          // a photo reply arrive naked, and a photo-ONLY reply fail outright.
          const atts = (Array.isArray(object.attachment) ? object.attachment : [])
            .map((a) => a && typeof a === 'object' ? {
              url: String(a.url || '').replace(new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ''),
              mediaType: String(a.mediaType || ''),
              name: String(a.name || '').slice(0, 120),
            } : null)
            .filter(Boolean);
          // DE MENTIONS VAN DE CLIENT (Robins melding, 26-8). Zonder deze
          // regel kreeg deliverReply `mentions: undefined`, en dat betekent
          // daar "oud gedrag: noem alleen de auteur van de ouder". Een client
          // die er drie stuurde zag er dus een gepubliceerd worden -- niet
          // door een filter, maar doordat de andere twee hier nooit aankwamen.
          //
          // De tags zijn de bron, niet `to`/`cc`: die dragen ook de
          // volgerscollectie en Public, en dat zijn geen mensen. `href` is de
          // actor, `name` de handle zoals de client hem spelt.
          //
          // Ontdubbeld op actor, want de ouder-auteur zit meestal ook in de
          // tags en zou anders twee keer vooraan komen te staan.
          //
          // GEEN tags meegestuurd blijft undefined en dus het oude gedrag. Een
          // LEGE lijst kan niet: dat betekent in deliverReply "niemand noemen",
          // en dat is een keuze die een client die geen tags kent nooit maakte.
          const gezien = new Set();
          const mentions = (Array.isArray(object.tag) ? object.tag : (object.tag ? [object.tag] : []))
            .filter((t) => t && t.type === 'Mention' && typeof t.href === 'string' && /^https?:\/\//i.test(t.href))
            .filter((t) => !gezien.has(t.href) && gezien.add(t.href))
            .map((t) => ({ uri: t.href, url: t.href, handle: typeof t.name === 'string' ? t.name : undefined }));
          // Honour the client's visibility for the reply: 'friends' (followers-
          // only, the Shaer detail-view Reply) drops Public; anything else stays
          // quiet-public. 'direct' was already handled above.
          const r = await deliverReply(site, {
            postId: parent.localPostId || '', postSlug: null, parent, text: plain,
            html: object.content || null, attachments: atts,
            language: object.language || null, visibility: c2sVisibility(object),
            mentions: mentions.length ? mentions : undefined,
          });
          if (!r || !r.id) return { status: 502, error: 'reply_failed' };
          return { status: 201, id: r.id, url: `${base}/ap/notes/${r.id}` };
        }
        return await c2sCreatePost(base, site, user, object);
      }
      // ── Gelezen tot hier (shaer-frontend-3tx) ───────────────────
      //
      // AS2 kent Read: 'the actor has read the object'. Geen shaer:seen
      // verzinnen, en geen zetbare stand: dit is een GEBEURTENIS, dus twee
      // toestellen kunnen elkaar niet terugzetten. Blijft lokaal -- een
      // leesbevestiging heeft in de fediverse niets te zoeken.
      case 'Read': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        const uit = markRead(site.slug, targetUri);
        // Kennen we die note niet, dan is er niets gelezen om te onthouden.
        // Geen fout: een client mag best een oud bericht aanwijzen.
        return { status: uit ? 200 : 202 };
      }
      case 'Like':
      case 'Announce': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        // A non-public local note cannot be boosted or liked into the open
        // (shaer-tqc hardening; the Mastodon 422 equivalent).
        const localPid = postIdFromNoteUrl(targetUri, base);
        if (localPid) {
          const p = db.prepare('SELECT fan_only, ap_visibility FROM posts WHERE id = ?').get(localPid);
          if (p && (p.fan_only || p.ap_visibility === 'direct' || p.ap_visibility === 'friends')) {
            return { status: 403, error: 'not_public' };
          }
        }
        const note = await resolveRemoteNote(targetUri, { asSlug: site.slug }).catch(() => null);
        const objUri = (note && note.object_uri) || targetUri;
        const authorUri = note && note.actor_uri;
        const kind = type === 'Announce' ? 'boost' : 'like';
        await sendInteraction(site, kind, objUri, authorUri);
        // Eén schrijfpad (shaer-9e9): tussentabel + afgeleide vlag in één keer.
        // De note gaat mee zodat een boost de post je tijdlijn in trekt.
        try { setReaction(site.slug, targetUri, kind, true, { flagUri: objUri, note: type === 'Announce' ? note : null }); }
        catch { /* non-fatal: een reactie mag nooit de bezorging blokkeren */ }
        // Een Like uit een app moet ook in ap_timeline.liked landen, want dat
        // is wat de C2S-tijdlijn als shaer:liked teruggeeft. Zonder dit werd
        // de reactie wel opgeslagen (setMyReaction, de webroute leest die),
        // maar kreeg de app altijd liked:false terug: het hartje sprong bij de
        // eerste herlaadbeurt uit, en un-liken kon niet meer -- de app bood
        // alleen nog "Like" aan en stuurde bij elke tik een nieuwe Like.
        // Anders dan bij een boost geen upsert: een like hoort een post niet
        // in je tijdlijn te trekken, dus staat de post er niet in, dan is dit
        // terecht een no-op.
        return { status: 202, url: objUri };
      }
      case 'Follow': {
        const actorUri = c2sIdOf(object);
        if (!actorUri) return { status: 400, error: 'missing_object' };
        // FEP-633c §5.3 outbound (shaer-p729): a ward asks its guardians first.
        // A held request is a THIRD outcome — not sent, not failed — and it
        // travels to the app as one, so Shaer can show "waiting" instead of a
        // tile that already looks followed.
        const held = await gateOutgoingFollow(site, actorUri);
        if (held) {
          return {
            status: 202, url: actorUri, id: held.id,
            state: held.status === 'denied' ? 'refused_by_guardian' : 'awaiting_guardian',
          };
        }
        // The error REACHES the app (Robins melding, 31-7): swallowing it
        // made a failed follow look exactly like a successful one.
        const r = await followActor(site, actorUri);
        if (r && r.error) return { status: 502, error: 'follow_failed', detail: r.error };
        return { status: 202, url: actorUri };
      }
      // Shaer "in Orbit" = a real Block (FEP-c648 client side): lands in
      // ap_blocks, shows in the Block tab, and purges the actor's cached
      // content. Client-side filtering becomes a cache of this state.
      case 'Block': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        const r = await blockTarget(site, targetUri);
        if (r && r.error) return { status: 400, error: r.error };
        return { status: 202, url: targetUri };
      }
      case 'Undo': {
        const inner = object && typeof object === 'object' ? object : null;
        let innerType = inner && inner.type;
        if (Array.isArray(innerType)) innerType = innerType.find((t) => typeof t === 'string');
        const innerTarget = c2sIdOf(inner && inner.object);
        if (innerType === 'Follow') { await unfollowActor(site, innerTarget); return { status: 202, url: innerTarget }; }
        if (innerType === 'Block') {
          if (!innerTarget) return { status: 400, error: 'missing_object' };
          unblock(site, innerTarget).catch(() => {});   // release from Orbit
          return { status: 202, url: innerTarget };
        }
        if (innerType === 'Like' || innerType === 'Announce') {
          const kind = innerType === 'Announce' ? 'unboost' : 'unlike';
          const note = await resolveRemoteNote(innerTarget, { asSlug: site.slug }).catch(() => null);
          const objUri = (note && note.object_uri) || innerTarget;
          await sendInteraction(site, kind, objUri, note && note.actor_uri);
          try { setReaction(site.slug, innerTarget, innerType === 'Announce' ? 'boost' : 'like', false, { flagUri: objUri }); }
          catch { /* non-fatal */ }
          return { status: 202, url: objUri };
        }
        return { status: 400, error: 'unsupported_undo' };
      }
      // Delete your OWN note (Robins verzoek, 30-7: long-press delete in de
      // app). Scope stays narrow: this account's posts and outbound replies,
      // nothing else. The web delete route is the model: Tombstone to the
      // followers first, then the cascade, so nobody keeps a live copy of a
      // post the child took back.
      case 'Delete': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        const pid = postIdFromNoteUrl(targetUri, base);
        if (pid) {
          const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(pid);
          if (post) {
            if (post.site_id !== site.id) return { status: 403, error: 'not_your_note' };
            if (post.status === 'published') deliverDelete(site, post).catch(() => { /* best-effort */ });
            db.transaction(() => {
              db.prepare('DELETE FROM comments WHERE post_id = ?').run(post.id);
              try { db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(post.id); } catch { /* FTS optional */ }
              db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
            })();
            return { status: 202, url: targetUri };
          }
          // Same /ap/notes/ namespace: one of our outbound replies/messages.
          // deliverOutboxDelete checks the site itself and tombstones too.
          if (await deliverOutboxDelete(site, pid)) return { status: 202, url: targetUri };
        }
        return { status: 404, error: 'not_your_note' };
      }
      // Update of arbitrary objects needs the post-edit pipeline; tracked
      // separately (klonkt-demo-c2s-del). Reject clearly rather than half-doing it.
      default:
        return { status: 400, error: 'unsupported_type', detail: String(type || 'none') };
    }
  } catch (e) {
    console.warn('[AP] C2S ingest failed:', e && e.message);
    return { status: 500, error: 'ingest_error' };
  }
}

// Create a top-level microblog post from a C2S Note and federate it. Minimal
// sibling of the /posts/create route: sanitized HTML content, no title/cover.
async function c2sCreatePost(base, site, user, object) {
  const html = HtmlSanitizerService.sanitize(object.content || (object.source && object.source.content) || '');
  // Media on a top-level post (shaer-j3uh/-oqxk/-df3i): same rules as
  // deliverReply — only our OWN uploads, image/audio/video, max 4. They used
  // to be silently dropped here, so a photo post from the app arrived naked.
  const media = (Array.isArray(object.attachment) ? object.attachment : [])
    .filter((a) => a && typeof a.url === 'string' && /^\/media\/[\w./-]+$/.test(a.url)
      && /^(image|audio|video)\//.test(String(a.mediaType || '')))
    .slice(0, 4)
    .map((a) => {
      const entry = { url: a.url, mediaType: String(a.mediaType), name: String(a.name || '').slice(0, 120) };
      // The poster the upload leg made, when it did: a video's still frame
      // (shaer-zowq, .poster.jpg) or an audio's waveform (Robins vraag 30-7,
      // .poster.png). Rides along so the tag, the federated attachment and
      // the apps all have something to show instead of a bare box.
      const posterExt = entry.mediaType.startsWith('video/') ? '.poster.jpg'
        : entry.mediaType.startsWith('audio/') ? '.poster.png' : null;
      if (posterExt) {
        try {
          const mediaRoot = path.resolve(process.env.MEDIA_PATH || './storage/media');
          const rel = entry.url.replace(/^\/media\//, '');
          if (fs.existsSync(path.join(mediaRoot, rel + posterExt))) entry.poster = entry.url + posterExt;
        } catch { /* no poster is fine */ }
      }
      return entry;
    });
  if (!html.trim() && !media.length) return { status: 400, error: 'empty_note' };
  // The web reads the post's content, so the media goes IN it (we build these
  // tags ourselves from validated paths, after the sanitizer). buildNote
  // strips <img> back out into AS2 attachments; audio/video tags stay for the
  // web player and federate via c2s_attachments below.
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const mediaHtml = media.map((a) => {
    if (a.mediaType.startsWith('image/')) return `<p><img src="${a.url}" alt="${esc(a.name)}"></p>`;
    // data-poster: <audio> has no poster attribute, but the tile derivation
    // reads this one to show the waveform (post-tile/post-card).
    if (a.mediaType.startsWith('audio/')) return `<p><audio controls preload="metadata"${a.poster ? ` data-poster="${a.poster}"` : ''} src="${a.url}"></audio></p>`;
    const poster = a.poster ? ` poster="${a.poster}"` : '';
    return `<p><video controls playsinline preload="metadata"${poster} src="${a.url}"></video></p>`;
  }).join('');
  // De titel (shaer-uply): AS2 zet hem in `name`, en die werd hier nooit
  // gelezen -- een client kon hem zetten en hij verdween geruisloos, het
  // slechtste van de drie mogelijke gedragingen. Platte tekst, want dat is wat
  // `name` per AS2 is en wat de titelkolom overal verwacht; wie er toch HTML
  // in stopt houdt de tekst over. De grens van 200 is de huisregel voor korte
  // vrije tekst hier (content warning, sitetitel) -- de posteditor op het web
  // heeft geen eigen grens, dus strenger dan het web zijn we hiermee niet
  // op een manier die iemand merkt.
  // Vanaf de kolom doet de bestaande machinerie de rest: het web toont hem,
  // en buildNote vouwt hem als vetgedrukte eerste regel in de content
  // (Mastodon negeert `name` op een Note).
  const title = HtmlSanitizerService.toPlainText(typeof object.name === 'string' ? object.name : '').trim().slice(0, 200);
  const postId = crypto.randomUUID();
  const slug = 'n-' + postId.slice(0, 8);
  const now = new Date().toISOString();
  // Visibility from the note's addressing (shaer-60b): Public in `to` = loud
  // public, Public in `cc` = quiet public (unlisted), followers-only = friends
  // (rides the existing fan_only pipeline: followers-only AP delivery + web
  // gating), neither = participants-only (kept local until mention addressing
  // lands; still followers-gated on the web).
  const vis = c2sVisibility(object);
  const fanOnly = (vis === 'friends' || vis === 'direct') ? 1 : 0;
  // Deliberately NO cover (Robins besluit, 30-7): the media lives in the
  // content, and a cover next to it showed the same video twice on the post
  // page. The tiles derive their picture from the content instead.
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, excerpt, status, type, language, fan_only, ap_visibility, created_at, updated_at, published_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(postId, site.id, slug, user.id, title, html + mediaHtml, '', 'published', 'post', object.language || 'nl', fanOnly, vis, now, now, now);
  if (media.length) { try { db.prepare('UPDATE posts SET c2s_attachments = ? WHERE id = ?').run(JSON.stringify(media), postId); } catch { /* column exists via ensureColumn */ } }
  try { db.prepare('UPDATE posts SET content_rendered = ? WHERE id = ?').run(bakePostContent(html + mediaHtml), postId); } catch { /* render fallback covers it */ }
  bakePostContentWithMentions(html + mediaHtml).then((h) => { try { db.prepare('UPDATE posts SET content_rendered = ? WHERE id = ?').run(h, postId); } catch { /* keep sync bake */ } }).catch(() => {});
  // Ook in de zoekindex, en niet alleen in de kolom (shaer-uply): anders is
  // een getitelde C2S-post wel te zien maar niet op zijn titel te vinden.
  try { db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?,?,?,?)').run(HtmlSanitizerService.toPlainText(html), title, user.username || '', postId); } catch { /* FTS non-fatal */ }
  if (vis !== 'direct') {
    deliverCreate(site, { id: postId, slug, title, content: html + mediaHtml, published_at: now, created_at: now, fan_only: fanOnly, ap_visibility: vis, c2s_attachments: media.length ? JSON.stringify(media) : null }).catch(() => { /* best-effort */ });
  }
  return { status: 201, id: postId, url: `${base}/ap/notes/${postId}` };
}
