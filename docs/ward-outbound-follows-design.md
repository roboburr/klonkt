# Uitgaande follows van een ward — ontwerp

FEP-633c §5.3 houdt follows *naar* een ward tegen tot de guardians beslissen.
Follows *van* een ward gaan ongehinderd de deur uit. `ingestOutboxActivity`
roept bij `case 'Follow'` meteen `followActor()` aan: geen ward-check, geen
guardian, geen wachtrij. `mee` heeft een vastgelegde guardian en kan vandaag
iedereen op de fediverse volgen zonder dat iemand het ziet.

De asymmetrie is half te verdedigen. `Block` (Shaers "Orbit") is uitgaand ook
ongated, en dat is de veilige richting: een kind dat zijn eigen wereld kleiner
maakt heeft geen toestemming nodig. Volgen is de richting die hem opent.

Er staat hierover niets in de docs of de FEP-notities. Dit is dus een gat in het
ontwerp, niet een ongeschreven stuk implementatie.

## De regel

**Per geval goedkeuring, met automatische goedkeuring bij wederkerigheid.**

Volgt de ward iemand die de ward al volgt, dan hoeft er niemand meer naar te
kijken. Die actor is namelijk al door de inkomende poort gekomen, en dat betekent
dat een guardian er al ja tegen heeft gezegd. Nog een keer vragen is dezelfde
vraag twee keer stellen, en elke overbodige vraag is er een die de volgende keer
minder aandacht krijgt.

Het predicaat is `target_uri ∈ ap_followers(slug)`. Kort, maar het klopt alleen
zolang lidmaatschap van die tabel écht een guardian-besluit impliceert — zie de
eerste open vraag.

## Beslissingen

- **Een eigen tabel, niet `ap_pending_follows`.** Die tabel is gesleuteld op
  `(ward_slug, follower_uri)`: de ward is daar het *doel*. Uitgaand draait dat
  om. Een `direction`-kolom erbij zou elke bestaande query dubbelzinnig maken,
  inclusief `listForWard`, die nu simpelweg "wie wil mij volgen" betekent. Dus
  `ap_pending_outgoing_follows (id, ward_slug, target_uri, target_inbox,
  target_name, target_handle, target_icon, quorum, status, created_at)` met
  dezelfde vorm en dezelfde `decide()`-semantiek, maar apart.

- **`ap_following.status` is al bezet en betekent iets anders.** Daar staat
  `pending` voor "wij hebben de Follow verstuurd, hun Accept moet nog komen".
  Een guardian-pending follow is nog helemaal niet verstuurd. Twee verschillende
  wachttoestanden op één kolom is precies het soort dubbelzinnigheid dat later
  een bug wordt. Daarom: **de `ap_following`-rij ontstaat pas bij goedkeuring**,
  op het moment dat de Follow daadwerkelijk uitgaat. Vóór die tijd bestaat het
  verzoek alleen in de nieuwe tabel.

- **Wederkerigheid is een momentopname.** Getoetst bij het verzoek, niet
  doorlopend bewaakt. Ontvolgt de ander later, dan wordt een al goedgekeurde
  follow niet met terugwerkende kracht ingetrokken. Anders krijg je een relatie
  die stilletjes verdwijnt door een actie van een derde.

- **Quorum: `any` hergebruiken, maar het eindelijk ergens vastleggen.** De kolom
  `quorum` bestaat op `ap_pending_follows`, maar de aanroep in
  `ActivityPubService.js` geeft hem nooit mee. Alles valt dus terug op de default
  `'any'`, en `'all'` en `'none'` zijn in de praktijk dood. Een uitgaand beleid
  heeft een echte plek nodig — per ward, niet per verzoek — en dat is het moment
  om de inkomende kant dezelfde plek te laten gebruiken.

- **De wachtrij splitsen.** `shaer:queues.follows` staat al op het actor-document.
  Als beide richtingen daarin landen, kan een guardian "iemand wil Mee volgen"
  niet onderscheiden van "Mee wil iemand volgen" — twee vragen die in de
  interface verschillende woorden verdienen. Dus `follows` blijft inkomend
  (compatibel) en er komt `shaer:queues.outgoingFollows` naast.

  Let op: nieuwe termen moeten in `AP_CONTEXT` of `test/activitypub-as2.test.js`
  valt om. Die test eist dat elke uitgestuurde sleutel AS2-core is of in de
  federatie-context staat, en dat is precies de bedoeling ervan.

- **Cross-instance: spiegel het `Offer(Follow)`-patroon.** Een lokale guardian
  leest `/guardian` rechtstreeks; een guardian op een andere server krijgt een
  Offer afgeleverd zodat zijn instance een kopie opslaat, net als bij de
  adoptie-offer en bij `ap_follow_reviews`. Voor `mee` (ward op `loop`) en
  `boiert` (guardian op `boiert`) zijn dat twee instances op dezelfde machine,
  dus die weg wordt meteen echt gelopen en niet gesimuleerd.

- **Een tegengehouden follow mag er niet uitzien als een gelukte.** Dit is
  dezelfde les als in de bestaande `case 'Follow'`: *"De error REACHT de app
  (Robins melding, 31-7): het wegslikken maakte een mislukte follow precies
  gelijk aan een gelukte."* Een verzoek in de wacht is een derde uitkomst en de
  app moet die kunnen tonen. Voorstel: `202` met een expliciete status in de body
  (`{ ok: true, status: 'awaiting_guardian', id }`), zodat Shaer "wacht op
  toestemming" kan laten zien in plaats van een tegel die er al volgend uitziet.

## Open vragen

1. **Wat doen we met followers van vóór de adoptie?** Was de ward eerst een vrije
   actor, dan zijn zijn bestaande followers nooit door een guardian gezien. Bij de
   regel hierboven worden dat stuk voor stuk automatisch goed te keuren doelen.
   Ofwel we accepteren dat, ofwel `ap_followers` krijgt een markering "door de
   poort gekomen" en alleen die telt mee. Dit is de belangrijkste vraag van dit
   document.

2. **Mag de ward zijn eigen verzoek intrekken** zolang het in de wacht staat? Lijkt
   vanzelfsprekend ja, maar het is een Undo op iets dat nooit verstuurd is.

3. **De guardian zelf als doel.** Een ward die zijn eigen guardian volgt, hoort
   niet te hoeven wachten. Dat is dezelfde uitzondering als inkomend, waar de
   Follow van een vastgelegde guardian de poort overslaat.

4. **Interactie met Block/Orbit.** Blokkeert de ward iemand terwijl er nog een
   verzoek voor die persoon open staat, dan moet dat verzoek verdwijnen.

5. **Emancipatie.** Wat gebeurt er met openstaande verzoeken als de
   guardianship eindigt? Automatisch goedkeuren of laten vervallen.

## Daemon-pariteit

De daemon-README is er stellig over: de apps moeten zich tegen beide backends
hetzelfde gedragen, en als daemon en Klonkt uit elkaar lopen is de UI die je
lokaal test een leugen. Wat hier landt, landt dus ook in `shaer-daemon`
(`gate.rs` heeft nu alleen de inkomende kant), en de wachtrij-namen en de
`awaiting_guardian`-status moeten letterlijk gelijk zijn.
