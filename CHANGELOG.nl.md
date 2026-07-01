# Wijzigingen — Klonkt

Alle noemenswaardige wijzigingen aan Klonkt. Nieuwste bovenaan.
Versies volgen [SemVer](https://semver.org/lang/nl/) (`1.0.0-beta.N` tijdens de beta).

## [Unreleased]

### Toegevoegd
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
