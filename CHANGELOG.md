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

_Nog niets in voorbereiding._

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
