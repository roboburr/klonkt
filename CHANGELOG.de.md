# Änderungen — Klonkt

Alle nennenswerten Änderungen an Klonkt. Das Neueste oben.
Versionen folgen [SemVer](https://semver.org/lang/de/) (`1.0.0-beta.N` während der Beta).

## [Unreleased]

### Hinzugefügt
- **Wähle eine helle oder dunkle Teilen-Karte.** Das automatisch erzeugte Teilbild folgt deinem
  Site-Thema; unter Verwaltung → SEO kannst du es jetzt fest auf hell oder dunkel stellen.
- **Eine Erwähnung ist jetzt eine Benachrichtigung.** Wenn dich jemand im Fediverse in einem
  Beitrag erwähnt — auch in einem, der keine Antwort an dich ist — erscheint das in deinen
  Fediverse-Benachrichtigungen mit einem Link zum Original.
- **Cover-Art bei offen geteiltem Audio.** Ein offen im Fediverse geteilter Track trägt jetzt sein
  Cover (oder das Beitragscover) mit, sodass Audio-Player, die Artwork unterstützen, es statt einer
  leeren Kachel anzeigen.
- **Einen Beitrag im Fediverse melden.** Von einem Fediverse-Beitrag aus kannst du ihn jetzt den
  Moderatoren seines Heimatservers melden, mit optionaler Begründung — und meldet jemand deine Seite,
  erscheint die Meldung in deinen Fediverse-Benachrichtigungen.
- **Sprache eines Beitrags festlegen.** Wähle, in welcher Sprache du einen Beitrag geschrieben hast —
  im Fediverse funktionieren damit der Sprachfilter der Timeline und die Übersetzen-Schaltfläche.
- **Alt-Text für Bilder.** Gib deinem Titelbild eine Beschreibung (Inline-Bilder behalten ihren
  eigenen Alt-Text) — sie föderiert ins Fediverse und lässt Screenreader das Bild beschreiben.
- **Erwähne Personen in einem Beitrag.** `@benutzer@server` in einem Beitrag verlinkt jetzt auf ihr
  Profil und benachrichtigt sie im Fediverse — auch wenn sie dir nicht folgen — wie eine Erwähnung
  in einer Antwort.
- **Kurze Videos im Feed spielen automatisch ab und wiederholen sich.** Ein animiertes Cover oder ein
  kurzer (≤30s) Clip im News-Feed wird jetzt automatisch stumm in Schleife abgespielt, wie ein GIF;
  längere Videos behalten ihre Steuerung.
- **Über Fediverse-Umfragen abstimmen.** Eine Umfrage von einem Konto, dem du folgst, erscheint jetzt
  im News-Feed mit Optionen und aktuellen Ergebnissen, und du kannst abstimmen — das föderiert zurück
  wie eine normale Mastodon-Stimme.
- **Erstelle eigene Umfragen.** Ein Beitrag kann jetzt eine Umfrage enthalten (Einfach- oder
  Mehrfachauswahl, mit einer Laufzeit). Sie föderiert als echte Fediverse-Umfrage, sodass deine
  Mastodon-Follower aus ihrer eigenen App abstimmen können; die Live-Ergebnisse stehen am Beitrag und
  die Umfrage schließt sich selbst, sobald die Zeit abgelaufen ist.

### Geändert
- **Audio offen zu teilen ist jetzt unumkehrbar.** Sobald ein Track offen im Fediverse geteilt wurde,
  ist die Datei verbreitet — erneutes "Schließen" wäre Scheinsicherheit. Der Editor sperrt die Wahl
  nach dem Öffnen und warnt dich, bevor du sie ankreuzt.

### Behoben
- **Entfernte Videos zeigen ein Vorschaubild.** Ein Video im News-Feed oder auf einer Zirkel-Kachel
  (z.B. von Loops oder PeerTube) erschien als schwarze Fläche, bis man auf Abspielen drückte; jetzt
  gibt es ein echtes Posterbild. (Längere Videos behalten bewusst ihre Steuerung — nur Clips unter
  30 Sekunden laufen automatisch wie ein GIF.)
- **Erwähnungen, Hashtags und Links in Klammern funktionieren jetzt.** Eine Erwähnung wie
  `(@benutzer@server)`, ein `(#hashtag)` oder eine URL in Klammern föderierte als reiner Text —
  und die erwähnte Person wurde nie benachrichtigt. Sie verlinken (und benachrichtigen) jetzt wie
  ohne Klammern.
- **Nackte Webadressen werden im Fediverse zu Links.** Eine einfache URL in einem Beitrag oder einer
  Antwort föderiert jetzt als klickbarer Link statt als reiner Text.

## [1.2.0] — 2026-07-01

### Hinzugefügt
- **PeerTube-Videos im Feed.** Ein PeerTube-Link in einem Beitrag zeigt jetzt einen eingebetteten
  Player im News-Feed, wie es YouTube, Spotify und SoundCloud bereits taten.
- **Helle Teilen-Bilder.** Seiten mit einem hellen Standard-Theme erhalten beim Teilen einer Seite
  nun eine passende helle Open-Graph-Karte statt immer einer dunklen.
- **Eigene Besuche aus der Statistik ausschließen.** Als Administrator kannst du jetzt deine eigene
  IP-Adresse aus deiner Seitenstatistik ausschließen, für ein wahreres Bild der echten Besucher.
- **Rechtsklick „Speichern" ist bei Covern, Bildern und Videos deaktiviert** — eine leichte Hürde,
  damit das Artwork nicht mit einem Klick gespeichert werden kann (Reibung, kein Schutz).

### Behoben
- **Animierte Video-Cover werden jetzt überall korrekt angezeigt.** Im Zirkel und im Raster konnten
  sie als kaputtes Bild oder leere Kachel erscheinen; sie werden nun als echtes, sich wiederholendes
  Video angezeigt, das das Quadrat füllt, zentriert. Ein Rechtsklick auf ein Cover zeigt das normale
  Link-Menü statt der Video-Steuerung des Browsers.
- **Jemandem zu folgen bleibt nicht mehr hängen.** Eine Follow-Anfrage, deren erste Zustellung
  fehlschlägt (der andere Server kurz nicht erreichbar), wird jetzt automatisch mit Backoff erneut
  versucht, statt für immer auf „ausstehend" zu bleiben.
- **Geboostete Beiträge zeigen ihren echten Text** im Zirkel, statt eines „RE: <Link>"-Präfixes.
- **Robustere Fediverse-Verarbeitung** — strengere Signaturprüfungen bei eingehenden Aktivitäten,
  Blockierungen erfassen jetzt auch einen Boost eines blockierten Autors, und die Synchronisierung
  angehefteter Beiträge kollidiert nicht mehr, wenn du mehrmals schnell speicherst.

## [1.1.0] — 2026-06-30

### Hinzugefügt
- **Animierte Cover spielen überall flüssig.** Lade ein animiertes WebP als Cover hoch, und Klonkt
  erstellt zusätzlich ein stummes, sich wiederholendes Video davon. iOS Safari — wo animiertes WebP
  ruckelt — bekommt das flüssige Video, jeder andere Browser behält das scharfe WebP, und im Fediverse
  federiert das Cover als Video, das in Mastodon und seinen Apps abspielt. Sichtbar im Beitrag, im
  Raster, im Feed und bei verwandten Beiträgen.
- **Medienbibliothek (Verwaltung → Medien).** Sieh jedes hochgeladene Bild, wo es verwendet wird,
  kopiere die URL und räume ungenutzte Dateien mit einem Klick auf — einschließlich des übrigen
  Videos/Posters eines animierten Covers. Bilder, Audio und Playlists teilen sich jetzt eine Tab-Leiste.
- **Teilen-Button** unter jedem Beitrag (natives Teilen-Menü oder Link kopieren).
- **Ersetze die Audiodatei eines Tracks**, ohne den Track neu zu erstellen.
- **Musik im Fediverse (erster Schritt).** Audio-Beiträge tragen jetzt schema.org *MusicRecording* /
  *MusicAlbum*-Daten, und ein Schalter pro Beitrag kann einen gehosteten Track als echten
  Fediverse-Audioanhang teilen, der in den Feeds der Follower abspielt.

### Geändert
- **Sauberere Embeds auf Mastodon.** Ein Beitrag mit einem YouTube/Spotify/SoundCloud-Link lässt
  Mastodon jetzt seine Player-Karte anzeigen; Link-only-Tracks teilen ihre Streaming-Links. Das Cover
  bleibt in anderen Klonkt-Feeds sichtbar. (Auf deiner eigenen Seite ändert sich nichts — Player und
  Cover werden wie zuvor angezeigt.)
- **Zirkel bleiben auf die Fediverse-Art synchron** — Bearbeitungen und verpasste Beiträge holen über
  Standard-ActivityPub automatisch auf, sodass ein Zirkel nicht mehr veraltet.
- **Alles, was Klonkt federiert, ist jetzt gültiges AS2 / JSON-LD**, durch einen Test abgesichert,
  damit striktere Server es akzeptieren.
- Die Trackliste ist **nach Neueste zuerst** sortiert.

### Behoben
- **Animierte WebP-Cover werden nicht mehr auf ein einzelnes Bild eingefroren** (der Zuschneide-Editor
  und der Thumbnailer machten sie statisch).
- **Link-only-Tracks** (Spotify/YouTube, keine hochgeladene Datei) lassen sich wieder in einen Beitrag
  einfügen.
- **Link-Vorschauen** (og:image / Twitter-Karte) verwenden jetzt absolute Bild-URLs, damit sie auf
  Signal, WhatsApp und anderen Scrapern erscheinen.
- Mehrere **Fediverse-Zustellungs-Fixes**: Cover/Links werden auf Mastodon keine schwarze Kachel mehr,
  rohe Audiodateien überladen keinen Beitrag, der bereits einen Player hat, und tote Links eines
  umbenannten Remote-Beitrags heilen sich selbst.
- Der **mobile Feed** lädt Cover in voller Auflösung; lange Titel brechen um, statt überzulaufen.
- **Self-Hosting-Updates** sind zuverlässiger: ein erneuter Lauf des Installers behält deinen Kanal,
  und der Updater startet nicht mehr neu (oder behauptet kein Update), wenn du bereits aktuell bist.

## [1.0.0] — 2026-06-30

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
