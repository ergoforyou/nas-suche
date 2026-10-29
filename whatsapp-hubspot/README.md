# WhatsApp ↔ HubSpot (eigener Server auf der Synology)

Euer WhatsApp Business läuft weiter auf dem Firmen-Telefon. Ein kleiner Server auf der DS1517+ meldet sich dort als **verknüpftes Gerät** an, so wie WhatsApp Web. In HubSpot hat dann jeder Kontakt eine Karte **„WhatsApp“** mit dem kompletten Verlauf und einem Feld zum Antworten. Das ist derselbe Weg wie bei der Unterschriften-App.

```
Firmen-Telefon (WhatsApp Business, Hauptgerät)
        ⇅  verknüpftes Gerät
Synology DS1517+ · Docker „wa-hubspot“ · Verlauf + Bilder/Dateien + Admin-Seite
        ⇅  HTTPS (DSM-Reverse-Proxy, Let's Encrypt)
HubSpot · Karte „WhatsApp“ am Kontakt · Felder · Chronik
```

## Was es kann

- **Verlauf am Kontakt:** Jede Nachricht landet beim richtigen Kunden. Dafür werden Nummern in jedem Format abgeglichen („0170 123…“, „+49 170 123…“, „0170/123…“). Das gilt für eingehende Nachrichten, für Nachrichten vom Telefon und für Nachrichten aus HubSpot.
- **Parallel antworten:** Alle mit HubSpot-Zugang schreiben aus der Karte heraus. Gespeichert wird, wer gesendet hat („Erika Muster · 14:32 ✓✓“).
- **Bilder und Dokumente** vom Kunden werden auf der NAS gespeichert und in der Karte angezeigt bzw. verlinkt.
- **Felder am Kontakt** (Gruppe „WhatsApp“, legt der Server selbst an): WhatsApp-Nummer, letzte Nachricht (Zeit und Text), ungelesen, wartet auf Antwort. Damit funktionieren Listen wie „WhatsApp offen“ und Workflows, etwa eine Aufgabe für den Betreuer.
- **Chronik:** ein Eintrag „WhatsApp“ pro Kunde und Tag, der mitwächst. Er kann auch pro Nachricht geschrieben oder abgeschaltet werden.
- **Neue Nummern** werden automatisch als Kontakt angelegt (abschaltbar).
- **Alter Verlauf:** Beim ersten Verbinden übernimmt der Server den Verlauf, den WhatsApp an neue Geräte schickt. Ältere Bilder kommen dabei nicht mit.

## Wichtig vorab: Risiko der inoffiziellen Anbindung

Die offizielle Meta-Schnittstelle (Coexistence) ist bei euch blockiert, solange Meta die alte Superchat-Kreditlinie nicht von eurem WhatsApp-Konto entfernt (Fehler #2655093). Dieser Server nutzt deshalb das Protokoll von WhatsApp Web über die Bibliothek [Baileys](https://github.com/WhiskeySockets/Baileys). **Das erlauben die WhatsApp-Nutzungsbedingungen nicht.** WhatsApp kann eine Nummer sperren, wenn es solche Zugänge erkennt. Das Risiko steigt vor allem mit Massenversand und automatischen Antworten.

Eingebaute Vorsicht: keine Rundschreiben, keine Automatik, Tageslimit für gesendete Nachrichten, kurzes „schreibt …“ vor jeder Nachricht, nur Einzelchats.

**Empfehlung:** Zuerst 2–4 Wochen mit einer zweiten Nummer testen (Prepaid-SIM, WhatsApp Business auf einem Ersatz-Handy). Erst danach die Hauptnummer verbinden. Sobald Meta die Sperre aufhebt, kann die WhatsApp-Anbindung auf die offizielle Schnittstelle umgestellt werden. Ersetzt wird dann nur `server/src/whatsapp.js`, Karte, Felder und Verlauf bleiben.

## Einrichtung

### 1. Adresse und HTTPS auf der Synology

HubSpot muss den Server über HTTPS erreichen. Im Beispiel heißt die Adresse `wa.ergoforyou.de`.

1. **DNS:** Beim Domain-Anbieter einen Eintrag für `wa.ergoforyou.de` anlegen. Bei fester IP ist das ein A-Eintrag auf eure öffentliche IP. Sonst ein CNAME auf euren Synology-DDNS-Namen (DSM → Systemsteuerung → Externer Zugriff → DDNS).
2. **Router:** TCP **443** und **80** an die NAS weiterleiten. Port 80 braucht nur Let's Encrypt. Die Ports 5000/5001 (DSM-Anmeldung) **niemals** freigeben.
3. **Zertifikat:** DSM → Systemsteuerung → Sicherheit → Zertifikat → Hinzufügen → Let's Encrypt für `wa.ergoforyou.de`.
4. **Reverse Proxy:** DSM → Systemsteuerung → Anmeldeportal → Erweitert → Reverse Proxy → Erstellen.
   - Quelle: Protokoll HTTPS, Hostname `wa.ergoforyou.de`, Port 443
   - Ziel: Protokoll HTTP, Hostname `localhost`, Port 3000
   - Danach unter Zertifikat → Einstellungen das neue Zertifikat diesem Eintrag zuweisen.
5. **Absichern:** DSM-Firewall aktivieren (nur 443/80 von außen), automatische Blockierung und 2-Faktor-Anmeldung für DSM einschalten.

### 2. HubSpot-App hochladen

Auf einem PC mit [Node.js](https://nodejs.org) (Version 22 oder neuer):

```bash
npm install -g @hubspot/cli
hs account auth                      # mit eurem Portal 146305116 verbinden
cd whatsapp-hubspot/hubspot-app
node setze-adresse.mjs https://wa.ergoforyou.de
cd src/app/cards && npm install && cd ../../..
hs project upload
```

Danach in HubSpot unter **Entwicklung → Projekte → whatsapp-hubspot** die App „WhatsApp“ öffnen und, falls angeboten, installieren. Im Bereich **Auth** stehen das **Zugriffstoken** und das **Client-Secret**. Beide braucht der Server.

### 3. Server auf der NAS starten

1. Den Ordner `whatsapp-hubspot/server` per File Station nach `/volume1/docker/wa-hubspot` kopieren.
2. Dort `.env.example` als `.env` kopieren und ausfüllen: `PUBLIC_URL`, `HUBSPOT_TOKEN`, `HUBSPOT_CLIENT_SECRET`, `ADMIN_PASSWORT`.
3. **Container Manager → Projekt → Erstellen:** Name `wa-hubspot`, Pfad `/volume1/docker/wa-hubspot`, vorhandene `docker-compose.yml` verwenden, erstellen und starten. Der erste Bau dauert einige Minuten.
4. Protokoll: Container Manager → Container → `wa-hubspot` → Protokoll. Beim ersten Start legt der Server die WhatsApp-Felder in HubSpot an.

### 4. WhatsApp verbinden

1. `https://wa.ergoforyou.de/admin` öffnen (Benutzername beliebig, Passwort aus der `.env`).
2. Am Firmen-Telefon: WhatsApp Business → Einstellungen → **Verknüpfte Geräte → Gerät hinzufügen** → QR-Code scannen.
3. Die Seite zeigt „Verbunden mit +49…“. Der alte Verlauf läuft danach im Hintergrund ein.

### 5. Karte und Listen in HubSpot

- **Karte einblenden:** Einen Kontakt öffnen → Datensatz anpassen. Dort in der Mitte einen Tab „WhatsApp“ anlegen oder unter „Übersicht“ eine Karte hinzufügen → Apps → **WhatsApp**.
- **Liste „WhatsApp offen“:** Kontakte → neue Ansicht, Filter „WhatsApp: wartet auf Antwort = Ja“, sortiert nach „WhatsApp: letzte Nachricht“.
- **Benachrichtigung (optional):** Workflow „wenn WhatsApp: ungelesen > 0“ → Aufgabe oder interne Benachrichtigung an den Kontaktinhaber.

## Betrieb

- **Das Telefon bleibt Hauptgerät.** Es muss eingeschaltet und mindestens alle ~14 Tage online sein, sonst meldet WhatsApp verknüpfte Geräte ab. Am besten bleibt es im Büro am Ladekabel im WLAN.
- **„WhatsApp nicht verbunden“** in der Karte: `/admin` öffnen und den QR-Code neu scannen. Lesen geht auch ohne Verbindung.
- **Chats ohne Kontakt:** Schreibt jemand, dessen Nummer WhatsApp nicht verrät (nur Benutzername), erscheint der Chat auf der Admin-Seite. Dort lässt er sich per Kontakt-ID zuordnen.
- **Sicherung:** Hyper Backup für `/volume1/docker/wa-hubspot/data`. Der Unterordner `anmeldung` enthält den WhatsApp-Schlüssel. Wer ihn hat, kann mitlesen, also wie ein Passwort behandeln.
- **Update:** Dateien ersetzen, dann Container Manager → Projekt → Aktion → Erstellen.

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PUBLIC_URL` | – | Öffentliche HTTPS-Adresse, z. B. `https://wa.ergoforyou.de` |
| `HUBSPOT_TOKEN` / `HUBSPOT_CLIENT_SECRET` | – | Aus der HubSpot-App (Auth) |
| `HUBSPOT_PORTAL_ID` | – | `146305116`. Anfragen aus anderen Konten werden abgewiesen |
| `ADMIN_PASSWORT` | – | Für `/admin`, mindestens 12 Zeichen |
| `AUTO_ANLEGEN` | `true` | Unbekannte Nummern als Kontakt anlegen |
| `TIMELINE` | `tag` | `tag`, `nachricht` oder `aus` |
| `NAME_IN_NACHRICHT` | `false` | Namen fett vor gesendete Nachrichten setzen |
| `MAX_NACHRICHTEN_PRO_TAG` | `200` | Schutz gegen Massenversand |
| `MAX_MEDIEN_MB` | `25` | Größere Dateien werden nicht gespeichert |
| `VERLAUF_IMPORT` | `true` | Alten Verlauf beim Verbinden übernehmen |

## Grenzen

- Gruppenchats, Status-Meldungen und Kanäle werden ignoriert.
- Aus HubSpot gehen nur Texte raus. Dateien oder Fotos schickt ihr vom Telefon, sie erscheinen dann trotzdem in der Karte.
- Die Karte aktualisiert sich alle 8 Sekunden, solange sie offen ist.

## Datenschutz

Verlauf und Dateien liegen auf eurer NAS. In HubSpot stehen nur die Felder und die Tageszusammenfassung. Ergänzt eure Datenschutzerklärung um die Kommunikation per WhatsApp. Klärt außerdem kurz, ob ERGO Vorgaben zur Kundenkommunikation über WhatsApp macht.

## Entwicklung

```bash
cd server && npm install && npm test   # 57 Tests, ohne Verbindung nach außen
```

| Datei | Aufgabe |
| --- | --- |
| `server/src/whatsapp.js` | Verbindung zu WhatsApp (Baileys) |
| `server/src/pipeline.js` | Kontakt finden/anlegen, Felder, Chronik |
| `server/src/hubspot.js` | HubSpot-API |
| `server/src/app.js` | Schnittstelle für die Karte, Medien, Admin-Seite |
| `server/src/db.js` | SQLite-Speicher auf der NAS |
| `hubspot-app/src/app/cards/WhatsAppChat.jsx` | Die Karte in HubSpot |
