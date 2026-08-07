//
// Welke instance bedoel je?
//
// Op een split install (deploy/MULTI-INSTANCE.md) deelt elke Klonkt dezelfde code
// in /opt/klonkt, maar staat zijn DATA onder /var/lib/klonkt/<slug>/ met een eigen
// .env. Een script dat vanuit de code-map draait zonder die .env te lezen opent
// dus de VERKEERDE database -- en op een machine die ooit de oude enkelvoudige
// opzet draaide is dat een achtergebleven storage/database.sqlite in de checkout.
//
// Dat ging in de praktijk mis en op de ergste manier: het meldde SUCCES. Een
// export van een site met zeven jaar aan posten schreef een archief van 444 bytes
// met "posts: 0", omdat hij in een oude lege database keek. Een leeg archief dat
// zegt dat het gelukt is, is erger dan een foutmelding.
//
// Vandaar dit: los, want de importer en het herstel hebben hem net zo hard nodig.

import fs from 'fs';
import path from 'path';

/** Lees een .env zonder afhankelijkheden. Alleen KEY=value, # is commentaar. */
export function leesEnv(pad) {
  const uit = {};
  for (const regel of fs.readFileSync(pad, 'utf8').split('\n')) {
    const s = regel.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    uit[s.slice(0, i).trim()] = v;
  }
  return uit;
}

/**
 * Zet de omgeving voor EEN instance, en zeg hardop welke.
 *
 * Moet AANGEROEPEN WORDEN VOORDAT src/config/database.js geladen wordt: die leest
 * DATABASE_PATH bij import en opent de database meteen. Vandaar dat de scripts
 * hun service-import uitstellen tot na deze aanroep.
 *
 * @returns {{bron: string, env: object}} waar de instellingen vandaan kwamen
 */
export function kiesInstance(slug, opts = {}) {
  const dataRoot = opts.dataRoot || process.env.KLONKT_DATA_ROOT || '/var/lib/klonkt';
  const kandidaat = opts.envPad || path.join(dataRoot, slug, '.env');

  if (fs.existsSync(kandidaat)) {
    const env = leesEnv(kandidaat);
    // De data-map van de instance is de wortel voor relatieve paden in zijn .env,
    // precies zoals de unit hem draait (WorkingDirectory is de code, DATA_DIR de data).
    const basis = env.DATA_DIR || path.dirname(kandidaat);
    const absoluut = (p) => (p && !path.isAbsolute(p) ? path.resolve(basis, p) : p);
    for (const k of ['DATABASE_PATH', 'MEDIA_PATH', 'AUDIO_PATH', 'AVATAR_PATH', 'COVER_PATH']) {
      if (env[k]) process.env[k] = absoluut(env[k]);
    }
    if (env.PUBLIC_BASE_URL) process.env.PUBLIC_BASE_URL = env.PUBLIC_BASE_URL;
    if (env.DATA_DIR) process.env.DATA_DIR = env.DATA_DIR;
    return { bron: kandidaat, env };
  }

  if (opts.envPad) {
    // Expliciet meegegeven en niet gevonden: dat is een vergissing en geen reden
    // om stilletjes iets anders te openen.
    throw new Error(`geen .env op ${opts.envPad}`);
  }
  return { bron: null, env: {} };
}

/**
 * Weiger te beginnen als we niet kunnen weten wiens gegevens dit zijn.
 *
 * Zonder PUBLIC_BASE_URL komt er een archief uit met een lege `origin`, en dan
 * weigert de importer de AP-ids te behouden -- hij maakt nieuwe. Daarmee valt
 * precies de belofte weg waar het formaat om draait: een herstel waarna de
 * boosts en antwoorden elders hun post terugvinden. Dat mag geen voetnoot in de
 * uitvoer zijn.
 */
export function eisOrigin(bron) {
  if (process.env.PUBLIC_BASE_URL) return;
  console.error([
    'GESTOPT: er is geen PUBLIC_BASE_URL.',
    '',
    'Zonder die waarde krijgt het archief een lege origin, en dan maakt een import',
    'NIEUWE ActivityPub-ids in plaats van de oude te behouden. Boosts, likes en',
    'antwoorden elders vinden hun post dan niet meer terug -- het archief is dan',
    'een kopie van de tekst en geen herstel.',
    '',
    bron
      ? `Gelezen uit ${bron}, maar PUBLIC_BASE_URL staat daar niet in.`
      : 'Geen .env van een instance gevonden. Op een split install:\n'
        + '  node scripts/export-archive.mjs <slug> --data-root /var/lib/klonkt',
  ].join('\n'));
  process.exit(1);
}

/**
 * Argumenten splitsen in vrije woorden en vlaggen.
 *
 * Nodig omdat de naieve versie -- alles wat niet met een streepje begint is
 * positioneel -- de WAARDE van een vlag als positioneel argument oppikt. Met
 * `export-archive.mjs liz --data-root /var/lib/klonkt` werd /var/lib/klonkt de
 * site-slug. Precies zo'n fout die pas opvalt als iemand hem gebruikt.
 *
 * @param {string[]} args
 * @param {string[]} metWaarde  vlaggen die een waarde slikken
 */
export function splitsArgs(args, metWaarde) {
  const vrij = [];
  const vlaggen = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) { vrij.push(a); continue; }
    if (metWaarde.includes(a)) { vlaggen[a] = args[i + 1] ?? null; i += 1; continue; }
    vlaggen[a] = true;
  }
  return { vrij, vlaggen };
}
