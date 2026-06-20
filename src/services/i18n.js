// i18n — eenvoudige interface-vertaling (UI-strings), bezoeker-instelbaar.
//
// Taalkeuze: req.session.lang (gezet via /lang/:code) → anders browser-taal
// (Accept-Language) → anders 'nl'. De helper t(lang, key, vars) zoekt de string op
// in DICT[lang], valt terug op 'nl', dan op de key zelf. Alleen INTERFACE-teksten;
// door gebruikers geschreven content (posts, sitenaam, bio) wordt niet vertaald.

export const SUPPORTED = ['nl', 'en', 'de'];
export const LANG_NAMES = { nl: 'Nederlands', en: 'English', de: 'Deutsch' };

const DICT = {
  nl: {
    'nav.back_to_site': '← Terug naar site',
    'nav.home': 'Home',
    'nav.archive': 'Archief',
    'nav.search': 'Zoeken',
    'nav.theme': 'Thema wisselen',
    'nav.install': 'App installeren',
    'nav.login': 'Inloggen',
    'nav.logout': 'Uitloggen',
    'nav.admin': 'Beheer',
    'nav.account': 'Account',
    'nav.profile': 'Profiel',
    'nav.favorites': 'Favorieten',
    'nav.new_post': 'Nieuwe post',
    'nav.language': 'Taal',
    'switch.agenda': 'Agenda',
    'switch.solo': 'Solo',
    'switch.circle': 'Cirkel',
    'switch.timeline': 'Tijdlijn',
    'switch.grid': 'Grid',
    'postnav.newer': 'Nieuwer',
    'postnav.older': 'Ouder',
    'postnav.newest': 'Nieuwste post',
    'postnav.oldest': 'Oudste post',
    'footer.subscribe_cta': 'Blijf op de hoogte',
    'footer.subscribe': 'Inschrijven',
    'footer.install': 'Installeer app',
    'common.email_placeholder': 'jouw@email.nl',
  },
  en: {
    'nav.back_to_site': '← Back to site',
    'nav.home': 'Home',
    'nav.archive': 'Archive',
    'nav.search': 'Search',
    'nav.theme': 'Toggle theme',
    'nav.install': 'Install app',
    'nav.login': 'Log in',
    'nav.logout': 'Log out',
    'nav.admin': 'Admin',
    'nav.account': 'Account',
    'nav.profile': 'Profile',
    'nav.favorites': 'Favorites',
    'nav.new_post': 'New post',
    'nav.language': 'Language',
    'switch.agenda': 'Agenda',
    'switch.solo': 'Solo',
    'switch.circle': 'Circle',
    'switch.timeline': 'Timeline',
    'switch.grid': 'Grid',
    'postnav.newer': 'Newer',
    'postnav.older': 'Older',
    'postnav.newest': 'Newest post',
    'postnav.oldest': 'Oldest post',
    'footer.subscribe_cta': 'Stay in the loop',
    'footer.subscribe': 'Subscribe',
    'footer.install': 'Install app',
    'common.email_placeholder': 'you@email.com',
  },
  de: {
    'nav.back_to_site': '← Zurück zur Seite',
    'nav.home': 'Start',
    'nav.archive': 'Archiv',
    'nav.search': 'Suche',
    'nav.theme': 'Thema wechseln',
    'nav.install': 'App installieren',
    'nav.login': 'Anmelden',
    'nav.logout': 'Abmelden',
    'nav.admin': 'Verwaltung',
    'nav.account': 'Konto',
    'nav.profile': 'Profil',
    'nav.favorites': 'Favoriten',
    'nav.new_post': 'Neuer Beitrag',
    'nav.language': 'Sprache',
    'switch.agenda': 'Termine',
    'switch.solo': 'Solo',
    'switch.circle': 'Kreis',
    'switch.timeline': 'Zeitleiste',
    'switch.grid': 'Raster',
    'postnav.newer': 'Neuer',
    'postnav.older': 'Älter',
    'postnav.newest': 'Neuester Beitrag',
    'postnav.oldest': 'Ältester Beitrag',
    'footer.subscribe_cta': 'Bleib auf dem Laufenden',
    'footer.subscribe': 'Abonnieren',
    'footer.install': 'App installieren',
    'common.email_placeholder': 'du@email.de',
  },
};

export function t(lang, key, vars) {
  const l = SUPPORTED.includes(lang) ? lang : 'nl';
  let s = (DICT[l] && DICT[l][key]);
  if (s === undefined) s = (DICT.nl[key] !== undefined ? DICT.nl[key] : key);
  if (vars) for (const k in vars) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
  return s;
}

// Bepaal de taal voor dit request: sessie-keuze → browser-taal → nl.
export function resolveLang(req) {
  const s = req && req.session && req.session.lang;
  if (s && SUPPORTED.includes(s)) return s;
  const al = ((req && req.headers && req.headers['accept-language']) || '').toLowerCase();
  const first = al.split(',')[0].trim().slice(0, 2);
  if (SUPPORTED.includes(first)) return first;
  return 'nl';
}
