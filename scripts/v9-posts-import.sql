-- v9 → v1 post import
-- Run with: sqlite3 storage/database.sqlite < import.sql

BEGIN TRANSACTION;

-- audio-player: "Audio Player"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '10eca96b-6ca8-44a0-9b0e-88722465e4c9',
  (SELECT id FROM sites LIMIT 1),
  'audio-player',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Audio Player',
  '<p>Ik wilde mijn eigen platform samenstellen, mijn eigen app, mijn eigen omgeving, voor mijn posts, mijn muziek, mijn content.<br>En dat is gelukt =)<br><br><br>Mine, mine<span style="font-size: 1.0625rem;">, mine</span><span style="font-size: 1.0625rem;">, mine</span><span style="font-size: 1.0625rem;">, mine.<br><br></span></p><p><span style="font-size: 1.0625rem;"><br></span></p>',
  'speciaal voor mij een goede custom audio player website',
  'published',
  '/images/0e98262c47efe4bb.jpg',
  0,
  'audio',
  '["muziek","audio","player","website","prutcms","feature","custom","soundfabrics","build","zip"]',
  '2026-04-24T10:55:44+02:00',
  '2026-04-24T10:55:44+02:00',
  '2026-04-24T10:55:44+02:00'
);

-- cookie-monster: "Cookie Monster?"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '565cd5ed-7753-4210-bbd7-3c6842d84e88',
  (SELECT id FROM sites LIMIT 1),
  'cookie-monster',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Cookie Monster?',
  '<p>Kort antwoord: <span class="accent">PrutCMS zet geen tracking-cookies, spoort je niet, stuurt niks naar derden, en heeft geen consent-banner nodig</span>. Nul externe calls by default — geen enkele byte gaat naar een domein dat jij niet zelf host. Dit artikel legt uit wat er wél gebeurt en waarom dat binnen AVG/GDPR blijft.</p>

<h2>Wat PrutCMS NIET doet</h2>
<p>Geen Google Analytics. Geen Facebook Pixel. Geen Hotjar, Mixpanel, Segment, of enige andere analytics-dienst. Geen <a href="https://www.cookiepro.com">Consent Management Platform</a>. Geen externe fonts van fonts.googleapis.com. Geen CDN voor jQuery/Bootstrap/whatever. Geen Gravatar-calls. Geen OpenGraph-scrapes naar andere sites tenzij jij een URL embedded. Geen error-reporting naar Sentry of iets dergelijks. Geen newsletter-service tracking pixels. Geen "share"-buttons die naar Facebook/Twitter phonen.</p>

<p>Check zelf: open DevTools → Network tab → refresh een pagina. Je ziet alleen requests naar het domein waar je nu bent. Geen enkele third-party domain. Dat is geen accident — dat is het ontwerp.</p>

<h2>Wat PrutCMS WEL doet</h2>

<h3>Session cookies</h3>
<p>Als je inlogt, zet PrutCMS één cookie: <code>PHPSESSID</code>. Dit is een random ID dat jouw browser koppelt aan een server-side sessie. Alleen voor login-status, CSRF-protection, en shopping-cart-achtige state. Geen tracking-info in deze cookie, geen cross-site bruikbaarheid, <code>HttpOnly</code> en <code>SameSite=Lax</code> by default. Duur: tot je uitlogt of de sessie expired.</p>

<p>Voor anonieme bezoekers wordt er <strong>geen cookie gezet</strong>. Je kan volledig de hele site browsen zonder ooit een cookie te krijgen. Pas bij daadwerkelijk inloggen komt die PHPSESSID.</p>

<h3>Localstorage (alleen jouw browser)</h3>
<p>Voor gebruikers-comfort bewaart PrutCMS in je lokale browser-storage:</p>

<ul>
  <li><code>pcms-theme</code> — light/dark mode voorkeur</li>
  <li><code>pcms-audio-state</code> — welke track je aan het luisteren bent + positie (zodat het doorspeelt bij pagina-wissel)</li>
  <li><code>pcms-audio-volume</code> — jouw volume-setting</li>
</ul>

<p>Dit is géén cookie. Het leeft uitsluitend in jouw browser, wordt nooit naar de server gestuurd, en is niet leesbaar voor andere sites. Clear je browser-data en het is weg. AVG/GDPR: localStorage voor puur functionele voorkeuren zonder tracking-doel valt onder "strikt noodzakelijk" en vereist geen consent-banner.</p>

<h3>Service worker (PWA)</h3>
<p>Voor de installable-app-functionaliteit registreert PrutCMS een service worker (<code>/sw.js</code>). Deze cached je site offline, maar doet geen calls naar derden, bewaart geen analytics, en tracked geen usage. Je kan ''m zien via DevTools → Application → Service Workers, en uitschakelen met <code>/sw-reset</code>.</p>

<h3>Signed audio URLs (v9)</h3>
<p>Audio-bestanden krijgen een HMAC-signed tijdelijke URL (10 minuten geldig). Hotlinkers en scrapers kunnen je audio niet stelen — directe URL''s naar <code>/audio/hash.mp3</code> geven 403. De signing-logica draait volledig op jouw server met een eigen secret. Geen externe auth-service, geen DRM-licentie-server, geen telemetrie over wie wat afspeelt.</p>

<p>De player vernieuwt URLs proactief elke 8 minuten via jouw eigen domein (<code>?refresh_audio=1</code>). Geen externe token-server, geen third-party refresh-dienst. Wat over de lijn gaat is alleen een lijst van jouw eigen audio-files met nieuwe signatures.</p>

<h3>MediaSession API (lockscreen controls)</h3>
<p>Deze API toont de huidige track + cover op je telefoon-lockscreen, in de notification-bar, en laat bluetooth-headphone-knoppen werken. Dit is <strong>100% browser-lokaal</strong>: metadata wordt door <em>jouw</em> browser aan <em>jouw</em> OS doorgegeven, niet naar een server gestuurd. Geen Google Cast, geen Spotify Connect, geen external media registry — pure native browser API.</p>

<h3>Wake Lock API (scherm-actief tijdens play)</h3>
<p>Tijdens audio-playback stelt de speler het scherm-blanking uit zodat je telefoon niet in deep sleep gaat halverwege een track. Dit gaat via de <strong>browser Wake Lock API</strong> — een lokale OS-permissie die jij per site kunt geven of weigeren. Geen tracking, geen batterij-drain-profilering, geen "wie luistert wanneer"-logging. De lock wordt automatisch losgelaten zodra je pauzeert of de tab sluit.</p>

<h3>Server logs</h3>
<p>Apache/nginx logt standaard wat requests, incluis IP-adres. PrutCMS doet zelf géén IP-logging in applicatie-data. Voor rate-limiting (login-pogingen etc) wordt het IP-adres <strong>gehashed</strong> opgeslagen in de database of in een klein rate-limit-bestand — niet rauw. Audit logs bevatten actions (wie logde in, wie verwijderde een post) maar gebruiken ook gehashed IPs.</p>

<p>Wat je hoster met server-logs doet valt buiten PrutCMS. Goede hosters (TransIP, Hetzner, OVH) volgen AVG/GDPR en bewaren logs maximaal een paar weken. Check hun privacy-verklaring.</p>

<h3>Email (optioneel)</h3>
<p>Voor password-reset en email-verify stuurt PrutCMS emails via je server''s PHP <code>mail()</code> of via SMTP naar een mailserver die jij configureert. Geen Mailchimp, geen SendGrid, geen externe mailing-dienst. De email-adressen staan in je users-database of users.json, nooit bij een derde.</p>

<h2>CRDT-sync is ook privacy-neutraal</h2>
<p>Als je PrutCMS instances met elkaar laat syncen (voor multi-device of federation), gebeurt dit via je eigen domein. Geen central sync-server, geen "PrutCMS cloud", geen Anthropic/Google/AWS in de keten. Jij hosted alles, jij controleert het.</p>

<p>Elke tabel/bestand heeft een <code>hlc_ts</code> (Hybrid Logical Clock timestamp) voor conflict-free merging. Dit is technische metadata, geen identificatie. Als je twee kopieën wil mergen: beide draaien de sync-endpoint, pushen hun recent-changed items naar elkaar, HLC beslist welke "wint". Alles P2P tussen jouw servers.</p>

<h2>Externe embeds (als je ze gebruikt)</h2>
<p>Als je in een post een YouTube-video, SoundCloud-track, of Spotify-embed invoegt, wordt die vanuit hun servers geladen. Op <em>die</em> embed-pagina gelden hun cookies/tracking. PrutCMS gebruikt <code>youtube-nocookie.com</code> voor YouTube embeds by default — dat is YouTube''s privacy-enhanced mode die pas tracking-cookies zet na interactie.</p>

<p>Als je embeds vermijdt, heb je nul externe calls. Als je ze gebruikt, bepaal jij het per post, en de gebruiker ziet zelf waar ze vandaan komen (zichtbaar in DevTools).</p>

<h2>AVG/GDPR: geen consent-banner nodig</h2>
<p>De Europese AVG vereist een consent-banner voor niet-essentiële cookies en tracking. Aangezien PrutCMS <strong>geen niet-essentiële cookies zet en niet trackt</strong>, is er niets om consent voor te vragen. De enige cookie (PHPSESSID na login) valt onder "strikt noodzakelijk voor de aangevraagde dienst" — vrijgesteld van consent-plicht.</p>

<p>Als je zelf externe embeds, Google Analytics, of nieuwsbrief-tracking toevoegt: dan zul je weer een consent-banner moeten bouwen. Maar dat is jouw keuze, niet iets wat PrutCMS oplegt.</p>

<h2>MySQL-optie (v9.1+): wat verandert er?</h2>
<p>Met MySQL als backend werken dezelfde principes. Rate-limit en audit-log verhuizen van JSON-files naar DB-tabellen, maar de inhoud blijft gelijk — gehashed IPs, geen rauwe identificatie. Je backup wordt <code>mysqldump</code> in plaats van <code>tar /posts</code>, maar de data blijft op jouw server.</p>

<h2>Bewijs: audit het zelf</h2>
<p>Open <code>grep -r "google\|facebook\|fbq\|gtag\|analytics\|hotjar\|segment" /path/to/prutcms</code>. Resultaat: geen matches in de core. De enige "google" die je zou kunnen vinden is in docs of comments — geen enkele runtime-call.</p>

<p>Voor forensische zekerheid: draai PrutCMS achter een firewall die outbound connections logt (<code>tcpdump</code> of je router''s logs). Surf door je eigen site. Het enige outbound verkeer zou naar update-checks of embed-URLs moeten zijn — en die kan je uitschakelen.</p>

<p>Dat is PrutCMS''s belofte, en het is controleerbaar. Geen marketing, gewoon geen externe calls.</p>
',
  'PrutCMS zet geen tracking-cookies, spoort je niet, stuurt niks naar derden, en heeft geen consent-banner nodig. Zero external calls by default. Dit artikel legt per onderdeel uit wat er wel en niet gebeurt met je data.',
  'published',
  '/images/4cc2237d68c1b5f4.jpg',
  1,
  'overig',
  '["privacy","avg","gdpr","cookies","security","no-tracking"]',
  '2026-04-24T10:29:59.000Z',
  '2026-04-24T10:29:59.000Z',
  '2026-04-24T10:29:59.000Z'
);

-- covers: "AI Covers"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '542da3fd-5e28-4e6c-9999-00efe8ce992e',
  (SELECT id FROM sites LIMIT 1),
  'covers',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'AI Covers',
  '<div data-pcms-playlist="ai-covers" contenteditable="false" class="post-playlist-ref">📃 Playlist <code>ai-covers</code> — wordt automatisch geladen bij weergave</div><p><br></p>',
  '',
  'published',
  '/images/b40355d8b9b5cf87.jpg',
  1,
  'overig',
  '[]',
  '2026-04-25T09:46:53.000Z',
  '2026-04-25T09:46:53.000Z',
  '2026-04-25T09:46:53.000Z'
);

-- officialapp: "Als je durft"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '386c48b8-53a0-4baf-8829-002e452cd2d0',
  (SELECT id FROM sites LIMIT 1),
  'officialapp',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Als je durft',
  '<p>Ik bied een officiele soundfabrics app aan alleen voor Android gebruikers.<br><br>Klik op de onderstaande link beneden om het te installeren:<br>&gt;&nbsp;<a href="https://roboburr.com/apk-build/soundfabrics.apk">soundfabrics.apk</a><br><br>Voor nieuwe gebruikers, dit is een app dat niet te vinden is in de Play Store, dus moet onbekende bronnen aangezet worden om het te kunnen installeren.<br>Als het goed is, doet Play Protect ook meteen een veiligheidscan, waar het geen problemen mee zal gaan vinden.<br><br>Groet Robin</p>',
  'Ik bied een officiele soundfabrics app aan alleen voor Android gebruikers.',
  'published',
  '/images/57944b37abd65d4f.jpg',
  1,
  'link',
  '["app","android","apk","file","soundfabrics","roboburr","website","link","music","ai"]',
  '2026-04-24T18:06:34.000Z',
  '2026-04-24T18:06:34.000Z',
  '2026-04-24T18:06:34.000Z'
);

-- post: "Dit is een post"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '785545c2-c097-4d63-a166-db9d5f554070',
  (SELECT id FROM sites LIMIT 1),
  'post',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Dit is een post',
  '<p>Begin hier met schrijven… want dat doe je voor een post.</p><figure class="post-image post-image--small post-image--left" contenteditable="false"><img src="/images/a07ad0f1982e449b.jpg" alt=""></figure><p><br></p>',
  'alles testen!',
  'published',
  '/images/40a637c723fe2ad4.jpg',
  0,
  'tekst',
  '["post","random","schrijven","lol"]',
  '2026-04-24T09:02:08+02:00',
  '2026-04-24T09:02:08+02:00',
  '2026-04-24T09:02:08+02:00'
);

-- themesong-yougubrands: "Theme Song van YOUGU Brands"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '4665451b-43f7-45de-8800-67893573c25f',
  (SELECT id FROM sites LIMIT 1),
  'themesong-yougubrands',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Theme Song van YOUGU Brands',
  '<h2><span class="accent"><div class="post-audio-track" data-pcms-track-url="/audio/stream/b41e81f92618db3b.mp3?t=bad29408522df2a2baa73c3e43436c7d1b2758bd44a4712b2883131d2c188af8&amp;exp=1777069366" data-pcms-track="{&quot;url&quot;:&quot;/audio/stream/b41e81f92618db3b.mp3?t=bad29408522df2a2baa73c3e43436c7d1b2758bd44a4712b2883131d2c188af8&amp;exp=1777069366&quot;,&quot;title&quot;:&quot;Theme Song&quot;,&quot;artist&quot;:&quot;YOUGU Brands&quot;,&quot;cover&quot;:&quot;/images/d61ffcdb2a30c479.jpg&quot;}" contenteditable="false"><span class="pat-meta"><span class="pat-title">Theme Song</span><span class="pat-artist">YOUGU Brands</span></span><span class="pat-duration">4:54</span></div><p><br></p>yougubrands.com — het huis achter de merken</span></h2>

<p>Yougubrands.com is de digitale paraplu van de <span class="accent">YOUGU</span>-holding — de plek waar een zorgvuldig samengesteld portfolio van premium wellness- en lifestyle-merken zich als één familie presenteert. De kernboodschap wordt kort en bilingual (EN/CN) gebracht: <em>organisch leven verheffen via hoogwaardige producten en duurzame innovatie</em>. Waar natuurlijke wijsheid en moderne lifestyle-behoeften elkaar ontmoeten, zoals de tagline het formuleert. Het is een missiestatement dat bewust brede schouders heeft — want onder die paraplu hangt een verrassend eclectisch gezelschap.</p>

<p>Vier merken, vier werelden. <strong><span class="accent"><b>Daily Joy</b></span></strong> zit in de hoek van probiotica en dagelijks welzijn.<span class="accent"><b> Luxovious</b></span><strong></strong> mikt op de liefhebber van whisky en premium drank. <strong></strong><span class="accent"><b>Piko Bello </b></span>maakt producten voor kinderen. En<span class="accent"><b> OE</b></span><strong></strong> vervolmaakt het kwartet. Op papier een bijna vreemd mengsel — kinderverzorging naast single malt — maar de rode draad is de houding: natuur als startpunt, kwaliteit als norm, en een blik die duidelijk óók op de Chinese markt is gericht. Vandaar die consequente tweetaligheid in elke hoek van de site, van menu tot footer.</p>

<p>De site zelf is eerder een rustige etalage dan een schreeuwerige marketingbrochure. Zachtgroen, crème, het YOUGU-logo als terugkerend anker, een foundation-sectie voor de impact-kant van het verhaal, een blog voor context en verdieping, en — heerlijk eigenwijs detail — een <em>theme song player</em> bovenin de header. Het voelt als een merkenhuis dat niet bang is om even stil te staan bij wat het is en wat het doet, zonder de bezoeker meteen met pop-ups te bestoken. Overzichtelijk, hedendaags, en voor wie de afzonderlijke merken al kent: eindelijk een plek waar ze samenkomen.</p>

<p>🌱 <a href="https://yougubrands.com/about">yougubrands.com</a></p>',
  'yougubrands heeft nu een eigen theme song sinds de site bijna af is!',
  'published',
  '/images/43feb24aee7f899a.png',
  0,
  'tekst',
  '["yougubrands","yougu","bioyougu","website","finished","htmx","themesong","theme","song"]',
  '2026-04-24T09:11:18+02:00',
  '2026-04-24T09:11:18+02:00',
  '2026-04-24T09:11:18+02:00'
);

-- waiting-on-you: "Back to 1987!"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  '1d4fb567-453c-4695-8563-5e35b55ccdd5',
  (SELECT id FROM sites LIMIT 1),
  'waiting-on-you',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Back to 1987!',
  '<h3><span class="accent">Rick Astley — Waiting On You (80s AI Cover)</span></h3>

<p>Rick Astley bracht op 6 februari 2026 <em>Waiting On You</em> uit als verjaardagscadeau aan zichzelf —<span class="accent"> hij werd 60</span>. Het nummer schreef, produceerde en speelde hij vrijwel helemaal solo in zijn eigen studio The Spud Farm. Emotionele strijkers, zijn onmiskenbare bariton, en een tekst die terugblikt op de eerste vonk van liefde en hoe die een leven lang kan blijven nasmeulen. Astley zei er zelf over dat spelen op een gitaar ouder dan hijzelf hem anders doet schrijven — <em>"a decade long ago, lyrically and style wise"</em>. Het klinkt modern, maar met een ouder hart.</p><p><br></p>

<p>En precies dáár zit de grap van deze <span class="accent">80s AI-cover</span>. Waar het origineel bewust ingetogen en volwassen klinkt — piano, strijkers, de stem van een man die terugkijkt — sleurt deze versie het nummer terug naar<span class="accent"> exact de sound waar de Rickroll uit geboren i</span>s: die glimmende Stock Aitken Waterman-productie van <em><span class="accent">Never Gonna Give You Up</span></em>. Gated reverb drums, synth-stabs, een baslijn die stuitert. Het refrein krijgt ineens diezelfde onontkoombare earworm-energie als de hook <span class="accent">waarmee Astley in ''87 de wereld veroverde</span>.</p><p><br></p>

<p>Wat het grappig maakt, is dat het verdacht goed wérkt.<span class="accent"> <span class="accent"></span></span><span class="accent"><span class="accent"></span></span><span class="accent"></span>De tekst —<span class="accent"> </span><span class="accent"><span class="accent"></span></span><span class="accent"></span>steegjes, sigarettenrook, een wasserette-jukebox, een meisje met een cheeky grin — leest al als een 80s-videoclip. <span class="accent">Rick schreef in 2026 eigenlijk een nummer dat hij óók in 1987 had kunnen maken</span>; deze cover pakt dat gevoel bij de kladden en zet het terug in het juiste decennium. Het resultaat voelt haast als een verloren B-kant van <em>Whenever You Need Somebody</em> die pas nu is opgegraven. Je verwacht half dat er halverwege ineens díe bekende riff losbarst — en technisch gezien is dat deze keer niet eens een <span class="accent">Rickroll</span>, maar gewoon <span class="accent">dezelfde man, dezelfde DNA, veertig jaar later.</span></p><p><span class="accent"><br></span></p>

<p>🎧 Luister op deze&nbsp;website:<br><span style="font-size: 1.0625rem;"><div class="post-audio-track" data-pcms-track-url="/audio/stream/d773625168a0cbf3.mp3?t=f02624525b10ba9eaf3ebbecca5a2dd74a3c1b9becfc264f5196e81a748b4307&amp;exp=1777062695" data-pcms-track="{&quot;url&quot;:&quot;/audio/stream/d773625168a0cbf3.mp3?t=f02624525b10ba9eaf3ebbecca5a2dd74a3c1b9becfc264f5196e81a748b4307&amp;exp=1777062695&quot;,&quot;title&quot;:&quot;Waiting On You (AI 80s)&quot;,&quot;artist&quot;:&quot;Rick Astley&quot;,&quot;cover&quot;:&quot;/images/2b9db76a45f4d274.jpg&quot;}" contenteditable="false"><span class="pat-meta"><span class="pat-title">Waiting On You (AI 80s)</span><span class="pat-artist">Rick Astley</span></span><span class="pat-duration">3:23</span></div><p><br></p>Of op onderstaande streamingsdiensten, zoals:</span></p><p></p><p></p><p><a class="post-audio-external" data-platform="spotify" href="https://open.spotify.com/track/5KBRB9Ckyi2k1b6DqSAue1?si=3e475d757da948ec" target="_blank" rel="noopener noreferrer" contenteditable="false"><span class="pae-icon" aria-hidden="true">♫</span><span class="pae-meta"><span class="pae-title">Rick Astley - Waiting On You (AI 80s)</span><span class="pae-platform">Spotify</span></span><span class="pae-go" aria-hidden="true">↗</span></a><br><a class="post-audio-external" data-platform="soundcloud" href="https://soundcloud.com/roboburr/waitingonyou" target="_blank" rel="noopener noreferrer" contenteditable="false"><span class="pae-icon" aria-hidden="true">☁</span><span class="pae-meta"><span class="pae-title">Rick Astley - Waiting On You (AI 80s)</span><span class="pae-platform">SoundCloud</span></span><span class="pae-go" aria-hidden="true">↗</span></a><span style="font-size: 1.0625rem;"><br>Ook beschikbaar op andere diensten!</span></p><p></p><p><br></p><br><p></p><br><p></p>',
  'rick roll',
  'published',
  '/images/a07ad0f1982e449b.jpg',
  0,
  'audio',
  '[]',
  '2026-04-24T08:32:45+02:00',
  '2026-04-24T08:32:45+02:00',
  '2026-04-24T08:32:45+02:00'
);

-- welcome: "Welkom bij PrutCMS v9"
INSERT INTO posts (
  id, site_id, slug, author_id, title, content, excerpt,
  status, cover_image_url, pinned, type, tags,
  published_at, created_at, updated_at
) VALUES (
  'c714c515-8448-43ba-a563-e561f7f83569',
  (SELECT id FROM sites LIMIT 1),
  'welcome',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'Welkom bij PrutCMS v9',
  '<p>Dit is <strong>PrutCMS v9</strong> — een CMS dat wil wat de grote jongens doen, maar dan zonder 400 plugins, zonder tracking, en zonder je data kwijtraken aan een cloud-provider. Het draait op goedkope shared hosting én schaalt mee als het groeit. De filosofie is simpel: je moet altijd bij je data kunnen, hoe complex het ook lijkt.</p>

<p>Eén installatie draait zoveel sites als je wil, elk met eigen posts, styling en admins. Handig voor meerdere projecten onder één dak, of voor klanten met eigen ruimte op <code>jouwbedrijf.com/sites/klantnaam</code>. Elke sub-site krijgt eigen PWA manifest, eigen installable app, eigen RSS.</p>

<h2>💾 Files of MySQL — jouw keuze</h2>
<p>v9 werkt <strong>zonder database</strong>: elke post is een bestandje in <code>/posts</code>, elke user een regel in <code>users.json</code>, elke site een map. Portable tot het extreme — <code>zip -r backup.zip .</code> is je volledige backup. Restore = unzip.</p>

<p>Voor grotere sites is er nu <strong>MySQL-support</strong>. Run <code>php migrate.php init &amp;&amp; php migrate.php import</code>, zet <code>"storage": "mysql"</code> in config, en je hebt full-text search, real-time queries, foreign keys, transactions. Alles blijft backwards-compatible: switchen tussen <code>files</code> en <code>mysql</code> kost één config-regel. Zie <code>MYSQL-SETUP.md</code> voor de complete handleiding.</p>

<h2>🎧 Audio player met lockscreen</h2>
<p>Upload MP3, OGG, M4A of WAV via Media → Audio, en onderaan de site verschijnt een persistent player. Tik erop voor de <strong>full-screen expand-view</strong>: grote cover, next/prev, volledige wachtrij met klikbare track-covers, swipe-down om te sluiten. De player leeft buiten pagina''s — door de site klikken onderbreekt niet.</p>

<p>Via MediaSession API verschijnt de huidige track op het <strong>Android en iPhone lockscreen</strong>, inclusief cover, artist, en bediening. Bluetooth-headphone-knoppen werken. Wake Lock voorkomt dat je scherm afsluit tijdens playback. Proactieve URL-refresh elke 8 minuten houdt lange luistersessies alive.</p>

<p>Album-blocks voeg je toe via de 💿 knop in de editor: selecteer tracks, kies volgorde, en er verschijnt een klikbare album-cover met compacte tracklist. Klik op de cover — hele album laadt in de player. Track-switching gebeurt in de expand-view, niet in de post-HTML, wat de post schoon en klein houdt.</p>

<p><strong>Signed URLs</strong>: elke audio-file krijgt een HMAC-signed URL met 10-minuten TTL. Directe links naar <code>/audio/hash.mp3</code> geven 403. Stopt hotlinkers, scrapers, en DevTools-kopieer-acties.</p>

<h2>💬 Forum + Prutter + DMs</h2>
<p>Ingebouwd forum met categorieën, threads, replies, pinning, locking, en moderatie-rollen. <strong>Prutter</strong> is de korte-post timeline: 280-tekens, likes, reposts, replies. <strong>Direct messages</strong> tussen users, end-to-end toegang-gecontroleerd. Alles gewoon onderdeel van PrutCMS — geen externe service, geen federation-gedoe voor een simpele community.</p>

<h2>📲 Installable PWA + APK</h2>
<p>Op Android en desktop Chrome/Edge verschijnt een <strong>Installeren</strong>-knop. PrutCMS draait dan in eigen venster, zonder browser-balk, met offline-cache via service worker. Elke sub-site is apart installable.</p>

<p>Voor een echte Android-app: de <code>apk-build/</code> kit maakt een TWA (Trusted Web Activity) met Bubblewrap. Docker-based builder vereist alleen Docker — geen JDK 17, geen Android SDK, geen Node. Build, version-bump, en assetlinks-verify zijn losse scripts. Eén commando, getekende APK en AAB als output.</p>

<h2>🔐 Auth, 2FA, en rechten</h2>
<p>Eigen auth-systeem: username + password met bcrypt, optioneel TOTP (authenticator app) met backup-codes. Rate-limiting op login (file-based of MySQL-table). Rollen: <code>user</code>, <code>moderator</code>, <code>super_admin</code>, plus demo-mode voor read-only showcase-accounts. Invite-only registratie via tokens met TTL.</p>

<h2>🎨 Thema en aanpasbaarheid</h2>
<p>Dark/light mode auto-switched via prefers-color-scheme, met localStorage override. Per-site palet via <code>--accent</code> CSS variabele. Lettertypen zelf-gehost (geen Google Fonts). Mobile-first tot en met iPhone SE (320px).</p>

<h2>🔒 Security</h2>
<p>CSRF tokens op alle POST endpoints. HMAC-signed audio URLs. XSS-safe HTML sanitizer. Path-traversal protection op alle file-operaties. Rate-limiting op login, signup, password-reset. Security headers: CSP, HSTS (2 jaar + preload), frame-ancestors, base-uri, form-action, object-src, Cross-Origin-Opener/Resource-Policy. Permissions-Policy blokkeert 6 APIs standaard. <code>.htaccess</code> heeft Gzip en Brotli compressie, plus long-lived cache voor statics.</p>

<h2>⚡ Snelle start</h2>
<p>1. Upload bestanden naar webroot. 2. Open de site — installer begeleidt je door super-admin aanmaken en wat basis-config. 3. Klaar. Voor MySQL-upgrade: check <code>MYSQL-SETUP.md</code>. Voor APK-build: check <code>apk-build/README.md</code>.</p>

<p>Veel plezier ermee. Als je iets stuk vindt: open een issue, of gewoon <code>grep -r "TODO" /path/to/prutcms</code> — misschien heb ik het al genoteerd.</p>
',
  'Self-hosted CMS met multi-site, file-based of MySQL backend, signed audio URLs met lockscreen-controls, CRDT-sync, forum, prutter, en een installable PWA. Geen tracking, geen cookies, geen telemetrie. Dutch humor included.',
  'published',
  '',
  1,
  'tekst',
  '["welkom","prutcms","v9","cms","privacy"]',
  '2026-04-24T10:00:00.000Z',
  '2026-04-24T10:00:00.000Z',
  '2026-04-24T10:00:00.000Z'
);

COMMIT;

-- Done. Verify with: sqlite3 storage/database.sqlite "SELECT id, slug, title, pinned FROM posts;"