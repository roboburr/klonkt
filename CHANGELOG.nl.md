# Wijzigingen — Klonkt

Alle noemenswaardige wijzigingen aan Klonkt. Nieuwste bovenaan.
Versies volgen [SemVer](https://semver.org/lang/nl/) (`1.0.0-beta.N` tijdens de beta).

## [Unreleased]

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
