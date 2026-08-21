# Uitgaande follows van een ward — ontwerp

Bijbehorende beads: **shaer-p729** (bouwen) en **shaer-yeo5** (de spec-vraag:
informeren of gaten?). Dit document beantwoordt yeo5 en beschrijft wat p729
inhoudt.

FEP-633c §5.3 houdt follows *naar* een ward tegen tot de guardians beslissen.
Follows *van* een ward gaan ongehinderd de deur uit: `ingestOutboxActivity`
roept bij `case 'Follow'` meteen `followActor()` aan, zonder ward-check en
zonder wachtrij.

De guardians blijven niet in het duister. Sinds 1a2f206 krijgt elke guardian een
directe note zodra zijn ward iemand gaat volgen. Maar dat is Robins constatering
van 31-7 in één zin: **dat is informeren, geen gate.** De deur is al open op het
moment dat het bericht aankomt, en een guardian die te laat kijkt kan alleen nog
achteraf iets vinden van iets dat al gebeurd is.

De asymmetrie is half te verdedigen. `Block` (Shaers "Orbit") is uitgaand ook
ongated, en dat is de veilige richting: een kind dat zijn eigen wereld kleiner
maakt heeft geen toestemming nodig. Volgen is de richting die hem opent.

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

## Status

Gebouwd op 3-8-2026: `ap_pending_outgoing_follows` + `outgoing.js`, de poort in
`ingestOutboxActivity` (`case 'Follow'`), de `outgoingFollows`-wachtrij, en het
antwoord van de guardian op `POST /api/outgoing-follow/:id`. Negen tests in
`test/outgoing-follow-gate.test.js`.

## Open vragen

1. **Beantwoord (Bart, 3-8): bestaande followers worden gegrandfatherd.**
   `ap_followers` heeft nu `gate_approved`, gezet zodra de inkomende poort
   iemand toelaat. Iedereen die al volgde op het moment dat de kolom erbij kwam,
   krijgt de markering eenmalig mee: de regel is exact vanaf dat moment, in
   plaats van met terugwerkende kracht wantrouwig tegen relaties die er al
   waren. Wie daarna binnenkomt zonder poort — de followers van een vrije actor
   die later ward wordt — telt niet mee voor de wederkerigheid.

2. **Nog open. Mag de ward zijn eigen verzoek intrekken** zolang het in de wacht
   staat? `outgoing.withdraw()` bestaat al, maar er is nog geen route en geen
   knop. Lijkt vanzelfsprekend ja, maar het is een Undo op iets dat nooit
   verstuurd is.

3. **Beantwoord: de guardian zelf als doel wacht niet.** Dezelfde uitzondering
   als inkomend, waar de Follow van een vastgelegde guardian de poort overslaat.
   Gebouwd en getest.

4. **Nog open. Interactie met Block/Orbit.** Blokkeert de ward iemand terwijl er
   nog een verzoek voor die persoon open staat, dan moet dat verzoek verdwijnen.
   `withdraw()` is er klaar voor; het wordt alleen nog nergens aangeroepen.

5. **Nog open. Emancipatie.** Wat gebeurt er met openstaande verzoeken als de
   guardianship eindigt? Automatisch goedkeuren of laten vervallen.

6. **Nieuw, uit het bouwen. Er zit geen venster op een verzoek.** Een uitgaande
   follow die niemand beantwoordt blijft staan tot iemand hem beantwoordt —
   dezelfde omissie die de handshake had voordat er een week op kwam (§3.5). Een
   kind dat vraagt of het iemand mag volgen en nooit antwoord krijgt, verdient
   een afloop.

## Raakvlakken met andere beads

- **shaer-3kp** (gated features, guardian-overeengekomen instellingen) noemt
  "following approve" al met zoveel woorden. Dat is de plek waar het beleid
  hoort te wonen: één instellingen-object op de ward met de server als bron van
  waarheid. Dit ontwerp moet daar een veld in zijn, geen eigen mechaniek ernaast.
- **shaer-h6u** (lokale guardian via de lijn i.p.v. de gedeelde database) raakt
  de bezorgweg die hier ook gebruikt wordt.
- **shaer-zjt** bouwt het guardian-dashboard mét quorumteller; de nieuwe
  wachtrij moet daar meteen in passen.

### De quorum-kolom is nooit aangesloten

Los van dit ontwerp, en niet in een bead gevonden: `ap_pending_follows.quorum`
wordt door de aanroep in `ActivityPubService.js` nooit meegegeven, dus alles
valt terug op de default `'any'`. `'all'` bestaat alleen in de vergelijking in
`decide()` en wordt nergens geschreven; `'none'` heeft helemaal geen tak en zou
zich als `'any'` gedragen in plaats van als "open". shaer-hxg is gesloten met
"quorum any/all" als opgeleverd, en `test/follow-gating.test.js` slaagt omdat de
test de waarde zelf meegeeft — precies het pad dat productie nooit neemt.

Gevolg: een ward met drie guardians gaat vandaag open op één goedkeuring, ook
als iemand dacht `all` te hebben ingesteld. Verdient een eigen bead, en de
oplossing hangt samen met shaer-3kp: als het beleid daar komt te wonen, is dat
meteen de plek waar de inkomende kant zijn quorum vandaan haalt.

## Daemon-pariteit

De daemon-README is er stellig over: de apps moeten zich tegen beide backends
hetzelfde gedragen, en als daemon en Klonkt uit elkaar lopen is de UI die je
lokaal test een leugen. Wat hier landt, landt dus ook in `shaer-daemon`
(`gate.rs` heeft nu alleen de inkomende kant), en de wachtrij-namen en de
`awaiting_guardian`-status moeten letterlijk gelijk zijn.
