# Wijzigingen — Klonkt

Alle noemenswaardige wijzigingen aan Klonkt. Nieuwste bovenaan.
Versies volgen [SemVer](https://semver.org/lang/nl/) (`1.0.0-beta.N` tijdens de beta).

## [Unreleased]

### Toegevoegd
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
