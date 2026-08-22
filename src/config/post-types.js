/**
 * Welke posttypes bestaan er. (shaer-cyg)
 *
 * Dit stond op drie plaatsen los van elkaar: twee keer in routes/posts.js (het
 * opslaan) en een keer in routes/types.js (de /type/-pagina's). Zolang die
 * lijsten hetzelfde waren viel dat niet op, maar het is precies het soort naad
 * dat stil faalt: kent de opslag 'playlist' niet, dan wordt de post zonder
 * melding een gewone post, en dan is de keuze verdwenen in plaats van geweigerd.
 *
 * AUDIO STAAT ER NOG WEL IN, MAAR IS GEEN KEUZE MEER. Alles wat muziek is landt
 * voortaan op album of playlist (Robins besluit, 8-8). Bestaande posts hebben
 * type=audio nog wel, dus /type/audio moet blijven werken en het opslaan van
 * zo'n post mag zijn type niet stilzwijgend weggooien -- tot de backfill hem
 * heeft omgezet. Daarna kan audio hier weg.
 *
 * MIXTAPE erbij (Robins idee, 21-8): een bandje, samengesteld uit de nummers
 * van een playlist, dat alleen vooruit en achteruit speelt. Het draagt muziek,
 * dus het deelt het muziekpaneel en de afleiding met album en playlist -- het
 * verschil zit in de playlist die je insluit, niet in wat je hier uploadt.
 */

/** Types die een gebruiker in de editor kan kiezen. */
export const KEUZE_TYPES = ['post', 'foto', 'video', 'album', 'playlist', 'mixtape'];

/** Alles wat in de kolom posts.type mag staan, inclusief wat er historisch is. */
export const POST_TYPES = new Set([...KEUZE_TYPES, 'audio']);

/** De types die muziek dragen -- ze delen hetzelfde paneel en dezelfde afleiding. */
export const MUZIEK_TYPES = new Set(['album', 'playlist', 'audio', 'mixtape']);
