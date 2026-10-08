# De factuur-app op de Synology NAS (DS225+)

Stap voor stap de factuur-app installeren op de Synology, veilig bereikbaar via Cloudflare Tunnel.
Je hoeft **niets** open te zetten in de router, en DSM zelf blijft onbereikbaar van buitenaf.

```
Shopify ──(internet)──> Cloudflare ──(tunnel)──> factuur-app op de NAS ──> map "facturen"
                                                    ✗ DSM, andere mappen: niet bereikbaar
```

Wat je nodig hebt:

- De NAS met **DSM 7.2** of nieuwer
- Een **Cloudflare-account** (gratis), met je domein (bijvoorbeeld `laboratoriumdiscounter.nl`) bij Cloudflare
- Ongeveer een uur

---

## 1. DSM veilig zetten

In DSM (**Configuratiescherm**):

1. **Update DSM**: Update en herstel → installeer de nieuwste versie, en zet automatische beveiligingsupdates aan.
2. **Tweestapsverificatie** voor elk account met beheerrechten: Persoonlijk (rechtsboven) → Beveiliging → 2-stapsverificatie.
3. **QuickConnect uit**, als je DSM niet van buitenaf gebruikt: Externe toegang → QuickConnect → uitvinken.
4. Controleer in de **router** dat er geen poorten naar de NAS openstaan (vooral 5000, 5001, 443, 80). Die zijn niet nodig.

## 2. Mappen en programma's

1. **Package Center** → installeer **Container Manager** en **Snapshot Replication** (en **Hyper Backup** als die er nog niet is).
2. **Configuratiescherm → Gedeelde map → Maken**:
   - Naam: `facturen`
   - Locatie: Volume 1
   - Vink **"Gegevenscontrolesom inschakelen"** aan (beschermt tegen beschadigde bestanden)
3. De map `docker` bestaat na het installeren van Container Manager al. Maak daarin een map `factuur-app` (via File Station).

## 3. Een eigen gebruiker voor de app

De app krijgt een eigen gebruiker zonder beheerrechten, die alleen bij zijn eigen mappen kan.

1. **Configuratiescherm → Gebruiker en groep → Maken**:
   - Naam: `factuurapp`, met een lang willekeurig wachtwoord (je hoeft er nooit mee in te loggen)
   - Groep: alleen `users`
   - Rechten: **Lezen/schrijven** op `facturen` en `docker`, **Geen toegang** op alle andere mappen
   - Toepassingen: alles **weigeren** (geen DSM, geen File Station, geen SMB)
2. **Het gebruikersnummer opzoeken** (eenmalig, via SSH):
   - Configuratiescherm → Terminal en SNMP → **SSH-service inschakelen**
   - Op je pc, in PowerShell: `ssh <jouw-beheerdersnaam>@<ip-van-de-nas>`
   - Typ: `id factuurapp`. Je ziet iets als `uid=1027(factuurapp) gid=100(users)`.
   - Onthoud de twee getallen, en **zet SSH daarna weer uit**.

## 4. De bestanden op de NAS zetten

1. Kopieer de projectmap via **File Station** naar `docker/factuur-app`, **zonder** de mappen `node_modules`, `output` en `shopify-app`.
2. Maak in `docker/factuur-app` een bestand **`.env`** (kopieer `.env.example` en vul alles in, zie de README). Extra voor de NAS:
   - `PUID=` en `PGID=` → de twee getallen uit stap 3
   - `PUBLIC_URL=https://facturen.laboratoriumdiscounter.nl` (het adres uit stap 5)
   - `INVOICE_LINK_SECRET` → een **nieuw** lang geheim (zie README stap 4)
3. **Verhuis je van een andere computer?** Zet dan het nummerbestand `invoices.db` in `docker/factuur-app/data/`, en de PDF's in de map `facturen`. Anders begint de nummering opnieuw.
4. Geef `factuurapp` de juiste rechten: rechtsklik op `docker/factuur-app` → Eigenschappen → Machtiging → `factuurapp` **Lezen/schrijven**. Doe hetzelfde voor de map `facturen`.

## 5. Cloudflare Tunnel maken

1. Log in op **dash.cloudflare.com** → **Zero Trust** → **Networks → Tunnels → Create a tunnel**.
2. Kies **Cloudflared**, naam: `factuur-app`.
3. Kies als omgeving **Docker** en kopieer alleen het **token** (de lange tekst na `--token`). Zet het in `.env` bij `CLOUDFLARE_TUNNEL_TOKEN=`. **Deel het met niemand.**
4. Bij **Public hostname**:
   - Subdomain: `facturen`, Domain: `laboratoriumdiscounter.nl`
   - Service: **HTTP** → `factuur-app:8080`
5. Opslaan.

> Staat je domein nog niet bij Cloudflare? Voeg het toe (gratis plan) en zet de nameservers bij je domeinregistrar over naar Cloudflare. Je website blijft gewoon werken. Wil je dat niet, dan kan een apart goedkoop domein alleen voor de facturen ook.

### Extra beveiliging bij Cloudflare (aanbevolen)

Zo wordt alles wat niet voor de app bedoeld is al bij Cloudflare tegengehouden, nog vóór het je NAS bereikt.

1. **Alleen de adressen van de app doorlaten.** Cloudflare-dashboard → je domein → **Security → WAF → Custom rules → Create rule**:
   - Naam: `Alleen factuur-app`
   - Bewerk de expressie en plak:
     `(http.host eq "facturen.laboratoriumdiscounter.nl" and not starts_with(http.request.uri.path, "/webhooks/") and not starts_with(http.request.uri.path, "/api/") and not starts_with(http.request.uri.path, "/invoices/") and http.request.uri.path ne "/")`
   - Actie: **Block**
2. **Rem op proberen.** **Security → WAF → Rate limiting rules**: meer dan 100 verzoeken per minuut van hetzelfde IP-adres naar `facturen.laboratoriumdiscounter.nl` → **Block** voor 10 minuten.
3. **Security → Bots → Bot Fight Mode**: aan.
4. **SSL/TLS → Edge Certificates → Always Use HTTPS**: aan.

## 6. Starten

1. **Container Manager → Project → Maken**:
   - Projectnaam: `factuur-app`
   - Pad: `docker/factuur-app`
   - Bron: **gebruik het bestaande docker-compose.yml**
2. Klik door en **start** het project. De eerste keer duurt het bouwen een paar minuten.
3. Controleer bij **Container → factuur-app → Logboek** dat je ziet:
   `App is listening to port 8080`
4. Open in je browser `https://facturen.laboratoriumdiscounter.nl`. Je hoort te zien: **Invoice generator is running**.

Ziet de app een fout in de instellingen, dan staat in het logboek precies welke regel in `.env` ontbreekt.

## 7. Shopify koppelen

Pas na jouw akkoord, want vanaf hier is het live:

1. **Webhooks** in het Dev Dashboard (of Instellingen → Meldingen → Webhooks):
   - `orders/paid` → `https://facturen.laboratoriumdiscounter.nl/webhooks/orders-paid`
   - `refunds/create` → `https://facturen.laboratoriumdiscounter.nl/webhooks/refunds-create`
2. Zet hetzelfde adres in **`src/appUrl.js`** van beide extensies, en upload ze (`shopify app deploy`, zie README).
3. Plaats een **testbestelling** en kijk of de factuur binnen een minuut in de map `facturen` staat en in het klantaccount verschijnt.

## 8. Back-ups (niet overslaan)

1. **Snapshot Replication → Snapshots** → kies `facturen` en `docker`:
   - Schema: elk uur, bewaren: 7 dagen elk uur + 12 maanden maandelijks
   - Vink **"Onveranderbare snapshots"** (immutable) aan als je DSM dat aanbiedt: ransomware kan ze dan niet wissen
2. **Hyper Backup → Maken → Back-uptaak**:
   - Bestemming **buiten het kantoor**: Synology C2, of een tweede NAS of schijf op een andere locatie
   - Mappen: `facturen` en `docker/factuur-app` (die bevat het nummerbestand)
   - Elke nacht, met **versleuteling aan**. Bewaar het wachtwoord veilig, bijvoorbeeld in een wachtwoordkluis.
3. **Test één keer een terugzetting** van een PDF, zodat je weet dat het werkt.

De wet vraagt **7 jaar** bewaren. Zorg dat de back-up minstens zo lang teruggaat, of maak elk jaar een vaste kopie.

## 8b. E-mail naar klanten

1. Maak bij **Hostnet** de mailbox **facturen@laboratoriumdiscounter.nl** aan. Dit is een **no-reply**-adres: niemand leest deze mailbox.
2. Zet in die mailbox een **automatisch antwoord** aan: *"This address is not monitored. Please e-mail info@laboratoriumdiscounter.nl."*
3. Zet het wachtwoord in `.env` bij `SMTP_PASSWORD` (server `smtp.hostnet.nl`, poort `587`).
4. Stel **SPF en DKIM** in voor je domein (Hostnet-paneel, of bij Cloudflare als je DNS daar staat), anders belanden de mails in de spam.
5. Test: Container Manager → Container → factuur-app → **Terminal** → `node scripts/testEmail.js jouw@adres.nl`. Komt hij aan, en niet in de spam?
6. Zet `EMAIL_ENABLED=true` in `.env` en start het project opnieuw.

## 9. Automatische beveiligingscontrole

De NAS controleert elke week of er bekende beveiligingslekken zijn in de onderdelen van de app (Express, PDFKit en de pakketten die zij gebruiken) of in Node.js. **Je krijgt alleen een e-mail als er iets gevonden is.** De controle kijkt alleen, hij installeert en verandert niets.

1. **E-mailmeldingen van DSM aanzetten** (als dat nog niet aan staat): Configuratiescherm → **Melding → E-mail** → vul je e-mailadres in en klik **Testbericht verzenden**.
2. Configuratiescherm → **Taakplanner → Maken → Geplande taak → Door gebruiker gedefinieerd script**:
   - **Algemeen**: naam `Beveiligingscontrole factuur-app`, gebruiker **root** (nodig om in de container te kijken)
   - **Schema**: wekelijks, bijvoorbeeld maandag 07:00
   - **Taakinstellingen**:
     - Vink **"Details van uitvoering per e-mail verzenden"** aan, met je e-mailadres
     - Vink **"Alleen details verzenden wanneer het script abnormaal wordt beëindigd"** aan
     - Script:
       ```
       docker exec factuur-app node scripts/securityCheck.js
       ```
3. Klik op **OK**, selecteer de taak en klik **Uitvoeren** om het één keer te testen. In **Actie → Resultaten weergeven** moet je zien: `Packages: OK` en `Node.js …: OK`.

**Krijg je een e-mail?** Daarin staat wat er gevonden is en wat je moet doen:

- **Een pakket:** op je pc in de projectmap `npm audit fix` en daarna `npm test` (alle tests moeten slagen). Kopieer de bestanden naar de NAS en **bouw** het project opnieuw.
- **Node.js:** alleen in Container Manager → Project → factuur-app → **Bouwen** en opnieuw starten. Dat haalt de nieuwste Node.js 24 binnen.

Bijwerken gebeurt bewust **niet** automatisch: een update kan iets aan de facturen veranderen, en dat wil je eerst met de tests controleren.

## 10. Onderhoud

| Wat | Hoe |
|---|---|
| **Nieuwe versie van de app** | Vervang de bestanden in `docker/factuur-app` (niet `.env` en niet `data/`), daarna Container Manager → Project → **Bouwen** en opnieuw starten |
| **Ontbrekende facturen nu maken** | Dat gebeurt elk uur vanzelf. Direct: Container → factuur-app → **Terminal** → `node scripts/catchUp.js` |
| **Eén bestelling met de hand** | In dezelfde terminal: `node scripts/invoiceOrder.js LD1234` |
| **Na dataverlies** | `node scripts/restoreFromShopify.js` (kijken) en daarna `node scripts/restoreFromShopify.js --apply` |
| **Beveiligingsupdates** | De NAS controleert elke week zelf en mailt je alleen als er iets is (stap 9). Met de hand: `node scripts/securityCheck.js` in de terminal van de container. |
| **Verdachte activiteit** | In het logboek staat een regel "Rate limit: …" als iemand veel verzoeken doet. Bij Cloudflare zie je onder **Security → Events** wat er is tegengehouden. |
| **Kijken of alles werkt** | Container Manager laat de app op **gezond** (healthy) zien, en het logboek toont elke gemaakte factuur |

## Wat er gebeurt als…

| Situatie | Gevolg |
|---|---|
| **Stroom of internet valt uit** | Shopify probeert het een paar uur opnieuw. Daarna haalt de inhaalronde alles in zodra de NAS weer draait. |
| **Eén schijf gaat kapot** (bij twee schijven in RAID 1 / SHR) | Niets merkbaar. Vervang de schijf. |
| **De hele NAS gaat kapot** | Nieuwe NAS, stappen 1–6 opnieuw, en de back-up uit Hyper Backup terugzetten. Is er geen back-up, dan het herstelscript. |
| **Ransomware** | Zet de laatste schone snapshot terug. |
