# Änderungen — Klonkt

Alle nennenswerten Änderungen an Klonkt. Das Neueste oben.
Versionen folgen [SemVer](https://semver.org/lang/de/) (`1.0.0-beta.N` während der Beta).

## [Unreleased]

### Hinzugefügt
- **Der Kontoinhaber kann seine eigenen Follower und Gefolgten über C2S lesen.**
  Die `followers`- und `following`-Sammlungen bleiben für die Öffentlichkeit
  count-only (Datenschutz), aber eine Anfrage mit einem auf diese Seite
  begrenzten C2S-Bearer liefert jetzt die echten Actor-URIs, damit eine App
  (Shaer) eine Freundesliste bauen kann. Für anonyme Aufrufer ändert sich
  nichts.
- **App-Zugriff über OAuth 2.0 (ActivityPub Client-to-Server, Phase 1).** Klonkt
  spricht jetzt den standardmäßigen AP-C2S-Auth-Handshake, damit native und
  Web-Clients (zuerst die Shaer-Apps) sich verbinden können: dynamische
  Client-Registrierung (RFC 7591), ein PKCE-Authorization-Code-Flow mit einem
  Zustimmungsbildschirm, auf dem du wählst, als welche deiner Seiten die App
  posten darf, und Bearer-Tokens (gehasht gespeichert, einmalige Codes). Das
  Actor-Dokument bewirbt die OAuth- und uploadMedia-Endpunkte und
  `/.well-known/oauth-authorization-server` (RFC 8414) liefert die Metadaten,
  sodass Clients alles entdecken statt Pfade festzuschreiben. Nur öffentliche
  Clients + PKCE, keine Client-Secrets.
- **Die Outbox nimmt Beiträge von Apps an (C2S, Phase 1 komplett).** Ein
  `POST` mit Bearer-Token an `/ap/users/:slug/outbox` steuert jetzt dein Konto
  aus einer App: einen Beitrag veröffentlichen, antworten, liken, teilen, folgen
  und all das rückgängig machen. Aktivitäten laufen über dieselbe
  Zustell-Maschinerie wie die Web-UI; eine nackte Note wird laut Spezifikation in
  ein Create verpackt; Inhalt wird bereinigt; das Token ist an eine Seite
  gebunden. Hinweis: Das ist ActivityPub C2S, das die Shaer-Apps sprechen.
  Mastodon-Clients (Ivory usw.) nutzen Mastodons eigene API und werden hier nicht
  unterstützt.

### Behoben
- **OAuth-Zustimmung übergibt jetzt zuverlässig an native Apps.** Nach
  Allow/Deny war die Weiterleitung an ein natives Custom-Scheme (z. B.
  `com.klonkt.shaer:/oauth`) ein einfacher 302, den mobile Browser stillschweigend
  verwerfen. Der Zustimmungsschritt liefert nun eine kleine Zwischenseite für
  Nicht-http-Redirect-URIs, die automatisch weiterleitet und einen "App öffnen"-
  Tipp-Link bietet (ein Tipp startet die App auf Android zuverlässig; iOS'
  Web-Auth-Session fängt sie ohnehin ab). Web-Clients (http/https) bekommen
  weiterhin einen 302.
- **Besucher können auf die eigenen Kommentare des Seiteninhabers antworten.**
  Der Knopf "über das Fediverse antworten" erschien nur bei Kommentaren anderer;
  bei den eigenen Kommentaren der Seite in einem Thread bekamen Besucher nichts,
  sodass man dem Autor nicht von der eigenen Instanz aus antworten konnte.

## [1.5.0] · 2026-07-18

### Hinzugefügt
- **Nachrichten: deine Antworten und Meldungen auf einer Seite.** Ein
  Nachrichten-Tab ersetzt Antworten und Meldungen. Ein Strom mit Filterchips
  (Alle, Gespräche, Aktivität, Gesendet): deine eigenen gesendeten Antworten
  stehen mit im Gespräch (mit Bearbeiten und Löschen), Likes und Boosts auf
  denselben Beitrag gruppieren sich zu einer Zeile, private Antworten tragen ein
  Schloss, und Neues seit deinem letzten Besuch bekommt einen Punkt. Das
  Interaktions-Bookmarklet zog mit um. Alte /fediverse- und
  /notifications-Links leiten auf /messages um.
- **Connect: wem du folgst und wer dir folgt auf einer Seite.** Ein Connect-Tab
  ersetzt die getrennten Folge-ich- und Follower-Seiten, mit Richtung pro
  Verbindung (folge ich →, Follower ←, gegenseitig ↔) und, für Konten, an die du
  zustellst, wann sie zuletzt erreicht wurden. Konten, die du nicht mehr
  erreichst, wandern in einen eingeklappten Bereich "Nicht erreichbar" zum
  Aufräumen. Alte /following- und /followers-Links leiten auf /connect um.
- **Eingehende Antworten auf deine Beiträge moderieren.** Als Seiteninhaber
  kannst du eine Antwort jetzt aus deinem Thread entfernen (sie bleibt weg:
  erneute Zustellung und Thread-Auffüllung werden durch einen Tombstone
  blockiert) und sie beim Server des Autors melden, direkt aus dem Thread.
  Funktioniert auch für private Antworten, die sich nicht über den
  Fediverse-Interaktionsfluss behandeln lassen.

### Behoben
- **Ein geboosteter Videobeitrag behält sein Video im Zirkel.** Das Boosten
  eines Nur-Video-Beitrags (Loops.video) speicherte ihn ohne Medien, sodass der
  Zirkel eine nackte Textkachel statt eines Video-Thumbnails zeigte; erneutes
  Boosten konnte das Video sogar aus einer bereits gecachten Kopie löschen.
  Boosts tragen jetzt die vollen typisierten Medien, und ein Refresh löscht
  gecachte Medien nicht mehr.
- **Der Titel der Interaktionsseite folgt deiner Sprache.** "Interacteer via de
  fediverse" stand fest auf Niederländisch im Browser-Tab, auch auf einer
  englischsprachigen Seite.
- **Das Apple-Music-Icon sieht wieder wie das Apple-Logo aus.** Das alte Icon
  war eine entstellte Form.
- **Statistik-Spalten springen in der 30- und 90-Tage-Ansicht nicht mehr.**
  Spalten ohne Datumslabel klappten leicht ein; jede Spalte behält jetzt ihre
  Labelzeile.
- **Private Antworten erscheinen nicht mehr auf der öffentlichen Beitragsseite.**
  Eine Nur-Follower- oder Direkt-(DM-)Antwort auf deinen Beitrag wurde für alle
  im öffentlichen Thread gezeigt. Eingehende Antworten speichern jetzt ihre
  Fediverse-Adressierung; der öffentliche Thread zeigt nur öffentliche und
  ungelistete Antworten. Private erreichen dich weiterhin über Meldungen, mit
  dem zugehörigen Beitrag.
- **Nackte Video/Audio-Embeds laufen nicht mehr über die Spalte hinaus.** Ein
  `.webm` / `.mp4` / `.mp3`-Player passt jetzt in die Inhaltsbreite wie die
  iframe-Embeds; die Breitenregel galt zuvor nur für `iframe`.

## [1.4.0] · 2026-07-14

### Hinzugefügt
- **Follower-Liste mit Zustellstatus.** Ein neuer Fediverse-Tab zeigt, wer dir
  folgt und wann jedes Konto zuletzt erreicht wurde, sodass tote Konten auffallen
  und du sie nach einer Prüfung entfernen kannst.
- **Nackte Medienlinks spielen direkt ab.** Ein einfacher `.webm`-, `.mp4`- oder
  `.mp3`-Link wird jetzt ein echter Player statt eines toten Links.
- **Hashtags, Links und Erwähnungen sind auch auf deiner Seite anklickbar.**
  `#Tags`, URLs und `@Erwähnungen` in einem Beitrag werden zu Links auf der Seite
  selbst, nicht nur in der föderierten Kopie. Erwähnungen werden einmal beim
  Speichern aufgelöst, sodass Seiten schnell bleiben.

### Behoben
- **Antworten, gelöschte und bearbeitete Antworten kommen immer an.** Sie gingen
  verloren, wenn ein Server kurz nicht erreichbar war; sie laufen jetzt über die
  Retry-Warteschlange wie Beiträge.
- **Video-Thumbnails für mehr Videos.** Cover von Videos mit ihren Metadaten am
  Ende der Datei (Loops.video, Handy-Exporte) bekommen jetzt ein Thumbnail statt
  keines.
- **Ein reines Video-Cover zeigt ein Posterbild auf der Beitragsseite.** Es bleibt
  in der Solo-Ansicht nicht mehr leer.
- **Die installierte App zeigt bei wackeligem Start keine alten Daten mehr.** Ein
  Kaltstart bei schlechter Verbindung aktualisiert jetzt, statt eine veraltete
  Seite zu zeigen.
- **Die Updates-Seite folgt deinem Branch.** Auf dem Stable-Branch siehst du die
  Änderungen von main nicht mehr als „neueste“.

## [1.3.5] — 2026-07-04

### Behoben
- **Umfragen behalten ihr Cover, wenn sie geboostet werden.** Eine Umfrage mit
  Musik oder Embed wurde ohne Cover föderiert, sodass eine geteilte Umfrage eine
  leere Kachel zeigte; das Cover reist jetzt mit.
- **Die Updates-Seite der Android-App zeigt, was wirklich installierbar ist.**
  Sie las den neuesten Release-Branch, der der Handy-Build kurzzeitig
  vorauslaufen konnte — Aktualisieren installierte dann dieselbe Version erneut.
  Sie liest jetzt die Version des Handy-Bundles selbst.

## [1.3.4] — 2026-07-04

### Behoben
- **Boosts, die ihr Cover verloren hatten, bekommen es automatisch zurück.**
  Beiträge, die du vor dem Cover-Fix geboostet hast, waren ohne Artwork
  gespeichert; sie werden beim nächsten Neustart einmalig aufgefrischt. Ist der
  Heimserver eines Beitrags in dem Moment kurz nicht erreichbar, wird es bei den
  nächsten Neustarts erneut versucht statt endgültig übersprungen. Einen Beitrag
  erneut zu boosten aktualisiert jetzt ebenfalls die gespeicherte Kopie (Cover,
  Inhalt) — aus dem Feed wie von der Interact-Seite.

## [1.3.3] — 2026-07-03

### Behoben
- **Geteilte Musikbeiträge behalten ihr Cover.** Wenn du einen Titel von jemandem
  geteilt (geboostet) hast, dem du nicht folgst, fehlte das Cover; es wird jetzt
  angezeigt, genau wie bei Personen, denen du folgst.

## [1.3.2] — 2026-07-02

### Behoben
- **Die Updates-Seite funktioniert jetzt in der Android-App.** Sie zeigt ab
  sofort die neueste verfügbare Version, und der Aktualisieren-Button lädt und
  installiert sie direkt auf dem Handy (Beiträge und Einstellungen bleiben
  erhalten).

## [1.3.1] — 2026-07-02

### Behoben
- **Musik läuft auf Android im Hintergrund weiter.** Wenn ein Titel endete,
  während das Handy gesperrt oder die App im Hintergrund war, startete der
  nächste Titel und stoppte nach einer Sekunde wieder. Der Player führt die
  Warteschlange jetzt als einen durchgehenden Stream zu, sodass das
  Weiterspringen zum nächsten Titel nicht mehr als "neue" Wiedergabe zählt,
  die der Browser pausieren darf.

## [1.3.0] — 2026-07-02

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
