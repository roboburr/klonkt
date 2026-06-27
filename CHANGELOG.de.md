# Änderungen — Klonkt

Alle nennenswerten Änderungen an Klonkt. Neueste oben.
Versionen folgen [SemVer](https://semver.org/lang/de/) (`1.0.0-beta.N` während der Beta).

> **Zwei getrennte Versionsnummern — nicht verwechseln:**
> - **App-Version** (dieses Changelog + Footer, `package.json`) = kosmetisch; bei jeder Release erhöhen.
> - **Föderations-Proto** (`KLONKT_PROTO` in `CircleFederation.js`, derzeit **2**) = bestimmt, ob
>   Klonkt-Sites in ihrem jeweiligen **Cirkel** föderieren können (Teil der signierten Grundlage).
>   Eine App-Versions-Erhöhung ändert das Proto **nicht** und bricht somit keine Cirkels. Erhöhe das
>   Proto **nur** bei Föderations-/Sicherheitsänderungen und rolle es dann im **Gleichschritt**
>   auf alle Instanzen aus (inkl. der Democirkels), damit sie weiterhin zusammenarbeiten.

## [Unreleased]

### Hinzugefügt
- Die Suche durchsucht jetzt auch **Titel** (nach Titel, Künstler und Album), nicht nur Beiträge.
  Gefundene Titel sind direkt in der Ergebnisliste abspielbar, mit einem
  „im Beitrag →"-Link zum Beitrag/Album/zur Playlist, in dem der Titel vorkommt.
- Die Beitragssuche nutzt jetzt **Präfix-Matching**: tippe „astr" und du findest „astra"
  (jedes Wort als Präfix, UND zwischen den Wörtern) — angenehmeres Suchen-während-du-tippst.
- **Fediverse-Client**: folge Konten (WebFinger → signiertes Follow), eine
  **Home-Timeline** (`/tijdlijn`) von denen, denen du folgst, ein **Benachrichtigungs-Posteingang**
  (`/meldingen`) und ⭐-Like / 🔁-Boost / ↩-Antworten aus der Timeline heraus.
- **Liken und Antworten über das Fediverse** bei einem Beitrag: Besucher geben nur
  ihren eigenen Server ein (`@du@server` oder `server.com`) und wickeln es auf ihrem
  eigenen Konto ab (`/authorize_interaction`).
- **HTTP-Signaturen erzwungen** im Posteingang: unsignierte oder gefälschte
  Aktivitäten werden abgewiesen — keine gefälschten Reaktionen/Likes/Follower mehr.
- **Blockieren/Defederieren** eines Kontos oder einer ganzen Domain (`/blokkeren`).
- **Live-Theme-Vorschau** in Verwaltung → Site-Einstellungen: Akzent, Theme und Palette
  sofort sichtbar, bevor du speicherst.

### Geändert
- **Paletten überarbeitet** auf 8: die neutrale **Klonkt** (Weiß/Schwarz, goldener Akzent)
  ist jetzt der Standard, dazu 7 echte Farb-Themes (Forest, Ocean, Teal, Lilac,
  Sunset, Candy, Amber). Akzent-Auswahl aufgeräumt; der Klonkt-Hintergrund folgt
  jetzt der gewählten Akzentfarbe.

### Entfernt
- **Hub-Modus** entfernt — Klonkt ist von nun an **solo oder Cirkels**. Ein
  Kollektiv/Label erstellst du jetzt über **Cirkels** (föderierte einzelne Sites).
- **Native Reaktionen + Google-Login** entfernt — Interaktion läuft jetzt vollständig
  über das **Fediverse**.
- **Lokale Favoriten (♥)** entfernt — ersetzt durch das ⭐ Fediverse-Like.

### Behoben
- Mini-Player: Springen + Scrollen zum spielenden Track funktioniert jetzt auch aus einem
  **Album oder einer Playlist** (die Track-ID fehlte in der Wiedergabe-Queue).
- Der gerade spielende Track erhält ein **dauerhaftes Highlight** im Beitrag.
- Leere **Album-/Playlist-Cover** behoben (eine fehlende Referenz in der
  WebP-Konvertierung) + sie fallen jetzt auf das Cover des ersten Tracks zurück.
- Kaputtes **Avatar/Profilbild** in der Kopfzeile nach der WebP-Konvertierung: der Viewer-Avatar
  (und die Rolle) wird jetzt frisch aus der Datenbank gelesen, sodass sich eine alte Sitzung
  ohne erneutes Einloggen selbst wiederherstellt.

### Behoben (früher)
- Inline-Content-Layout auf Touch vereinfacht: keine Formatierungs-Toolbar/Rand mehr inline
  (du bearbeitest ohnehin im Vollbild) — nur die Content-Vorschau + die Tippen-zum-Bearbeiten-Pille.
- Konnte auf der Bearbeiten-Seite nicht scrollen: die Vollbild-Scroll-Sperre (overflow:hidden
  auf html/body) blieb hängen. Sperre entfernt — das Vollbild-Frame deckt die Seite
  bereits ab und auf Touch sind die Scrollbalken ausgeblendet.
- Das Verlassen des Vollbilds scrollt jetzt an den Anfang des Contents (statt durchzuspringen
  zum Footer).
- Der „Tippen zum Bearbeiten"-Hinweis auf Touch ist jetzt eine Pille, die sticky unten am
  Container klebt (über der Speichern-Leiste), statt unschön zentriert im Text.
- Scrollbalken ausgeblendet auf Mobil & Tablet (Touch) — Scrollen funktioniert weiterhin,
  nur die Balken-UI ist weg (keine verwirrenden/doppelten Balken).
- Vollbild-Editor: kein doppelter Scrollbalken mehr — im Vollbild scrollt ausschließlich
  das Textfeld; das Frame und die Seite (html+body) dahinter sind gesperrt.
- Editor: das Bild springt nicht mehr beim Anklicken einer Formatierungsschaltfläche.
  Auf Mobil ist das Schreibfeld jetzt eine begrenzte Scroll-Box mit der Formatierungs-Toolbar
  STICKY oben: der Text scrollt darunter, die Toolbar bleibt immer im Blick, und
  das Caret-Scrollen, das mobiles Chrome erzwingt, bleibt innerhalb der Box, statt die ganze
  Seite springen zu lassen. (Plus: die Scrollposition wird rund um jeden
  Formatierungsbefehl beibehalten.) `interactive-widget=resizes-content` wieder entfernt — das ließ
  die Seite vor der Tastatur nach oben scrollen und brach die kb-open-Erkennung; die
  Aktionsleiste + Vollbild regeln die Tastatur über den Visual Viewport.
- Post-Editor auf Mobil: die Speichern/Abbrechen-Leiste bleibt jetzt knapp über der
  Tastatur (sticky mit dynamischem Bottom-Offset = Maximum aus Tastatur- und
  Audioplayer-Höhe), statt dahinter zu fallen oder mitten im Bild zu schweben.
  Der Viewport skaliert mit der Tastatur mit (`interactive-widget=resizes-content`).
- Mobile Tastatur vs. Layout (site-weit): sobald die Tastatur während des
  Tippens öffnet, blenden sich die festen Unterleisten (Bottom-Tab + Mini-Player) aus, sodass
  sie nicht mehr über dem Eingabefeld schweben oder es überlappen. Sie kehren zurück, sobald
  die Tastatur schließt. (Erkennung über visualViewport → `body.kb-open`.)
- Beitrag bearbeiten auf Mobil öffnete nicht mehr sofort die Tastatur: der Titel erhielt
  nicht länger automatisch Fokus (`autofocus` entfernt). Auf dem Desktop fokussiert der Titel noch.
- Beiträge schreiben auf Mobil: eine Formatierungsschaltfläche (fett/kursiv/…) stahl den Fokus aus dem
  Textfeld → die Auswahl ging verloren (fett konnte nicht mehr ausgeschaltet werden) und die
  Seite sprang nach unten. Die Toolbar hält den Fokus jetzt im Editor
  (mousedown-preventDefault + Fokus ohne Scroll), sodass das Umschalten funktioniert und es keinen
  Sprung mehr gibt. Toolbar-Taps sind auch schneller (touch-action: manipulation). Aktive
  Formatierung ist jetzt deutlich mit der Akzentfarbe gefüllt (und :hover klebt nicht mehr auf
  Touch), sodass sichtbar ist, ob z. B. fett an oder aus ist.

### Hinzugefügt
- Bilder → **WebP**: neue Uploads (Beitragsbilder/Cover, Avatar, Site-Foto,
  Hub-Hero, Audio-Cover) werden automatisch in WebP umgewandelt (kleiner); bestehende
  Bilder wurden in einem Durchgang umgewandelt und alle Referenzen aktualisiert.
- Bilder sind **schwerer zu speichern** (Rechtsklick-„Speichern" + Ziehen
  blockiert) — Reibung, kein wasserdichter Schutz.
- Mini-Player (Desktop): Klick auf den spielenden Track → **springe zum Beitrag und scrolle
  zu diesem Track** (mit Highlight); funktioniert auch für site-weite Tracks über eine Lookup.
- Textfelder (`<textarea>`) wachsen jetzt site-weit mit dem Inhalt mit, statt intern
  zu scrollen (Scrollen-im-Scrollen war verwirrend). Das Inline-Schreibfeld wächst
  ebenfalls einfach mit; Tippen auf Mobil/Tablet geht ohnehin ins Vollbild.
- Auf **Mobil & Tablet** (Touch) verhält sich der Inhalt wie ein Beitrag: inline ist er
  **nicht tippbar** (Tap-Fläche mit „✎ Tippen zum Bearbeiten"-Pille). Ein Tipp öffnet eine
  **Vollbild-Schreib-„Seite"** — mit echter Zurück-Schaltflächen-Unterstützung, sodass das
  Browser-Zurück oder die **„✓ Fertig"-Schaltfläche** sie schließt und du wieder im Formular
  stehst (alle Felder intakt), woraufhin du alles zusammen mit der normalen Speichern-Schaltfläche speicherst.
- Schreibfenster kann auf **Vollbild** (Schaltfläche in der Editor-Toolbar, oder Escape zum
  Zurückgehen) — angenehm für ablenkungsfreies Schreiben auf Mobil. Die Formatierungs-Toolbar
  bleibt dabei immer oben im Blick, auch wenn die mobile Tastatur öffnet
  (Frame folgt dem Visual Viewport).
- Verwalter kann sein **Google-Konto verknüpfen** (Konto → Mit Google anmelden) und
  sich danach auch mit Google anmelden. Sicher: Verknüpfen ist nur möglich, während du mit
  Passwort angemeldet bist, und der Google-Login gewährt nur Verwaltung, wenn das exakte
  verknüpfte Google-Konto (`google_sub`) übereinstimmt. Entkoppeln ist möglich, solange es ein
  Passwort gibt.
- Beiträge liken / favorisieren: angemeldete Benutzer können einen Beitrag mit einer ♥-Schaltfläche liken
  (zeigt die Anzahl der Likes). Deine gelikten Beiträge stehen auf der neuen **Favoriten**-Seite
  (`/favorieten`, Link im Kontomenü). Nicht angemeldet → die Schaltfläche führt zum Login.

### Geändert
- Beitrags-Navigation (Newer/Older) zeigt jetzt ein 📌, wenn der verlinkte Beitrag angepinnt ist.
- Die Newer/Older-Beitragsnavigation steht jetzt auch auf der Fan-Gate (Login-Wall eines
  fan-only-Beitrags), sodass ein Besucher nicht festhängt, sondern weiterblättern kann.
  Navigation in ein gemeinsames Partial verschoben (`partials/post-nav.ejs`).
- Login aufgeteilt: die öffentliche Login-Seite (`/auth/login`) zeigt für Besucher jetzt
  **nur** Google-Login (Zuhörer/Fans). Der Verwalter-Login (Benutzername +
  Passwort) ist verborgen auf `/auth/admin` (nirgends verlinkt).
- Beitrags-Navigation (Newer/Older) behält jetzt auf jedem Beitrag dieselbe Zwei-Karten-Struktur:
  fehlt ein neuerer/älterer Beitrag, dann steht dort ein dezenter ausgegrauter
  Platzhalter („Neuester Beitrag" / „Ältester Beitrag") statt einer leeren Stelle.
- Beim Öffnen eines verwandten/nächsten Beitrags springst du jetzt an den Anfang der
  Seite (vorher: du bliebst an der alten Scrollposition hängen).

## [1.0.0-beta.2] — 2026-06-19

Erste Release, bei der wir die Version aktiv pflegen (sichtbar im Footer →
klicke darauf für diese Seite). Föderations-Proto: **2** (unverändert).

### Hinzugefügt
- Release-Tracking: die Versionsnummer im Footer verlinkt auf diese Änderungen-Seite.
- Acht Premium-Funktionen (Patreon-gated): Newsletter/Mailingliste, Download-für-E-Mail,
  Release-Planung + fan-only Previews, EPK/Pressekit, Pro-Statistiken, Link-in-Bio +
  Klick-Statistiken, einbettbarer Player und Show-Agenda + Notify-Me.
- Newsletter-Anmeldefeld im Footer (an/aus in Verwaltung → Einstellungen).
- SMTP-Einstellungen einstellbar in Verwaltung → Einstellungen (kein `.env`-Edit mehr nötig),
  mit Testmail-Schaltfläche.

### Geändert
- Verwaltung → Einstellungen: Hub- und Cirkel-Konfiguration stehen jetzt direkt unter der Modus-Karte;
  Formulare aufgeräumter (gestapelte Labels, full-width Inputs).
- EPK/Pressekit zeigt die Top 10 der meistgehörten Titel.
- Aufgeräumtere 404-Seite (mobilfreundlich) und deutlichere Login-Fehlermeldungen.

### Behoben
- Site-weiter Audioplayer erhielt keine Tracks (falsche Spalte in der Query).
- Schaltflächentext wurde beim Hover unlesbar (gleiche Farbe wie die Schaltfläche).
- Datumsauswahl folgt jetzt dem Theme.
- htmx-Navigation aktualisiert die Adressleiste wieder; keine doppelte Kopfzeile bei zurück/vorwärts.
