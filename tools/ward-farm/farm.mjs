/**
 * Een kudde ward-daemons, om de guardian met een CASELOAD te kunnen testen.
 *
 * Aanleiding (Bart, 8-8): ik noemde "tientallen hulpvragen bij een guardian" een
 * randgeval en zette het op P3. Bart: "precies de jeugdzorgmedewerker." Dat is
 * geen uitzondering maar een beroep, en alles wat we bouwden -- de wardlijst, de
 * poortenpanelen, de hulpvragen -- is ontworpen voor iemand met twee kinderen.
 * Deze farm is de maat die ontbrak.
 *
 * ECHT REMOTE, en dat is geen detail. De wards wonen op een ANDERE origin dan
 * dev.klonkt.com. Zou je ze onder dev zelf hangen, dan ziet Klonkt ze als lokaal
 * (het co-locatie-pad kijkt of de URI met PUBLIC_BASE_URL begint) en test je de
 * kortsluitroute in plaats van de federatie. Dan meet je het verkeerde.
 *
 * Wat dit WEL is: honderd AP-actors die de FEP-633c-handshake kunnen aannemen en
 * een hulpvraag kunnen sturen. Wat het NIET is: een Klonkt. Geen opslag van
 * timelines, geen weergave, geen C2S. Precies genoeg om aan de andere kant van
 * de lijn te staan.
 *
 * Sleutels staan in state.json en worden EEN keer gemaakt. Weggooien betekent
 * dat elke ward een vreemde wordt voor dev, en dat de handshake opnieuw moet.
 *
 *   node farm.mjs                 # start op poort 3060
 *   WARDS=100 PORT=3060 node farm.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
// GEEN TLS, en dat hoort ook zo (Barts vraag, 8-8: "waarom via https? gewoon
// localhost ::1"). Een certificaat en een publieke hostname toevoegen aan een
// doos die ook andermans sites draait, om honderd neptestkinderen te kunnen
// bereiken, is de verkeerde prijs. Klonkt laat dit adres door via AP_ALLOW_HOSTS
// -- een precies host:poort-paar, geen "loopback mag"-vlag.
//
// EN HET TOETST IETS DAT WE TOCH MOESTEN KUNNEN: http met HTTP-signatures, zonder
// TLS. Dat is een echt federatiegeval (interne netwerken, onion), en tot nu toe
// was het nergens uitgeprobeerd.
const BASE = process.env.BASE || 'http://[::1]:3060';
const PORT = Number(process.env.PORT || 3060);
const N = Number(process.env.WARDS || 100);
const HOST = new URL(BASE).host;

// ── Staat ────────────────────────────────────────────────────────────────
// Een plat bestand. Dit is een testkudde, geen instance: als de staat weg is
// begin je opnieuw, en dat hoort ook zo -- anders sluipt er toestand in waarvan
// niemand meer weet waar hij vandaan kwam.

function laadStaat() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { wards: {} }; }
}
function bewaarStaat(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

const staat = laadStaat();

function ward(n) {
  const naam = `w${String(n).padStart(3, '0')}`;
  if (!staat.wards[naam]) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    staat.wards[naam] = { naam, publicKey, privateKey, guardians: [], offers: {}, log: [] };
    bewaarStaat(staat);
  }
  return staat.wards[naam];
}

const uriVan = (naam) => `${BASE}/u/${naam}`;
const naamUit = (uri) => {
  const m = String(uri || '').match(/\/u\/(w\d{3})\/?$/);
  return m ? m[1] : null;
};

// ── Ondertekenen ─────────────────────────────────────────────────────────
// (request-target) host date digest -- wat Mastodon stuurt en wat Klonkt
// verwacht. Digest is verplicht zodra er een body is: zonder ondertekende
// digest bewijst een handtekening niets over de inhoud.

async function bezorg(w, inbox, activity) {
  const body = JSON.stringify(activity);
  const u = new URL(inbox);
  const date = new Date().toUTCString();
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
  const signingString = `(request-target): post ${u.pathname}\nhost: ${u.host}\ndate: ${date}\ndigest: ${digest}`;
  const signature = crypto.sign('sha256', Buffer.from(signingString), w.privateKey).toString('base64');
  const sig = `keyId="${uriVan(w.naam)}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`;
  const r = await fetch(inbox, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/activity+json',
      Accept: 'application/activity+json',
      Date: date, Digest: digest, Signature: sig,
    },
    body,
  });
  return r.status;
}

async function inboxVan(actorUri) {
  const r = await fetch(actorUri, { headers: { Accept: 'application/activity+json' } });
  if (!r.ok) throw new Error(`actor ${actorUri}: ${r.status}`);
  const doc = await r.json();
  return doc.inbox || (doc.endpoints && doc.endpoints.sharedInbox);
}

// ── De handshake (FEP-633c 3.1) ──────────────────────────────────────────
//
// De kandidaat biedt aan met een Offer van Relationship{subject: ward, object:
// kandidaat}, gericht aan de ward en aan de bestaande guardians. Elke partij
// accepteert. Wij zijn de WARD: wij accepteren, gericht aan alle anderen, en de
// kandidaat sluit af met de laatste Accept -- dat is de commit.
//
// AUTOMATISCH JA, en alleen omdat dit een testkudde is. Bij een echt kind is
// juist dit het moment waarop iemand moet nadenken; dat staat er hier expliciet
// bij zodat deze code nooit ergens anders terechtkomt.

async function verwerkInbox(w, activity) {
  const type = Array.isArray(activity.type) ? activity.type[0] : activity.type;
  const actor = typeof activity.actor === 'string' ? activity.actor : (activity.actor && activity.actor.id);
  w.log.push({ at: new Date().toISOString(), type, actor });
  if (w.log.length > 50) w.log = w.log.slice(-50);

  const o = activity.object;
  const relType = o && (Array.isArray(o.type) ? o.type[0] : o.type);

  if (type === 'Offer' && relType === 'Relationship') {
    const subject = typeof o.subject === 'string' ? o.subject : (o.subject && o.subject.id);
    if (subject !== uriVan(w.naam)) return 'niet voor mij';
    const kandidaat = typeof o.object === 'string' ? o.object : (o.object && o.object.id);
    w.offers[activity.id] = { kandidaat, at: Date.now() };
    bewaarStaat(staat);
    // Accepteren, gericht aan iedereen die in `to` stond plus de kandidaat, zodat
    // elke kopie van de telling dezelfde kant op loopt.
    const aan = [...new Set([...(Array.isArray(activity.to) ? activity.to : []), kandidaat])]
      .filter((x) => x && x !== uriVan(w.naam));
    for (const doel of aan) {
      try {
        const inbox = await inboxVan(doel);
        await bezorg(w, inbox, {
          '@context': ['https://www.w3.org/ns/activitystreams', { shaer: 'https://shaer.klonkt.com/ns#' }],
          id: `${uriVan(w.naam)}/accepts/${crypto.randomUUID()}`,
          type: 'Accept', actor: uriVan(w.naam), to: aan, object: activity,
        });
      } catch (e) { w.log.push({ at: new Date().toISOString(), fout: String(e.message) }); }
    }
    bewaarStaat(staat);
    return 'geaccepteerd';
  }

  if (type === 'Accept') {
    // De laatste Accept van de kandidaat is de commit (3.1.3). Wij houden hem
    // gewoon bij: wie ons bewaakt is het enige dat wij hoeven te weten.
    const binnenste = o && o.object;
    const rel = binnenste && (Array.isArray(binnenste.type) ? binnenste.type[0] : binnenste.type) === 'Relationship'
      ? binnenste : (relType === 'Relationship' ? o : null);
    const kandidaat = rel && (typeof rel.object === 'string' ? rel.object : (rel.object && rel.object.id));
    const wie = kandidaat || actor;
    if (wie && !w.guardians.includes(wie)) {
      w.guardians.push(wie);
      bewaarStaat(staat);
      return 'guardian erbij';
    }
    return 'al bekend';
  }

  if (type === 'Undo') {
    const rel = o && (Array.isArray(o.type) ? o.type[0] : o.type) === 'Relationship' ? o : null;
    const wie = rel && (typeof rel.object === 'string' ? rel.object : (rel.object && rel.object.id));
    if (wie) {
      w.guardians = w.guardians.filter((g) => g !== wie);
      bewaarStaat(staat);
      return 'guardian eraf';
    }
  }
  return 'genegeerd';
}

// ── Documenten ───────────────────────────────────────────────────────────

function actorDoc(w) {
  const id = uriVan(w.naam);
  const doc = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
      { shaer: 'https://shaer.klonkt.com/ns#' },
    ],
    id,
    type: 'Person',
    preferredUsername: w.naam,
    name: `Ward ${w.naam}`,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: w.publicKey },
  };
  // 2.1: alleen aanwezig als er echt guardians zijn. Een lege lijst zou zeggen
  // "dit kind heeft er geen", en dat is iets anders dan "nog niet gecommit".
  if (w.guardians.length) doc['shaer:guardians'] = w.guardians;
  return doc;
}

function stuur(res, code, body, type = 'application/activity+json') {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

// ── Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const p = u.pathname;

  if (p === '/.well-known/webfinger') {
    const m = String(u.searchParams.get('resource') || '').match(/^acct:(w\d{3})@/);
    if (!m) return stuur(res, 404, { error: 'not found' }, 'application/json');
    const id = uriVan(m[1]);
    return stuur(res, 200, {
      subject: `acct:${m[1]}@${HOST}`,
      links: [{ rel: 'self', type: 'application/activity+json', href: id }],
    }, 'application/jrd+json');
  }

  if (p === '/status') {
    const wards = Object.values(staat.wards);
    return stuur(res, 200, {
      wards: wards.length,
      metGuardian: wards.filter((w) => w.guardians.length).length,
      voorbeeld: wards[0] ? { naam: wards[0].naam, guardians: wards[0].guardians } : null,
    }, 'application/json');
  }

  const mInbox = p.match(/^\/u\/(w\d{3})\/inbox$/);
  if (mInbox && req.method === 'POST') {
    const w = staat.wards[mInbox[1]];
    if (!w) return stuur(res, 404, { error: 'no such ward' });
    let body = '';
    for await (const c of req) body += c;
    let uit = 'onleesbaar';
    try { uit = await verwerkInbox(w, JSON.parse(body)); }
    catch (e) { w.log.push({ at: new Date().toISOString(), fout: String(e.message) }); }
    // 202 hoe dan ook: een inbox die 4xx geeft op iets dat hij niet kent laat de
    // afzender eindeloos opnieuw proberen.
    return stuur(res, 202, { ok: true, uit });
  }

  const mOutbox = p.match(/^\/u\/(w\d{3})\/outbox$/);
  if (mOutbox) {
    return stuur(res, 200, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${uriVan(mOutbox[1])}/outbox`, type: 'OrderedCollection', totalItems: 0, orderedItems: [],
    });
  }

  const mActor = p.match(/^\/u\/(w\d{3})\/?$/);
  if (mActor) {
    const w = staat.wards[mActor[1]];
    if (!w) return stuur(res, 404, { error: 'no such ward' });
    return stuur(res, 200, actorDoc(w));
  }

  const mLog = p.match(/^\/u\/(w\d{3})\/log$/);
  if (mLog) {
    const w = staat.wards[mLog[1]];
    return w ? stuur(res, 200, w.log, 'application/json') : stuur(res, 404, {}, 'application/json');
  }

  stuur(res, 404, { error: 'not found' }, 'application/json');
});

// De sleutels vooraf maken, zodat de eerste binnenkomende fetch niet op
// keygen hoeft te wachten -- 100 keer 2048 bits duurt even.
for (let i = 1; i <= N; i++) ward(i);
bewaarStaat(staat);

server.listen(PORT, '::1', () => {
  console.log(`[farm] ${N} wards op ${BASE} (luistert op [::1]:${PORT})`);
});
