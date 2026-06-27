# Änderungen — Klonkt

Alle nennenswerten Änderungen an Klonkt. Das Neueste oben.
Versionen folgen [SemVer](https://semver.org/lang/de/) (`1.0.0-beta.N` während der Beta).

## [Unreleased]

### Hinzugefügt
- **Klonkt ist jetzt im Fediverse (ActivityPub).** Deine Seite ist ein echtes
  Fediverse-Konto: Menschen auf **Mastodon** — oder auf einem anderen **Klonkt** — können
  dir folgen, und deine Beiträge landen in ihren Feeds. Du kannst Konten folgen und ihre
  Beiträge in einem **News**-Feed lesen, **Benachrichtigungen** erhalten und Beiträge
  **liken, teilen und beantworten**. Eingehende Aktivität wird überprüft, sodass gefälschte
  Antworten, Likes und Follower abgewiesen werden.
- **Jede:r kann deine Beiträge aus dem Fediverse beantworten, liken oder teilen** —
  Besucher:innen interagieren von ihrem eigenen Konto aus (sie geben einfach ihren Server
  ein); ein Konto auf deiner Seite ist nicht nötig.
- **Circles**: Folge anderen **Klonkt**-Seiten und zeigt euch gegenseitig die öffentlichen
  Beiträge in eurem **Circle** — dezentral, ohne zentrale Plattform.
- **Sensible (NSFW) Beiträge** mit eigenem Warnhinweis-Text: auf der ganzen Seite
  verschwommen mit Klick zum Anzeigen, und im Fediverse als Inhaltswarnung dargestellt.
- **Blockiere** ein Konto oder eine ganze Domain, von der du lieber nichts hören möchtest.
- Die Suche findet jetzt auch **Tracks** (nach Titel, Künstler:in und Album), direkt aus den
  Ergebnissen abspielbar mit einem Link zum Beitrag, in dem sie vorkommen — und die
  Beitragssuche zeigt Treffer schon beim Tippen.
- **Live-Theme-Vorschau** in Verwaltung → Seiteneinstellungen: Akzent, Theme und Palette
  aktualisieren sich sofort, noch bevor du speicherst.
- Hochgeladene Bilder werden automatisch zu **WebP** optimiert, für schnellere Seiten.
- Ein großzügigeres **mobiles Schreiberlebnis**: Tippe, um einen ablenkungsfreien
  Vollbild-Editor zu öffnen, wobei die Formatierungsleiste über der Tastatur sichtbar bleibt.

### Geändert
- **Paletten auf 8 überarbeitet**: das neutrale **Klonkt** (goldener Akzent) ist der neue
  Standard, dazu sieben Vollfarb-Themes — **Forest**, **Ocean**, **Teal**, **Lilac**,
  **Sunset**, **Candy** und **Amber**.

### Entfernt
- **Hub-Modus** — **Klonkt** ist jetzt **solo oder Circles**; ein Kollektiv oder Label baust
  du über **Circles** auf (föderierte, eigenständige Seiten).
- **Native Kommentare und Google-Login** — Antworten, Likes und Boosts laufen jetzt komplett
  über das Fediverse.
- **Lokale Favoriten (♥)** — ersetzt durch das ⭐ Fediverse-Like.

### Behoben
- Der Mini-Player springt und scrollt zum gerade laufenden Track — auch aus einem Album oder
  einer Playlist — und hält ihn hervorgehoben.
- Leere Album-/Playlist-Cover greifen jetzt auf das Cover des ersten Tracks zurück.
- Ein Profilfoto, das nach dem Wechsel zu **WebP** im Header kaputtging, repariert sich nun
  selbst.
- Viele Korrekturen am **mobilen Beitrags-Editor**: zuverlässiges Scrollen, eine
  Formatierungsleiste, die an Ort und Stelle bleibt, keine Seitensprünge beim Tippen auf eine
  Schaltfläche, und eine Speicherleiste, die direkt über der Tastatur sitzt.

## [1.0.0-beta.2] — 2026-06-19

Erste Veröffentlichung, bei der wir die Version aktiv mitverfolgen (im Fußbereich angezeigt —
klick darauf für diese Seite).

### Hinzugefügt
- Versionsverfolgung: Die Versionsnummer im Fußbereich verlinkt auf diese Changelog-Seite.
- Acht Premium-Funktionen (über **Patreon** freigeschaltet): Newsletter/Mailingliste,
  Download-für-E-Mail, Veröffentlichungsplanung + Vorschauen nur für Fans, **EPK**/Pressekit,
  Profi-Statistiken, Link-in-Bio + Klickstatistiken, einbettbarer Player sowie Konzertkalender
  + Benachrichtigung.
- Newsletter-Anmeldefeld im Fußbereich (ein/aus in Verwaltung → Einstellungen).
- **SMTP**-Einstellungen in Verwaltung → Einstellungen konfigurierbar (keine Bearbeitung der
  Konfigurationsdatei mehr nötig), mit einer Test-Mail-Schaltfläche.

### Geändert
- Aufgeräumtere Einstellungsformulare (gestapelte Beschriftungen, Eingabefelder in voller
  Breite).
- Das **EPK**/Pressekit zeigt die 10 meistgehörten Tracks.
- Schönere 404-Seite (mobilfreundlich) und klarere Login-Fehlermeldungen.

### Behoben
- Der seitenweite Audioplayer lud keine Tracks.
- Schaltflächentext wurde beim Überfahren unlesbar.
- Datumsauswahlen folgen jetzt dem Theme.
- Die Vor-/Zurück-Navigation zeigt keinen doppelten Header mehr.
