# Wijzigingen — Klonkt

Alle noemenswaardige wijzigingen aan Klonkt. Nieuwste bovenaan.
Versies volgen [SemVer](https://semver.org/lang/nl/) (`1.0.0-beta.N` tijdens de beta).

## [Unreleased]

## [1.7.1] · 2026-08-21

### Opgelost
- **Een vergeten adminwachtwoord resetten werkt nu ook als meerdere instanties
  één kopie van de code delen.** In de opstelling van `deploy/klonkt@.service`
  staat de code op `/opt/klonkt` en houdt elke instantie zijn configuratie in
  `/var/lib/klonkt/<slug>/.env`, die systemd leest via `EnvironmentFile=`. Een
  script dat je zelf start krijgt die omgeving niet, dus `npm run reset-admin`
  draaide zonder `DATABASE_PATH`: hij legde een lege database in de gedeelde,
  read-only codemap en klapte daarna op `no such table: users` — een stacktrace
  op de plek waar een aanwijzing hoort. Noem voortaan de instantie:
  `npm run reset-admin -- --instance <slug>`. Die leest hetzelfde bestand als
  systemd, en een expliciet genoemde instantie wint nu van een `DATABASE_PATH`
  die nog in je shell hangt.
- **Het resetscript maakt nooit een database aan.** Een ontbrekend bestand
  betekent bijna altijd dat de configuratie niet geladen is en niet dat de site
  leeg is, dus hij stopt en noemt het pad dat hij wilde openen. Bij een
  geslaagde reset noemt hij ook wélke database hij bewerkt heeft — met meerdere
  datamappen is dat de enige vraag die ertoe doet.

## [1.7.0] · 2026-08-21

### Toegevoegd
- **Je muziek reist als muziek, niet als een verwijzing ernaartoe.** Een track
  ging de draad op als een bericht met een bestand eraan, dus een andere server
  zag tekst met een bijlage en niets wat zei "dit is een uitgave van deze
  artiest". Tracks zijn nu volwaardige Audio-objecten, een album is een eigen
  object op de draad, en de outbox draagt de discografie mee. Playlists federeren
  als ActivityPub-collecties en zijn als zodanig vindbaar. De vormen volgen wat
  Funkwhale al spreekt, zodat een Klonkt-uitgave in een Funkwhale-bibliotheek
  belandt in plaats van te worden weggegooid.
- **De post is de uitgave.** Losse tracks in één post worden een collectie, de
  uitgavedatum en het MusicBrainz release-id gaan mee, en de hashtags worden uit
  de ruwe tekst gelezen in plaats van uit de opgemaakte versie — daardoor kwamen
  ze eerder als onzin binnen, of helemaal niet.
- **Claim jezelf in MusicBrainz.** Bij Beheer → Audio kun je jezelf opzoeken en
  bevestigen dat jij dat bent. De koppeling gaat als `schema:sameAs` de draad op,
  zodat andere servers je Klonkt kunnen verbinden met de artiest die je elders al
  bent.
- **De hele site als muziekkanaal.** `/tracks.xml` publiceert alles wat je hebt
  uitgebracht als één feed, voor spelers die RSS spreken en geen ActivityPub.
- **Verhuis je account, en neem alles mee (FEP-1580).** Je berichten, je audio,
  de hoezen, de playlists en de GUID's gaan mee, je volglijst reist als CSV die
  je kunt uploaden of plakken, en de guardianship verhuist vóór de follow — in de
  andere volgorde stond een ward even zonder toezicht. Een verhuisd account gaat
  op slot aan de uitgaande kant, zodat er niets nieuws vertrekt vanaf een adres
  dat je niet meer gebruikt. Het staat nu op één pagina, in stappen, in plaats
  van verspreid.
- **Een leesweergave, naast Tijdlijn en Grid.** Eén bericht vult het scherm, de
  buren staan links en rechts klaar, en het scrollen snapt naar de bovenkant van
  het volgende bericht. Elke site kiest zelf: lezen, tijdlijn, of tijdlijn op
  desktop met lezen op een telefoon.
- **Gasten loggen in met het account dat ze al hebben (OpenWebAuth).** Een fan
  meldt zich aan via zijn eigen Klonkt en wordt hier volger, geen extra
  accounthouder met nog een wachtwoord. Twee Klonkts kunnen elkaar aanmelden, dus
  dit werkt in beide richtingen.
- **Acht guardianship-poorten die echt schakelen.** Het poortenpaneel is een
  cockpit: elke poort zichtbaar, elke chip draagt zijn eigen stand, en de apps
  weten vooraf wat er dichtstaat. Antwoorden is een eigen poort, volgverzoeken
  worden bij meerderheid beslist als er meerdere guardians zijn, een ward kan
  zelf een vraag stellen, en een logboek bewaart waaróm een besluit viel.
- **Volgers eerst goedkeuren, als je dat wilt.** Een volgverzoek wacht op jouw
  ja, en tot die tijd ziet de aanvrager niets van je berichten.
- **Elke collectie pagineert.** De outbox serveert nu `first` en `last` en
  bladert echt door zijn pagina's. Funkwhale weigerde hem zonder die twee
  ronduit, dus een collectie zonder paginering was geen schoonheidsfoutje maar
  een dichte deur.
- **Gesprekken weten wat je gelezen hebt.** Ongelezen telt per gesprek, een
  lezing is een gebeurtenis in plaats van een gok, en een wachtende lezing
  antwoordt met het verschil — niet langer een hele lijst ophalen om één nieuwe
  regel te vinden.
- **Apple Music- en YouTube-playlists sluiten netjes in**, met dezelfde parsing
  als de hub en een hoogte die past bij wat je werkelijk insluit.
- **Berichten is één gesprekkenweergave.** Berichten, Gesprekken en Verzonden
  waren drie losse filters, waardoor één uitwisseling uit elkaar viel: wat jij
  stuurde stond onder Verzonden, wat terugkwam onder een van de andere twee, en
  om een draad te volgen moest je heen en weer klikken. Het is nu één
  Gesprekken-weergave waarin verzonden en ontvangen in dezelfde draad staan,
  oudste bovenaan, met jouw eigen bijdragen gemarkeerd. Er blijven vier filters
  over: Alles, Gesprekken, Activiteit en Moderatie.
- **Een gesprek vertelt waar het over gaat.** Hangt een draad aan een van je
  posts, dan staat er een link naar die post in de kop. Zonder die context is
  een antwoord in een lijst niet te plaatsen. Draden die niet over een post gaan
  lopen per persoon.
- **Posts in Berichten zien eruit als posts.** Opmaak, afbeeldingen, geluid,
  video, quote-kaarten en linkvoorbeelden worden nu net zo getoond als in de
  Krant, ook bij de berichten die je zelf stuurde — een foto die jij meestuurde
  kwam op je eigen scherm als kale tekst binnen terwijl de ander wel een plaatje
  zag.
- **De Guardian-app toont posts van je ward compleet.** Hetzelfde gat zat in de
  guardian-weergave: een post van je ward kwam binnen zonder media, quote-kaart
  of emoji, terwijl dat juist de post is die je als guardian wilt kunnen
  beoordelen. Een content warning blijft daar zoals eerder dichtgeklapt.
- **Antwoorden vanuit een gesprek.** Onder een draad staat een eigen
  antwoordvenster, de rijke editor met opmaak, media en een taalkeuze. Zwaaien
  blijft een aparte knop ernaast: een zwaai is een seintje, geen antwoord.

### Opgelost
- **De draad onder een vreemde post wordt via je eigen server opgehaald en nooit
  bewaard.** Antwoorden, like- en booststatus en de FEP-9098-emoji komen nu mee,
  en de volgende pagina wordt ook gelezen — eerder stopte een lange draad
  halverwege.
- **De snelheidsbegrenzer telde de hele site in plaats van de beller**, waardoor
  een drukke site iedereen 429's gaf. Daarbij hoort: of je een proxy vertrouwt
  hangt af van waar je draait, niet van of je in ontwikkeling of productie zit.
- **Een levende klok in het antwoord maakte van de lange poll een lus.** Het
  antwoord veranderde elke seconde, dus hij wachtte nooit — hij kwam alleen maar
  terug.
- **De editor overleeft een paginawissel.** Modules die aan elementen hangen
  starten bij elke navigatie opnieuw, dus de bewerkpagina laadt zijn editor weer
  na een terugknop, en opslaan zonder module wist niet langer wat je had
  geschreven.
- **Een slug is een lokale sleutel, geen naam op de draad.** Halve namen,
  ontbrekende namen en drie spellingen van dezelfde naam kwamen er allemaal uit
  voort dat het een voor het ander werd aangezien.
- **De cirkel viel om op een mediaveld dat geen lijst was**, en nam dan de hele
  pagina mee in plaats van dat ene bericht.
- **Mensen op privacy-strenge servers kunnen je weer volgen.** Sommige servers
  geven de publieke sleutel van een account alleen aan een ondertekend verzoek.
  Klonkt vroeg zonder handtekening, werd geweigerd, en kon daardoor het
  volgverzoek dat net binnenkwam niet controleren — dus werd dat afgewezen, en
  bleef de andere server het dagenlang opnieuw proberen. Klonkt ondertekent die
  navraag nu, en die volgers komen erdoor. Dit raakte ook al het andere dat bij
  zo'n server werd opgehaald: profielen, posts en reacties.
- **Reacties van anderen komen nu in de draad aan.** Reageerde iemand op een
  post in een gesprek waar jij bij zat, dan stuurde hun server die reactie naar
  je door — en werd hij geweigerd, omdat een doorsturende server met zijn eigen
  sleutel ondertekent en niet met die van de schrijver. Threads waren daardoor
  aan jouw kant stilletjes onvolledig. Zo'n reactie wordt nu bij de bron
  gecontroleerd in plaats van afgewezen: de post wordt opgehaald bij de server
  die hem herbergt, en alleen wat daarvandaan komt wordt bewaard. Een
  doorgestuurde verwijdering wordt nog steeds geweigerd, want een verwijderde
  post valt niet te controleren.
- **Een like of boost ziet er overal hetzelfde uit.** Dezelfde post kon in de
  Krant als geliket verschijnen en op de interact-pagina als niet-geliket, omdat
  allebei een eigen administratie bijhielden. Er is er nu één, dus de knoppen
  zijn het eens — ook voor alles wat je vóór deze versie al had gereageerd; dat
  wordt bij het bijwerken van de site automatisch meegenomen.
- **Een like vanuit een app blijft nu staan.** Een like die je in Shaer gaf werd
  wel opgeslagen, maar de app kreeg dat nooit terug, dus het hartje sprong bij de
  eerste herlaadbeurt weer uit — en omdat de app de like nooit zag, kon hij hem
  alleen opnieuw geven en nooit intrekken. Un-liken vanuit een app werkt nu.

### Beveiliging
- **Betaalde posts lekten hun volledige inhoud via de outbox en de
  volger-backfill.** De redactie zelf werkte; de queries gaven hem een rij zónder
  de kolom `paid`, dus las de poort `undefined`, liet alles door en zei niets.
  Beide queries halen nu op waarop ze beslissen, en een test bewaakt de soort
  fout in plaats van dit ene geval.
- **Fan-only posts gingen de deur uit met een publiek etiket.** Ze waren juist
  geadresseerd maar verkeerd omschreven, en zo'n tegenspraak lost een andere
  server precies de verkeerde kant op.
- **Een lek tussen sites in de tracker-export.** De ene site kon via de exporter
  bij de rijen van een andere.
- **De playlist-poort opent nu alleen bestanden van de site zelf.**
- **Een sleutel is gebonden aan de actor waarvoor hij spreekt.** Een handtekening
  wordt alleen aanvaard als de sleutel, zijn eigenaar en de actor het eens zijn;
  eerder kon een sleutel instaan voor iemand waar hij geen relatie mee had.
- **OpenWebAuth pakt PKCS#1 v1.5 zelf uit**, zonder vroege uitgang en met een
  grens op het aantal pogingen. Node heeft de padding-modus die dit deed
  verwijderd omdat die via timing lekt (CVE-2023-46809, de Marvin-aanval); het
  met de hand doen houdt het pad even lang en sluit het orakel in plaats van het
  opnieuw te openen.

- **Bijgewerkte onderdelen sluiten zeven beveiligingsadviezen.** Het zwaarste
  zat in de bibliotheek die berichten van elders opschoont: een zorgvuldig
  opgebouwd bericht kon daar een script langs krijgen, en een script dat op jouw
  pagina draait kan doen alsof het jou is. Tegelijk ging de mailafhandeling drie
  hoofdversies vooruit, wat een reeks gaten rond verzenden dichtte — waaronder
  een waarbij een geprepareerde naam commando's het gesprek met de mailserver in
  kon smokkelen, en een waarbij een bericht bij een ander domein kon belanden
  dan het geadresseerde. Aan hoe Klonkt eruitziet of werkt verandert dit niets.
  Eén advies blijft bewust staan: het gaat over een manier om identifiers te
  maken die Klonkt niet gebruikt.

## [1.6.0] · 2026-07-31

### Toegevoegd
- **Guardians (FEP-633c).** Een account kan nu onder de hoede staan van een of
  meer guardians, zoals een kind ouders heeft. Een guardian biedt aan om over
  iemand te waken; de ward accepteert in zijn eigen Berichten, en eventuele
  bestaande guardians keuren mee goed, zodat niemand zich in z'n eentje aan een
  kind kan koppelen. Eenmaal akkoord verschijnt de guardian op het actor-doc van
  de ward (`shaer:guardians`) en is die bereikbaar als de ward om hulp vraagt.
  Het bouwt op gewone ActivityPub, dus guardian en ward mogen op verschillende
  servers zitten.
- **Een Guardian-app die je kunt installeren.** Een aparte, installeerbare hoek
  op `/guardian` voor guardians: wards toevoegen en beheren, een berichtencentrum
  voor binnenkomende hulpverzoeken, en eigen meldingen voor hulpverzoeken en
  voogdij-verkeer, ook als de app dicht is.
- **Voogdij-aanvragen komen binnen in je Berichten.** Als iemand aanbiedt je
  guardian te worden, verschijnt dat in je eigen Berichten als een duidelijk item
  met Accepteren en Weigeren, zodat je antwoordt waar je toch al je berichten
  leest, niet ergens apart.
- **De eigenaar kan zijn inbox lezen via C2S.** Een GET op de inbox met de
  eigen bearer geeft recente binnengekomen posts (de accounts die je volgt) als
  Create(Note)-items, zodat een gekoppelde app (Shaer) een unified feed kan
  bouwen. Voor alle anderen blijft de inbox write-only.
- **"Meer laden" op de feeds.** Solo (home), Cirkel, Krant en Berichten laden nu
  in blokken van 72 met een "Meer laden"-knop in plaats van een harde limiet, dus
  oudere items zijn weer bereikbaar. 72 is deelbaar door 2, 3 en 4, zodat de
  grid-weergaven altijd op een volle rij eindigen. Toevoegen gaat direct (htmx),
  het zoeken en filteren in Berichten blijft over alle pagina's werken, en de knop
  verdwijnt op de laatste pagina.
- **"Interacteer via de fediverse" naast Delen.** Op een post krijgen bezoekers
  naast Delen een knop om vanuit hun eigen fediverse-server te reageren, te liken
  of te boosten (vraagt je server, en geeft het door aan jouw instance). Verborgen
  voor de site-eigenaar en als federatie uit staat.
- **FEDERATION.md (FEP-67ff).** De repo-root documenteert nu wat Klonkt op de
  lijn spreekt: ActivityPub S2S en C2S, WebFinger, HTTP Signatures, NodeInfo 2.1,
  OAuth (PKCE), de activities en objecttypes die het stuurt en ontvangt, de
  Mastodon-compatibele extensietermen, en de FEPs die het ondersteunt of volgt.
  Helpt andere implementaties om te interopereren.
- **Berichten: je peiling is afgelopen.** Als een van je eigen peilingen sluit,
  verschijnt in Berichten een "peiling afgelopen"-item met de uitslag: een balk
  per optie met percentage, plus het aantal stemmers. Het valt onder de chip
  Activiteit en is doorzoekbaar zoals de rest.
- **Berichten: scherpere filters en een zoekveld.** De filterchips zijn nu
  Berichten (@mentions en privé/DM-reacties), Gesprekken (publieke reacties),
  Activiteit (likes, boosts, follows), Moderatie (rapporten) en Verzonden, naast
  Alles. Een zoekveld filtert de lijst op afzender en berichttekst, en werkt
  samen met de actieve chip. Volledig client-side, direct.
- **De reactie-editor is visueel opgeschoond.** De werkbalk gebruikt nu dezelfde
  iconen en 32px-knoppen als de post-editor, met actieve opmaak gevuld in de
  accentkleur, een gekaderde editor-box met focus-ring, en nettere taal-,
  mention- en bijlage-chips. Eén editor-familie op de hele site.
- **De reactie-editor toont wie je adresseert (rijke reacties, fase 3).** Een
  "Aan:"-balk boven de editor toont de gesprekspartners (de auteur waarop je
  reageert plus de eerdere auteurs in de thread) als verwijderbare chips, in
  plaats van @mentions die je tekst vervuilen. Verwijder een chip en die persoon
  wordt niet meer genoemd, getagd of gepingd; mentions die je zelf typt blijven
  gewoon in de tekst staan. Een verzonden reactie bewerken houdt elke co-mention
  intact.
- **Een verzonden reactie bewerken gebruikt nu ook de rijke editor.** De
  bewerk-formulieren op Berichten en de interactiepagina openen dezelfde editor
  als nieuwe reacties (opmaak blijft, taal aanpasbaar, volledig scherm op
  telefoons). Bijlagen op de reactie overleven een bewerking onaangeroerd.
- **Media in reacties (rijke reacties, fase 2).** Sleep, plak of kies
  afbeeldingen, audio en video direct in de reactie-editor (de paperclip werkt
  op telefoons). Bestanden uploaden naar je eigen site, verschijnen als
  verwijderbare chips tijdens het schrijven, reizen als echte attachments mee op
  de gefedereerde note, en renderen in je thread. Een reactie met alleen media
  (zonder tekst) kan ook.
- **Rijke reacties (fase 1).** Reageren op fediverse-reacties (inline in de
  thread en op de interactiepagina) gebruikt nu een gedeelde rijke editor: vet,
  cursief, links, opsommingen en citaten, plus een taalkeuze voor je reactie
  (meegestuurd als language map op de note). Op telefoons opent de editor als
  volledig scherm, het patroon dat op mobiel echt werkt. Zonder JavaScript
  blijft het gewone tekstvak werken. Media in reacties is de volgende fase.
- **Trek verbonden apps in vanaf je accountpagina.** Een sectie "Verbonden apps"
  toont elke app die je via OAuth toegang gaf (naam, site, scope, laatst
  gebruikt) met een Intrekken-knop. Al eerder uitgegeven tokens verschijnen ook,
  want die stonden altijd al (gehasht) opgeslagen; het token zelf bewaren we
  nooit, dus intrekken gaat op de token-hash.
- **De account-eigenaar kan zijn eigen followers en following lezen via C2S.** De
  `followers`- en `following`-collecties blijven count-only voor het publiek
  (privacy), maar een verzoek met een C2S-bearer die op die site scoped is geeft
  nu de echte actor-URI's terug, zodat een app (Shaer) een vriendenlijst kan
  bouwen. Voor anonieme bezoekers verandert er niets.
- **App-toegang via OAuth 2.0 (ActivityPub Client-to-Server, fase 1).** Klonkt
  spreekt nu de standaard AP C2S-authenticatie, zodat native en web-apps (de
  Shaer-apps als eerste) kunnen verbinden: dynamische client-registratie
  (RFC 7591), een PKCE authorization-code-flow met een toestemmingsscherm waarop
  je kiest namens welke site de app mag posten, en bearer-tokens (gehasht
  opgeslagen, eenmalige codes). De actor-doc adverteert de OAuth- en
  uploadMedia-endpoints en `/.well-known/oauth-authorization-server` (RFC 8414)
  geeft de metadata, dus apps ontdekken alles in plaats van paden vast te
  spijkeren. Alleen publieke clients + PKCE, geen client-secrets.
- **De outbox accepteert posts van apps (C2S, fase 1 compleet).** Een
  `POST` met bearer-token naar `/ap/users/:slug/outbox` bestuurt nu je account
  vanuit een app: een bericht plaatsen, reageren, liken, boosten, volgen en dat
  allemaal ongedaan maken. Activities gaan via dezelfde bezorg-machinerie als de
  web-UI; een kale Note wordt in een Create verpakt (spec); content wordt
  gesanitized; het token is aan één site gebonden dus kan niet namens een andere
  posten. Let op: dit is ActivityPub C2S, wat de Shaer-apps spreken.
  Mastodon-clients (Ivory e.d.) gebruiken Mastodons eigen API en worden hier niet
  ondersteund.

### Opgelost
- **OAuth-toestemming geeft nu betrouwbaar over aan native apps.** Na Allow/Deny
  was de redirect naar een native custom-scheme (bijv. `com.klonkt.shaer:/oauth`)
  een gewone 302, en die negeren mobiele browsers stilzwijgend. De toestemmings-
  stap serveert nu een klein tussenscherm voor niet-http redirect-URI's dat
  automatisch doorstuurt én een "Open de app"-tikknop biedt (een tik opent de app
  betrouwbaar op Android; iOS' web-auth-sessie vangt 'm sowieso op). Web-clients
  (http/https) krijgen nog steeds een 302.
- **Bezoekers kunnen reageren op de eigen reacties van de site-eigenaar.** De
  knop "reageer via de fediverse" verscheen alleen bij reacties van anderen; bij
  de eigen reacties van de site in een thread kregen bezoekers niets, waardoor
  je de auteur niet vanaf je eigen instance kon beantwoorden.

## [1.5.0] · 2026-07-18

### Toegevoegd
- **Berichten: je reacties en meldingen op één pagina.** Eén Berichten-tab
  vervangt Reacties en Meldingen. Eén stroom met filterchips (Alles, Gesprekken,
  Activiteit, Verzonden): je eigen verzonden reacties staan mee in het gesprek
  (met bewerken en verwijderen), likes en boosts op dezelfde post groeperen tot
  één regel, privéreacties dragen een slotje, en items nieuw sinds je laatste
  bezoek krijgen een stip. De interactie-bookmarklet verhuisde mee. Oude
  /fediverse- en /notifications-links leiden door naar /messages.
- **Connect: wie je volgt en wie jou volgt op één pagina.** Eén Connect-tab
  vervangt de aparte Volgend- en Volgers-pagina's, met per connectie de richting
  (volgend →, volger ←, wederzijds ↔) en, voor accounts waaraan je bezorgt,
  wanneer ze voor het laatst bereikt zijn. Accounts die je niet meer bereikt
  schuiven naar een ingeklapte "Niet bereikbaar"-sectie om op te ruimen. Oude
  /following- en /followers-links leiden door naar /connect.
- **Modereer inkomende reacties op je eigen posts.** Als site-eigenaar kun je een
  reactie nu uit je thread verwijderen (en die blijft weg: opnieuw bezorgen en
  thread-aanvulling worden geblokkeerd door een tombstone) en rapporteren bij de
  server van de auteur, rechtstreeks vanuit de thread. Werkt ook voor
  privéreacties, die niet via de fediverse-interactieflow te behandelen zijn.

### Opgelost
- **Een geboostte videopost houdt zijn video in de Cirkel.** Een video-only post
  (Loops.video) boosten sloeg hem op zonder media, waardoor de Cirkel een kale
  teksttegel toonde in plaats van een videothumbnail; opnieuw boosten kon de
  video zelfs wissen uit een al-gecachte kopie. Boosts dragen nu de volledige
  getypeerde media mee, en een refresh wist gecachte media nooit meer.
- **De titel van de interactiepagina volgt je taal.** "Interacteer via de
  fediverse" stond hardcoded in het Nederlands in het browsertabblad, ook op een
  Engelstalige site.
- **Het Apple Music-icoon lijkt weer op het Apple-logo.** Het oude icoon was een
  verminkte vorm.
- **Statistiekkolommen verspringen niet meer in de 30- en 90-dagenweergave.**
  Kolommen zonder datumlabel klapten iets in; elke kolom houdt nu zijn
  labelregel.
- **Privéreacties staan niet meer op de publieke postpagina.** Een followers-only
  of directe (DM-)reactie op je post werd voor iedereen in de publieke thread
  getoond. Inkomende reacties slaan nu hun fediverse-adressering op; de publieke
  thread toont alleen publieke en unlisted reacties. Privéreacties bereiken je
  nog steeds via meldingen, mét de post waar ze bij horen.
- **Kale video/audio-embeds lopen niet meer buiten de kolom.** Een `.webm` /
  `.mp4` / `.mp3`-speler past nu netjes in de kolombreedte, net als de
  iframe-embeds; de breedte-regel gold voorheen alleen voor `iframe`.

## [1.4.0] · 2026-07-14

### Toegevoegd
- **Volgerslijst met bezorgstatus.** Een nieuw Fediverse-tabblad laat zien wie je
  volgt en wanneer elk account voor het laatst bereikt is, zodat dode accounts
  opvallen en je ze na een check kunt verwijderen.
- **Kale media-links spelen direct af.** Een losse `.webm`, `.mp4` of `.mp3` wordt
  nu een echte speler in plaats van een dode link.
- **Hashtags, links en mentions zijn ook op je site klikbaar.** `#tags`, URLs en
  `@mentions` in een post worden nu links op de site zelf, niet alleen op de
  gefedereerde kopie. Mentions worden één keer bij opslaan opgezocht, dus pagina's
  blijven snel.

### Opgelost
- **Reacties, verwijderde reacties en bewerkte reacties komen altijd aan.** Ze
  verdwenen als een server even onbereikbaar was; ze gaan nu via de retry-wachtrij,
  net als posts.
- **Videothumbnails voor meer video's.** Covers van video's met hun metadata
  achteraan (Loops.video, telefoon-exports) krijgen nu een thumbnail in plaats van
  niks.
- **Een cover die alleen een video is, toont nu een posterbeeld op de postpagina.**
  Hij blijft niet meer leeg in de Solo-weergave.
- **De geïnstalleerde app toont geen oude data meer bij een wankele start.** Een
  koude start op een slechte verbinding ververst nu, in plaats van een verouderde
  pagina te tonen.
- **De Updates-pagina volgt jouw branch.** Draai je de stable-branch, dan zie je
  niet langer de wijzigingen van main als "nieuwste".

## [1.3.5] — 2026-07-04

### Opgelost
- **Polls behouden hun cover als ze geboost worden.** Een poll met muziek of een
  embed federeerde zonder cover, waardoor een geboooste poll een leeg vak toonde;
  de cover reist nu mee.
- **De Updates-pagina van de Android-app toont wat er écht te installeren valt.**
  Hij las de nieuwste release-branch, die korte tijd vóór kon lopen op de
  telefoon-build — bijwerken installeerde dan dezelfde versie opnieuw. Hij leest
  nu de versie van de telefoonbundel zelf.

## [1.3.4] — 2026-07-04

### Opgelost
- **Boosts die hun cover kwijt waren krijgen 'm automatisch terug.** Posts die
  je vóór de cover-fix boostte waren zonder artwork opgeslagen; die worden bij
  de volgende herstart eenmalig ververst. Is de thuis-server van een post op dat
  moment even onbereikbaar, dan wordt het bij volgende herstarts opnieuw
  geprobeerd in plaats van voorgoed overgeslagen. Een post opnieuw boosten
  ververst nu ook de opgeslagen kopie (cover, inhoud) — vanuit de feed én de
  interact-pagina.

## [1.3.3] — 2026-07-03

### Opgelost
- **Geboooste muziekposts houden hun cover.** Als je een nummer boostte van
  iemand die je niet volgt, ontbrak de cover; die verschijnt nu wel, net als bij
  mensen die je wél volgt.

## [1.3.2] — 2026-07-02

### Opgelost
- **De Updates-pagina werkt nu in de Android-app.** Hij toont voortaan de
  nieuwste beschikbare versie, en de bijwerk-knop downloadt en installeert die
  direct op je telefoon (je posts en instellingen blijven staan).

## [1.3.1] — 2026-07-02

### Opgelost
- **Muziek blijft op Android doorspelen in de achtergrond.** Als een nummer
  afliep terwijl je telefoon op slot zat of de app in de achtergrond stond,
  startte het volgende nummer en stopte het na een seconde weer. De speler
  voert de wachtrij nu als één doorlopende stream aan, waardoor het doorgaan
  naar het volgende nummer niet meer telt als "nieuw" afspelen dat de browser
  mag pauzeren.

## [1.3.0] — 2026-07-02

### Toegevoegd
- **Kies een lichte of donkere deel-kaart.** De automatisch gemaakte deel-afbeelding volgt je
  site-thema; onder Beheer → SEO kun je 'm nu geforceerd licht of donker zetten.
- **Een vermelding is nu een melding.** Als iemand op de fediverse je noemt in een post — ook
  eentje die geen reactie op jou is — verschijnt dat in je fediverse-meldingen met een link naar
  het origineel.
- **Cover-art op openbaar gedeelde audio.** Een track die je openbaar op de fediverse deelt draagt
  nu z'n cover-art mee (of de post-cover), zodat audiospelers die artwork ondersteunen die tonen in
  plaats van een leeg vlak.
- **Rapporteer een post op de fediverse.** Vanaf een fediverse-post kun je die nu melden bij de
  moderators van de eigen server van die post, met een optionele reden — en meldt iemand jouw site,
  dan verschijnt die melding in je fediverse-meldingen.
- **Stel de taal van een post in.** Kies in welke taal je een post schreef — op de fediverse
  werkt daarmee het taalfilter van de tijdlijn en de vertaal-knop.
- **Alt-tekst voor afbeeldingen.** Geef je cover een beschrijving (en inline-afbeeldingen behouden
  hun eigen alt-tekst) — die federeert mee naar de fediverse en laat schermlezers de afbeelding beschrijven.
- **Noem mensen in een post.** `@gebruiker@server` in een post linkt nu naar hun profiel en stuurt
  ze een melding op de fediverse — ook als ze je niet volgen — net als een vermelding in een reactie.
- **Korte video's in de feed spelen automatisch af en loopen.** Een geanimeerde cover of een korte
  (≤30s) clip in de News-feed speelt nu automatisch geluidloos in een lus, als een GIF; langere
  video's houden hun bediening.
- **Stem op fediverse-polls.** Een poll van een account dat je volgt verschijnt nu in de News-feed
  met opties en de huidige resultaten, en je kunt je stem uitbrengen — die federeert terug zoals een
  gewone Mastodon-stem.
- **Maak je eigen polls.** Een post kan nu een poll bevatten (enkel- of meerkeuze, met een looptijd).
  Die federeert als een echte fediverse-poll, dus je Mastodon-volgers kunnen stemmen vanuit hun eigen
  app; de live-resultaten staan op de post en de poll sluit zichzelf zodra de tijd om is.

### Gewijzigd
- **Audio openbaar delen is nu onomkeerbaar.** Zodra een track openbaar op de fediverse is gedeeld,
  is het bestand verspreid — weer "sluiten" zou schijnveiligheid zijn. De editor vergrendelt de keuze
  na het openen en waarschuwt je voordat je 'm aanvinkt.

### Opgelost
- **Remote video's tonen een preview-frame.** Een video in de News-feed of op een Cirkel-tegel
  (bv. van Loops of PeerTube) verscheen als zwart vlak tot je op afspelen drukte; er staat nu een
  echt poster-frame. (Langere video's houden bewust hun bediening — alleen clips onder de 30
  seconden spelen automatisch als een GIF.)
- **Vermeldingen, hashtags en links tussen haakjes werken nu.** Een vermelding als
  `(@gebruiker@server)`, een `(#hashtag)` of een URL tussen haakjes federeerde als platte tekst —
  en de genoemde persoon kreeg nooit een melding. Ze linken (en melden) nu net als zonder haakjes.
- **Kale webadressen worden links op de fediverse.** Een losse URL in een post of reactie federeert
  nu als klikbare link in plaats van platte tekst.

## [1.2.0] — 2026-07-01

### Toegevoegd
- **PeerTube-video's in de feed.** Een PeerTube-link in een post toont nu een ingesloten speler in de
  News-feed, net zoals YouTube, Spotify en SoundCloud al deden.
- **Lichte deel-afbeeldingen.** Sites met een licht standaardthema krijgen nu een bijpassende lichte
  Open Graph-kaart bij het delen van een pagina, in plaats van altijd een donkere.
- **Je eigen bezoeken buiten de statistieken laten.** Als beheerder kun je nu je eigen IP-adres
  uitsluiten van je sitestatistieken, voor een eerlijker beeld van echte bezoekers.
- **Rechtsklik "Opslaan" is uitgeschakeld op covers, afbeeldingen en video's** — een lichte drempel
  zodat de artwork niet met één klik op te slaan is (frictie, geen bescherming).

### Opgelost
- **Geanimeerde video-covers tonen nu overal correct.** In de Cirkel en het raster konden ze
  verschijnen als een kapotte afbeelding of een leeg vak; ze tonen nu als een echte doorlopende video
  die het vierkant vult, gecentreerd. Rechtsklikken op een cover geeft het normale link-menu in plaats
  van de video-bediening van de browser.
- **Iemand volgen blijft niet meer hangen.** Een volg-verzoek waarvan de eerste bezorging faalt (de
  andere server even onbereikbaar) wordt nu automatisch opnieuw geprobeerd, in plaats van eeuwig op
  "in behandeling" te blijven staan.
- **Geboooste posts tonen hun echte tekst** in de Cirkel, in plaats van een "RE: <link>"-prefix.
- **Steviger fediverse-afhandeling** — strengere handtekening-controles op inkomende activiteit,
  blokkades dekken nu ook een boost van een geblokkeerde auteur, en het synchroniseren van gepinde
  posts racet niet meer als je snel achter elkaar opslaat.

## [1.1.0] — 2026-06-30

### Toegevoegd
- **Geanimeerde covers spelen overal soepel.** Upload een geanimeerde WebP als cover en Klonkt maakt
  er ook een geluidloze, doorlopende video van. iOS Safari — waar geanimeerde WebP hapert — krijgt de
  soepele video, elke andere browser houdt de scherpe WebP, en op de fediverse federeert de cover als
  een video die in Mastodon en z'n apps speelt. Te zien op de post, het grid, de feed en gerelateerde posts.
- **Mediabibliotheek (Beheer → Media).** Zie elke geüploade afbeelding, waar elke wordt gebruikt,
  kopieer de URL, en ruim ongebruikte bestanden in één klik op — inclusief de overgebleven video/poster
  van een geanimeerde cover. Afbeeldingen, Audio en Playlists delen nu één tab-balk.
- **Deel-knop** onderaan elke post (native deelmenu, of link kopiëren).
- **Vervang het audiobestand van een track** zonder de track opnieuw aan te maken.
- **Muziek op de fediverse (eerste stap).** Audio-posts dragen nu schema.org *MusicRecording* /
  *MusicAlbum*-data, en een per-post-schakelaar kan een gehoste track delen als een echte
  fediverse-audiobijlage die in de feeds van volgers speelt.

### Gewijzigd
- **Nettere embeds op Mastodon.** Een post met een YouTube/Spotify/SoundCloud-link laat Mastodon nu
  z'n player-kaart tonen; link-only tracks delen hun streaming-links. De cover blijft zichtbaar in
  andere Klonkt-feeds. (Op je eigen site verandert niets — de speler en cover renderen zoals voorheen.)
- **Cirkels blijven gesynct op de fediverse-manier** — bewerkingen en gemiste posts lopen automatisch
  bij via standaard ActivityPub, zodat een Cirkel niet meer uit sync raakt.
- **Alles wat Klonkt federeert is nu valide AS2 / JSON-LD**, bewaakt door een test, zodat striktere
  servers het accepteren.
- De tracklijst staat **nieuwste eerst**.

### Opgelost
- **Geanimeerde WebP-covers worden niet meer tot één frame bevroren** (de crop-editor en de
  thumbnailer maakten ze statisch).
- **Link-only tracks** (Spotify/YouTube, geen geüpload bestand) zijn weer in een post in te voegen.
- **Link-previews** (og:image / Twitter-kaart) gebruiken nu absolute afbeeldings-URL's, zodat ze op
  Signal, WhatsApp en andere scrapers verschijnen.
- Diverse **fediverse-bezorgings-fixes**: covers/links worden geen zwarte tegel meer op Mastodon, rauwe
  audiobestanden vervuilen geen post die al een speler heeft, en dode links van een hernoemde remote
  post helen zichzelf.
- De **mobiele feed** laadt covers op volledige resolutie; lange titels breken af i.p.v. over te lopen.
- **Self-host-updates** zijn betrouwbaarder: de installer opnieuw draaien behoudt je kanaal, en de
  updater herstart niet meer (of claimt geen update) als je al up-to-date bent.

## [1.0.0] — 2026-06-30

### Toegevoegd
- **Klonkt zit nu op de fediverse (ActivityPub).** Je site is een echt
  fediverse-account: mensen op **Mastodon** — of een andere **Klonkt** — kunnen je
  volgen, en je berichten komen in hun feed. Je kunt zelf accounts volgen en hun
  berichten lezen in een **News**-feed, **notificaties** krijgen, en berichten **liken,
  boosten en erop reageren**. Inkomende activiteit wordt geverifieerd, dus nep-reacties,
  -likes en -volgers worden geweigerd.
- **Iedereen kan vanaf de fediverse op je berichten reageren, ze liken of boosten** —
  bezoekers reageren vanuit hun eigen account (ze vullen alleen hun server in); een
  account op jouw site is niet nodig.
- **Circles**: volg andere Klonkt-sites en toon elkaars openbare berichten in je
  Circle — decentraal, zonder centraal platform.
- **Gevoelige (NSFW) berichten** met je eigen waarschuwingstekst: vervaagd met
  klik-om-te-tonen op de hele site, en getoond als inhoudswaarschuwing op de fediverse.
- **Blokkeer** een account of een heel domein waar je liever niets van hoort.
- Zoeken vindt nu ook **tracks** (op titel, artiest en album), direct af te spelen vanuit
  de resultaten met een link naar het bericht waarin ze voorkomen — en bij berichten zoek
  je al terwijl je typt.
- **Live thema-voorbeeld** in Beheer → site-instellingen: accent, thema en palet worden
  direct bijgewerkt, nog vóór je opslaat.
- Geüploade afbeeldingen worden automatisch geoptimaliseerd naar **WebP** voor snellere
  pagina's.
- Een ruimere **schrijfervaring op mobiel**: tik om een afleidingsvrije, schermvullende
  editor te openen, met de opmaakbalk die boven het toetsenbord in beeld blijft.

### Gewijzigd
- **Paletten teruggebracht naar 8**: het neutrale **Klonkt** (goud accent) is de nieuwe
  standaard, plus zeven volkleurige thema's — **Forest**, **Ocean**, **Teal**, **Lilac**,
  **Sunset**, **Candy** en **Amber**.

### Verwijderd
- **Hub-modus** — Klonkt is nu **solo of Circles**; je bouwt een collectief of label
  via **Circles** (gefedereerde, zelfstandige sites).
- **Eigen reacties en Google-login** — reageren, liken en boosten loopt nu volledig
  via de fediverse.
- **Lokale favorieten (♥)** — vervangen door de ⭐ fediverse-like.

### Opgelost
- De mini-speler springt en scrollt naar de track die speelt — ook vanuit een album of
  afspeellijst — en houdt die gemarkeerd.
- Lege album-/afspeellijst-covers vallen nu terug op de cover van de eerste track.
- Een profielfoto die na de overstap naar **WebP** kapotging in de koptekst, herstelt
  zichzelf nu.
- Veel verbeteringen aan de **mobiele berichten-editor**: betrouwbaar scrollen, een
  opmaakbalk die op z'n plek blijft, geen pagina-sprongen als je op een knop tikt, en een
  Opslaan-balk die net boven het toetsenbord zit.

## [1.0.0-beta.2] — 2026-06-19

Eerste release waarbij we de versie actief bijhouden (te zien in de footer — klik erop voor
deze pagina).

### Toegevoegd
- Releasetracking: het versienummer in de footer linkt naar deze wijzigingenpagina.
- Acht premiumfuncties (achter **Patreon**): nieuwsbrief/mailinglijst, download-voor-e-mail,
  release-planning + previews alleen voor fans, **EPK**/perskit, pro-statistieken,
  link-in-bio + klikstatistieken, insluitbare speler, en showagenda + houd-me-op-de-hoogte.
- Nieuwsbrief-aanmeldveld in de footer (aan/uit in Beheer → Instellingen).
- **SMTP**-instellingen in te stellen in Beheer → Instellingen (geen aanpassing van een
  configuratiebestand meer nodig), met een testmail-knop.

### Gewijzigd
- Nettere instellingenformulieren (gestapelde labels, volledig brede invoervelden).
- **EPK**/perskit toont de top 10 meest beluisterde tracks.
- Mooiere 404-pagina (mobielvriendelijk) en duidelijkere inlogfoutmeldingen.

### Opgelost
- De sitebrede audiospeler laadde geen enkele track.
- Knoptekst werd onleesbaar bij hover.
- Datumkiezers volgen nu het thema.
- Vooruit/terug-navigatie toont geen dubbele koptekst meer.
