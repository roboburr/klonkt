# Privacyverklaring: betaalde posts (concept)

Status: CONCEPT. Hoort bij de paid-posts-feature (in ontwikkeling). Dit is de
tekst die een Klonkt-site als pagina toont zodra de feature aan staat; de
site-eigenaar is de verwerkingsverantwoordelijke voor zijn eigen site. EN/DE
volgen zodra de feature meelevert.

Ontwerpbeslissingen waar deze tekst op leunt (Robin, 21-7-2026): her-link met
vervaltermijn (geen Patreon-id opgeslagen), passkey per post, geen cookies.
Als een van die drie ooit wijzigt, moet deze tekst mee wijzigen.

---

## In gewone taal

- Om een betaalde post te lezen bewijs je met een **passkey** dat je supporter
  bent. Meer niet.
- Wij slaan **geen naam, geen e-mailadres, geen Patreon-account en geen
  cookies** van je op.
- De koppeling met Patreon gebeurt **eenmalig in je eigen browser**, direct met
  Patreon. Wij onthouden alleen het resultaat: deze passkey hoort bij een
  geldige supporter, tot een vervaldatum.
- Verloopt het? Dan koppel je gewoon opnieuw. Zo hoeven wij nooit bij te houden
  wie je bent.
- Lekt onze database ooit uit, dan staat daar niets in dat naar jou als persoon
  te herleiden is.

## Wat wij opslaan, en wat niet

| Slaan wij op | Slaan wij NIET op |
| --- | --- |
| De publieke sleutel van je passkey | Je naam of e-mailadres |
| Bij welke site en welk steunbedrag/tier de passkey hoort | Je Patreon-account of Patreon-id |
| Een vervaldatum | Cookies of volgpixels |
| | Je IP-adres in dit verband |

De publieke sleutel van een passkey is een technisch gegeven dat alleen kan
bevestigen "dit is dezelfde passkey als toen". Er valt geen identiteit uit af
te leiden, en de geheime helft verlaat jouw apparaat nooit.

## Hoe de koppeling werkt

1. Je klikt op "ontgrendel via Patreon" bij een betaalde post.
2. Je logt in **bij Patreon zelf** (in je eigen browser, op patreon.com) en
   geeft eenmalig toestemming. Patreon vertelt deze site alleen of je een
   actieve supporter bent en op welk niveau.
3. Is dat zo, dan maak je op je apparaat een passkey aan. Vanaf dat moment is
   de passkey je enige sleutel. Wat Patreon in stap 2 meldde, bewaren wij niet:
   alleen het recht (site, niveau, vervaldatum) blijft over, gekoppeld aan de
   passkey.
4. Bij elke betaalde post bevestig je met je passkey (vingerafdruk, gezicht of
   pincode van je eigen apparaat). Er wordt geen sessie of cookie aangelegd.

## Geen cookies

Deze functie gebruikt geen cookies, geen localStorage-tracking en geen
sessies. Elke ontgrendeling is een losse, lokale bevestiging met je passkey.
Dat betekent ook: per post een korte bevestiging. Dat is een bewuste keuze,
geen gemis.

## Meerdere mensen tegelijk

Omdat er geen sessie en geen "ingelogde gebruiker" bestaat, kunnen meerdere
mensen tegelijk en los van elkaar posts ontgrendelen: elke bevestiging staat op
zichzelf. Er is geen gedeelde toestand die van elkaar afhangt. Deel je hetzelfde
apparaat en profiel met iemand, dan kan de passkey-kiezer wel tonen dat de ander
een passkey heeft (geen toegang, alleen zichtbaar); gebruik dan aparte apparaten
of profielen.

## Bewaartermijn en verlopen

Het recht dat aan je passkey hangt heeft een vervaldatum die aansluit op de
maandelijkse Patreon-cyclus. Daarna doet de passkey niets meer en koppel je
opnieuw (stap 1 tot 3, doorgaans twee klikken omdat je bij Patreon al bent
ingelogd). Verlopen rechten worden opgeruimd. Wij kunnen je nergens aan
herinneren, want we weten niet wie je bent; dat is precies de bedoeling.

Stop je met steunen, dan werkt je passkey nog hoogstens tot de vervaldatum en
daarna niet meer.

## Als er iets misgaat (datalek)

Zou de database van deze site uitlekken, dan bevat die voor deze functie
alleen passkey-sleutels, steunniveaus en vervaldata. Die zijn niet tot
personen te herleiden: er is geen naam, e-mailadres of Patreon-id om ze aan te
knopen. Wij melden een datalek waar dat wettelijk moet, maar kunnen jou niet
persoonlijk waarschuwen, om dezelfde reden als hierboven.

## Jouw rechten (AVG)

Je hebt de gebruikelijke AVG-rechten (inzage, verwijdering, bezwaar). Er is
een eigenaardigheid: wij kunnen jou **niet identificeren** (artikel 11 AVG),
dus een verzoek per e-mail met "verwijder mijn gegevens" kunnen wij niet aan
een record koppelen. Wat wel werkt:

- **Verwijderen**: gebruik de "vergeet deze passkey"-optie op de site (je
  bevestigt met de passkey zelf, dat is het bewijs dat het record van jou is),
  of verwijder de passkey uit je apparaat en laat het recht simpelweg
  verlopen.
- **Inzage**: alles wat er over je passkey bestaat staat hierboven in de
  tabel; er is niets aanvullends om in te zien.

## Wie is waarvoor verantwoordelijk

- **De eigenaar van deze site** is verwerkingsverantwoordelijke voor de
  passkey-rechten hierboven, en voor de koppeling met zijn eigen
  Patreon-campagne. De site bewaart daarvoor een versleuteld toegangs-token
  van de **eigenaar zelf** (niet van supporters); daarmee kan de site tijdens
  jouw koppeling bij Patreon verifiëren dat je supporter bent.
- **Patreon** is zelfstandig verwerkingsverantwoordelijke voor je
  Patreon-account, je betaling en wat je daar deelt. Daarop is het
  privacybeleid van Patreon van toepassing (patreon.com/privacy). Patreon is
  een Amerikaans bedrijf; je koppeling loopt rechtstreeks tussen jouw browser
  en Patreon.
- **Klonkt** is de software waar deze site op draait en verwerkt zelf niets
  van jou; er is geen centrale Klonkt-dienst in deze flow.

## Grondslag

De verwerking (passkey-sleutel plus recht) is noodzakelijk voor de uitvoering
van wat je vraagt: toegang tot betaalde posts waarvoor je supporter bent
(artikel 6 lid 1 sub b AVG). Er wordt niets voor andere doeleinden gebruikt:
geen profilering, geen statistiek op persoonsniveau, geen delen met derden.

## Wijzigingen

Verandert deze functie, dan verandert deze tekst mee, met datum. Huidige
versie: concept, juli 2026.
