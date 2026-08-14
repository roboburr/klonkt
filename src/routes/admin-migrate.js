/**
 * admin-migrate.js — Beheer → Migreren: je posts en media naar een andere Klonkt.
 *
 * Dezelfde machinerie als scripts/export-archive.mjs en import-archive.mjs, maar via
 * de webinterface, zodat verhuizen geen SSH-toegang meer vraagt. De services doen
 * het werk; deze routes zijn de deur.
 *
 * DRIE KEUZES DIE ER TOE DOEN:
 *
 * 1. IMPORTEREN GAAT ALTIJD EERST DROOG. Je krijgt een verslag te zien en pas
 *    daarna een knop die het echt doet. Een archief inlezen is niet terug te
 *    draaien, en "ik dacht dat ik alleen keek" is de duurste vergissing hier.
 *
 * 2. OVERSCHRIJVEN IS EEN APARTE, GEWAARSCHUWDE KEUZE. importArchive gebruikt
 *    INSERT OR REPLACE, en dat verwijdert ELKE rij die een unieke sleutel schendt:
 *    een post met een ander id maar dezelfde slug gaat dus stil mee (zie shaer-snv5).
 *    Standaard slaat hij bestaande posts over, en dat blijft ook de standaard hier.
 *
 * 3. HET ARCHIEF WORDT IN GEHEUGEN GEBOUWD. buildArchive levert een Map van
 *    Buffers; bij veel media is dat een forse allocatie. Daarom een harde grens en
 *    een eerlijke melding in plaats van een proces dat omvalt. Streamen is
 *    shaer-190t en hoort daar thuis, niet hier.
 */
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import ActivityPubService from '../services/ActivityPubService.js';
import { safeFetch, signedGetJson, signedGetHeaders, noteId, noteVisibility } from '../services/ActivityPubService.js';
import HtmlSanitizerService from '../services/HtmlSanitizerService.js';
import { MEDIA_ROOT, AUDIO_ROOT } from '../config/paths.js';
import * as Migration from '../services/MigrationService.js';
import { buildArchive, zipArchive } from '../services/ArchiveExportService.js';
import { readArchiveZip, importArchive } from '../services/ArchiveImportService.js';
import { parseApAliases } from './admin-sites.js';
import db from '../config/database.js';

const router = express.Router();

// Ruim genoeg voor een gewone site met media, klein genoeg om een instance niet om
// te laten vallen op een archief dat iemand toevallig aanlevert.
const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_EXPORT = 512 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
}).single('archief');

const mb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} kB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

/** Wat zou er in een export zitten? Droog gebouwd, dus zonder zip. */
function tellen(site) {
  if (!site) return { telling: null, fout: null };
  try {
    const r = buildArchive(site.slug);
    let bytes = 0;
    for (const buf of r.files.values()) bytes += buf.length;
    // ontbrekend telt alleen de MEDIA-verwijzingen; audioMissing komt uit
    // buildArchive zelf. Ze door elkaar husselen was precies hoe "39
    // mediabestanden, 14 ontbrekend" een bibliotheek van 140 nummers kon
    // verzwijgen.
    const mediaWeg = r.missing.filter((m) => !m.track).length;
    return {
      telling: {
        ...r.counts, bytes, groot: bytes > MAX_EXPORT,
        ontbrekend: mediaWeg, audioMissing: r.counts.audioMissing || 0,
      },
      fout: null,
    };
  } catch (e) { return { telling: null, fout: e && e.message }; }
}

/**
 * De gekoppelde accounts als tekst, een per regel.
 *
 * Als HANDLE, niet als de opgeslagen URL. Je typt @jij@mastodon.social, wij
 * slaan de actor-URL op omdat de rest van het protocol daarop draait, en dan
 * kreeg je een adres terug dat je nooit hebt ingetypt en niet herkent. Wat je
 * hier ziet hoort te lijken op wat je gaf.
 *
 * Alleen als er echt een handle uit te halen valt; anders de URL, want een
 * verkeerde handle is erger dan een lelijke URL. parseApAliases leest beide
 * vormen, dus opslaan blijft werken wat er ook in het veld staat.
 */
function aliasTekst(site) {
  try {
    const lijst = JSON.parse((site && site.ap_aliases) || '[]') || [];
    return lijst.map((u) => {
      const h = ActivityPubService.deriveHandle(u);
      return /^@[^@\s]+@[^@\s]+$/.test(h) ? h : u;
    }).join('\n');
  } catch { return ''; }
}

/**
 * Waar sta je in de verhuizing?
 *
 * Deze pagina draait op BEIDE instanties en elke stap hoort maar op een van de
 * twee. Zonder dat onderscheid leest de lijst als onzin op de helft van de
 * schermen. Vandaar: afleiden wat we kunnen zien, en verder eerlijk zeggen
 * waar iets thuishoort in plaats van het te raden.
 */
function stappen(site, mig) {
  const alias = aliasTekst(site).trim();
  return {
    // moved_to gezet betekent: DIT is de instantie die vertrokken is.
    isOud: !!(site && site.moved_to),
    geclaimd: !!alias,
    // Een Move in onze moves-collectie betekent dat de bron hierheen verhuisd is.
    aangekondigd: !!(site && site.moved_to) || !!(mig && mig.moves > 0),
    opgehaald: !!(mig && mig.total > 0),
  };
}

/**
 * Waar zouden we vandaan kunnen halen? De alias die we zelf claimen (FEP-7628
 * alsoKnownAs). Dat is niet toevallig hetzelfde veld als waar de ingest op
 * controleert: het is de helft van de afspraak die je hier al gezet hebt.
 */
function bronKandidaat(site) {
  try {
    const aka = JSON.parse((site && site.ap_aliases) || '[]');
    return Array.isArray(aka) ? aka.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || null : null;
  } catch { return null; }
}

/** De pagina. Toont wat er in een export zou zitten, zonder hem te bouwen. */
router.get('/', requireGod, (req, res) => {
  // Droog bouwen om te tellen. Dat kost hetzelfde geheugen als een echte export,
  // dus hier meteen de grens bewaken in plaats van pas bij de download.
  const site = res.locals.site;
  const { telling, fout } = tellen(site);
  const _mig = site ? Migration.migrationStatus(site.slug) : null;
  renderPage(req, res, 'pages/admin-migrate', {
    pageTitle: 'Migreren', bodyClass: 'on-special',
    telling, fout, mb,
    verslag: null,
    bron: bronKandidaat(site), aliassen: aliasTekst(site), movedTo: (site && site.moved_to) || null,
    mig: _mig, stap: stappen(site, _mig),
    haalVerslag: null,
    success: req.query.success || null, error: req.query.error || fout || null,
  });
});

/**
 * FEP-1580: haal de berichten rechtstreeks bij je oude Klonkt op.
 *
 * Geen code, geen token: de autorisatie IS de Move die je al gedaan hebt. De
 * oude instantie geeft ons zijn eigen kijkrechten omdat `moved_to` daar naar
 * ons wijst, en dat veld staat er alleen als wij hem toen al in alsoKnownAs
 * hadden. Beide kanten hebben dus ooit ja gezegd, en dat is precies waarom
 * hier geen tweede vertrouwensmechanisme bij hoeft.
 *
 * De ingest kijkt die afspraak zelf nog een keer na, in beide richtingen. Dit
 * is een deur, geen controle.
 */
router.post('/pull', requireGod, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.redirect('/admin/migrate?error=' + encodeURIComponent('Geen site'));
  const opgegeven = String(req.body && req.body.bron ? req.body.bron : '').trim();
  let r = null;
  try {
    r = await Migration.ingestFromSource(site, {
      sourceUri: opgegeven || null,
      deps: {
        getJson: signedGetJson, safeFetch, mediaRoot: MEDIA_ROOT, audioRoot: AUDIO_ROOT, fs, path, noteId, noteVisibility, signHeaders: signedGetHeaders,
        sanitize: (h) => HtmlSanitizerService.sanitize(h || ''),
      },
    });
  } catch (e) {
    r = { error: 'crash', melding: e && e.message };
  }
  const { telling } = tellen(site);
  const _mig2 = Migration.migrationStatus(site.slug);
  renderPage(req, res, 'pages/admin-migrate', {
    pageTitle: 'Migreren', bodyClass: 'on-special',
    telling, fout: null, mb, verslag: null,
    bron: opgegeven || bronKandidaat(site), aliassen: aliasTekst(site), movedTo: site.moved_to || null,
    mig: _mig2, stap: stappen(site, _mig2),
    haalVerslag: r,
    success: (r && !r.error) ? 'Opgehaald' : null,
    error: null,
  });
});

/**
 * Je oude account claimen (FEP-7628 alsoKnownAs).
 *
 * Stond op de site-bewerkpagina, tussen de kleuren en de feedinstellingen. Maar
 * dit is stap EEN van een verhuizing, en zonder deze claim weigert de oude
 * instantie de Move met `no_backreference`. Het hoort dus hier, boven de knop
 * die hem nodig heeft.
 */
router.post('/aliases', requireGod, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.redirect('/admin/migrate?error=' + encodeURIComponent('Geen site'));
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  let lijst;
  try {
    lijst = await parseApAliases(req.body.ap_aliases, ActivityPubService.actorId(base, site.slug));
  } catch (e) {
    // Welke regel niet deugde, niet alleen DAT er iets niet deugde.
    return res.redirect('/admin/migrate?error=' + encodeURIComponent(`Onbruikbaar adres: ${e && e.message}`));
  }
  db.prepare('UPDATE sites SET ap_aliases = ? WHERE slug = ?').run(JSON.stringify(lijst), site.slug);
  res.redirect('/admin/migrate?success=' + encodeURIComponent(
    lijst.length ? `${lijst.length} adres(sen) opgeslagen als jouw vorige account.` : 'Aliassen leeggemaakt.'));
});

/** Download het archief als zip. */
router.get('/export', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.redirect('/admin/migrate?error=' + encodeURIComponent('Geen site'));
  try {
    const r = buildArchive(site.slug);
    const zip = zipArchive(r.files);
    if (zip.length > MAX_EXPORT) {
      return res.redirect('/admin/migrate?error=' + encodeURIComponent(
        `Het archief is ${mb(zip.length)} en dat is te groot voor de webinterface. Gebruik scripts/export-archive.mjs op de server.`));
    }
    const naam = `klonkt-${site.slug}-${new Date().toISOString().slice(0, 10)}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${naam}"`);
    // Privé: dit is je hele site, niets voor een cache onderweg.
    res.set('Cache-Control', 'private, no-store');
    res.send(zip);
  } catch (e) {
    res.redirect('/admin/migrate?error=' + encodeURIComponent(`Exporteren mislukt: ${e && e.message}`));
  }
});

/**
 * Importeren. Zonder `echt=1` is dit een DROOGLOOP: hij leest het archief, meldt
 * wat er zou gebeuren, en raakt niets aan.
 */
router.post('/import', requireGod, upload, async (req, res) => {
  const site = res.locals.site;
  if (!site) return res.redirect('/admin/migrate?error=' + encodeURIComponent('Geen site'));
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.redirect('/admin/migrate?error=' + encodeURIComponent('Geen bestand ontvangen'));
  }

  const echt = String(req.body.echt || '') === '1';
  const overschrijf = String(req.body.overschrijf || '') === '1';

  let verslag = null;
  let fout = null;
  try {
    const files = readArchiveZip(req.file.buffer);
    verslag = importArchive(files, {
      slug: site.slug,
      dryRun: !echt,
      overwrite: overschrijf,
    });
  } catch (e) {
    fout = e && e.message;
  }

  // Bij een DROOGLOOP blijven we op de pagina met het verslag, zodat je kunt
  // besluiten. Bij een echte import ook, maar dan met de uitkomst.
  renderPage(req, res, 'pages/admin-migrate', {
    pageTitle: 'Migreren', bodyClass: 'on-special',
    telling: tellen(site).telling, fout: null, mb,
    bron: bronKandidaat(site), aliassen: aliasTekst(site), movedTo: site.moved_to || null,
    mig: Migration.migrationStatus(site.slug), stap: stappen(site, Migration.migrationStatus(site.slug)), haalVerslag: null,
    verslag: verslag ? { ...verslag, echt, overschrijf, bestand: req.file.originalname, bytes: req.file.buffer.length } : null,
    success: (echt && verslag && !fout) ? 'Archief geïmporteerd' : null,
    error: fout ? `Importeren mislukt: ${fout}` : null,
  });
});

export default router;
