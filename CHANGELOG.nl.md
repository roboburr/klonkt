# Wijzigingen — Klonkt

Alle noemenswaardige wijzigingen aan Klonkt. Nieuwste bovenaan.
Versies volgen [SemVer](https://semver.org/lang/nl/) (`1.0.0-beta.N` tijdens de beta).

> **Twee losse versienummers — niet verwarren:**
> - **App-versie** (deze changelog + footer, `package.json`) = cosmetisch; bump elke release.
> - **Federatie-proto** (`KLONKT_PROTO` in `CircleFederation.js`, nu **2**) = bepaalt of
>   Klonkt-sites in elkaars **cirkel** kunnen federeren (zit in de getekende grondslag).
>   Een app-versie-bump verandert de proto **niet** en breekt cirkels dus niet. Bump de
>   proto **alleen** bij federatie-/security-wijzigingen, en rol die dan in **lockstep**
>   uit naar álle instances (incl. de democirkels) zodat ze blijven samenwerken.

## [Unreleased]

### Toegevoegd
- Zoeken doorzoekt nu ook **nummers** (op titel, artiest én album), niet alleen posts.
  Gevonden nummers zijn direct afspeelbaar in de resultatenlijst, met een
  "in post →"-link naar de post/album/playlist waarin het nummer voorkomt.
- Posts-zoek gebruikt nu **prefix-matching**: typ "astr" en je vindt "astra"
  (elk woord als prefix, AND tussen de woorden) — fijner zoeken-terwijl-je-typt.
- **Fediverse-client**: volg accounts (WebFinger → ondertekende Follow), een
  **home-tijdlijn** (`/tijdlijn`) van wie je volgt, een **meldingen-inbox**
  (`/meldingen`), en ⭐-like / 🔁-boost / ↩-reageren vanuit de tijdlijn.
- **Liken én reageren via de fediverse** op een post: bezoekers vullen alleen
  hun eigen server in (`@jij@server` of `server.com`) en handelen het af op hun
  eigen account (`/authorize_interaction`).
- **HTTP-handtekeningen afgedwongen** op de inbox: ongetekende of vervalste
  activiteiten worden geweigerd — geen nep-reacties/likes/volgers meer.
- **Blokkeren/defedereren** van een account of een heel domein (`/blokkeren`).
- **Live thema-preview** in Beheer → site-instellingen: accent, thema en palet
  meteen zichtbaar vóór je opslaat.

### Gewijzigd
- **Paletten herzien** naar 8: de neutrale **Klonkt** (wit/zwart, gouden accent)
  is nu de standaard, plus 7 echte-kleur thema's (Forest, Ocean, Teal, Lilac,
  Sunset, Candy, Amber). Accent-keuze opgeschoond; de Klonkt-achtergrond volgt
  nu de gekozen accentkleur.

### Verwijderd
- **Hub-modus** verwijderd — Klonkt is voortaan **solo of cirkels**. Een
  collectief/label maak je nu via **Cirkels** (gefedereerde losse sites).
- **Native reacties + Google-login** verwijderd — interactie loopt nu volledig
  via de **fediverse**.
- **Lokale favorieten (♥)** verwijderd — vervangen door de ⭐ fediverse-like.

### Opgelost
- Mini-speler: spring + scroll naar de spelende track werkt nu ook vanuit een
  **album of playlist** (de track-id zat niet in de afspeel-queue).
- De track die nu speelt krijgt een **blijvende highlight** in de post.
- Lege **album/playlist-covers** hersteld (een gemiste verwijzing in de
  WebP-conversie) + ze vallen nu terug op de cover van de eerste track.
- Kapotte **avatar/profielfoto** in de kop na de WebP-conversie: de viewer-avatar
  (en rol) wordt nu vers uit de database gelezen, dus een oude sessie herstelt
  zichzelf zonder opnieuw inloggen.

### Opgelost (eerder)
- Inline content-layout op touch versimpeld: geen opmaak-toolbar/rand meer inline
  (je bewerkt toch fullscreen) — alleen de content-preview + de tik-om-te-bewerken-pill.
- Kon niet scrollen op de bewerk-pagina: de fullscreen scroll-lock (overflow:hidden
  op html/body) bleef hangen. Lock verwijderd — het fullscreen-frame dekt de pagina
  al af en op touch zijn de scrollbalken verborgen.
- Fullscreen verlaten scrolt nu naar de top van de content (i.p.v. door te springen
  naar de footer).
- "Tik om te bewerken"-aanwijzing op touch is nu een pill die sticky onderaan de
  container plakt (boven de Opslaan-balk) i.p.v. lelijk gecentreerd in de tekst.
- Scrollbalken verborgen op mobiel & tablet (touch) — scrollen blijft werken,
  alleen de balk-UI is weg (geen verwarrende/dubbele balken).
- Fullscreen-editor: geen dubbele scrollbalk meer — in fullscreen scrollt alléén
  het tekstveld; het frame en de pagina (html+body) erachter zijn vergrendeld.
- Editor: het beeld verspringt niet meer bij het aanklikken van een opmaakknop.
  Op mobiel is het schrijfveld nu een begrensde scroll-box met de opmaak-toolbar
  STICKY bovenin: de tekst scrollt eronder, de toolbar blijft altijd in beeld, en
  de caret-scroll die mobiel Chrome forceert blijft binnen de box i.p.v. de hele
  pagina te laten verspringen. (Plus: scrollpositie wordt vastgehouden rond elk
  opmaak-commando.) `interactive-widget=resizes-content` weer verwijderd — dat liet
  de pagina omhoog scrollen voor het toetsenbord en brak de kb-open-detectie; de
  actiebalk + fullscreen regelen het toetsenbord via de visual viewport.
- Post-editor op mobiel: de Opslaan/Annuleren-balk blijft nu net bóven het
  toetsenbord (sticky met dynamische bottom-offset = max van toetsenbord- en
  audiospeler-hoogte), i.p.v. erachter te vallen of midden in beeld te zweven.
  Viewport schaalt mee met het toetsenbord (`interactive-widget=resizes-content`).
- Mobiel toetsenbord vs. layout (site-breed): zodra het toetsenbord opent tijdens
  het typen, verbergen de vaste onderbalken (bottom-tab + mini-speler) zich, zodat
  ze niet meer over het invoerveld zweven of het overlappen. Ze komen terug zodra
  het toetsenbord sluit. (Detectie via visualViewport → `body.kb-open`.)
- Post bewerken op mobiel opende niet meer meteen het toetsenbord: de titel kreeg
  niet langer automatisch focus (`autofocus` weg). Op desktop focust de titel nog wel.
- Posts schrijven op mobiel: een opmaakknop (vet/cursief/…) stal de focus uit het
  tekstveld → de selectie ging verloren (vet kon niet meer uitgezet worden) en de
  pagina sprong naar beneden. De toolbar houdt de focus nu in de editor
  (mousedown-preventDefault + focus zonder scroll), dus toggelen werkt en er is geen
  sprong meer. Toolbar-taps zijn ook sneller (touch-action: manipulation). Actieve
  opmaak is nu duidelijk gevuld met de accentkleur (en :hover plakt niet meer op
  touch), zodat zichtbaar is of bv. vet aan of uit staat.

### Toegevoegd
- Afbeeldingen → **WebP**: nieuwe uploads (post-afbeeldingen/cover, avatar, site-foto,
  hub-hero, audio-cover) worden automatisch naar WebP omgezet (kleiner); bestaande
  afbeeldingen zijn in één keer omgezet en alle verwijzingen bijgewerkt.
- Afbeeldingen zijn **lastiger op te slaan** (rechtsklik-"opslaan" + slepen
  geblokkeerd) — frictie, geen waterdichte beveiliging.
- Mini-speler (desktop): klik op de spelende track → **spring naar de post én scroll
  naar die track** (met highlight); werkt ook voor site-brede tracks via een lookup.
- Tekstvelden (`<textarea>`) groeien nu site-breed mee met de inhoud i.p.v. intern
  te scrollen (scroll-binnen-scroll was verwarrend). Het inline schrijfveld groeit
  ook gewoon mee; typen op mobiel/tablet gaat sowieso fullscreen.
- Op **mobiel & tablet** (touch) gedraagt de inhoud zich als een post: inline is het
  **niet typbaar** (tap-vlak met "✎ Tik om te bewerken"-pill). Eén tik opent een
  **fullscreen schrijf-"pagina"** — met echte back-knop-ondersteuning, dus de
  browser-back of de **"✓ Klaar"-knop** sluit 'm en je staat terug in het formulier
  (alle velden intact), waarna je alles samen opslaat met de gewone Opslaan-knop.
- Schrijfvenster kan op **volledig scherm** (knop in de editor-toolbar, of Escape om
  terug te gaan) — fijn voor afleidingsvrij schrijven op mobiel. De opmaak-toolbar
  blijft daarbij altijd bovenaan in beeld, ook als het mobiele toetsenbord opent
  (frame volgt de visual viewport).
- Beheerder kan z'n **Google-account koppelen** (Account → Inloggen met Google) en
  daarna óók met Google inloggen. Veilig: koppelen kan alleen terwijl je met
  wachtwoord bent ingelogd, en Google-login geeft alleen beheer als de exacte
  gekoppelde Google-account (`google_sub`) matcht. Ontkoppelen kan zolang er een
  wachtwoord is.
- Posts liken / favorieten: ingelogde gebruikers kunnen een post liken met een ♥-knop
  (toont het aantal likes). Je gelikete posts staan op de nieuwe **Favorieten**-pagina
  (`/favorieten`, link in het accountmenu). Niet-ingelogd → de knop leidt naar de login.

### Gewijzigd
- Post-navigatie (Newer/Older) toont nu een 📌 als de gelinkte post vastgepind is.
- De Newer/Older-postnavigatie staat nu óók op de fan-gate (login-wall van een
  fan-only post), zodat een bezoeker niet vastloopt maar verder kan bladeren.
  Nav verhuisd naar een gedeeld partial (`partials/post-nav.ejs`).
- Login gesplitst: de publieke loginpagina (`/auth/login`) toont voor bezoekers nu
  **alleen** Google-login (luisteraars/fans). De beheerders-login (gebruikersnaam +
  wachtwoord) staat verborgen op `/auth/admin` (nergens gelinkt).
- Post-navigatie (Newer/Older) houdt nu op elke post dezelfde twee-kaarten-structuur:
  ontbreekt er een nieuwere/oudere post, dan staat er een subtiele uitgegrijsde
  placeholder ("Nieuwste post" / "Oudste post") i.p.v. een lege plek.
- Bij het openen van een gerelateerde/volgende post spring je nu naar boven van de
  pagina (was: je bleef op de oude scrollpositie hangen).

## [1.0.0-beta.2] — 2026-06-19

Eerste release waarbij we de versie actief bijhouden (zichtbaar in de footer →
klik erop voor deze pagina). Federatie-proto: **2** (ongewijzigd).

### Toegevoegd
- Release-tracking: versienummer in de footer linkt naar deze wijzigingen-pagina.
- Acht premium-functies (Patreon-gegate): nieuwsbrief/mailinglijst, download-voor-email,
  release-planning + fan-only previews, EPK/perskit, pro-statistieken, link-in-bio +
  klikstats, inbedbare speler, en show-agenda + notify-me.
- Nieuwsbrief-aanmeldveld in de footer (aan/uit in Beheer → Instellingen).
- SMTP-instellingen instelbaar in Beheer → Instellingen (geen `.env`-edit meer nodig),
  met testmail-knop.

### Gewijzigd
- Beheer → Instellingen: Hub- en Cirkel-config staan nu direct onder de Modus-kaart;
  forms netter (gestapelde labels, full-width inputs).
- EPK/perskit toont de top 10 meest beluisterde nummers.
- Nettere 404-pagina (mobielvriendelijk) en duidelijkere login-foutmeldingen.

### Opgelost
- Site-brede audiospeler kreeg geen tracks (verkeerde kolom in de query).
- Knoptekst werd onleesbaar bij hover (zelfde kleur als de knop).
- Datumkiezers volgen nu het thema.
- htmx-navigatie werkt de adresbalk weer bij; geen dubbele kop bij terug/vooruit.
