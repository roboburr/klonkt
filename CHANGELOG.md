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

### Opgelost
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
