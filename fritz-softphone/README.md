# Fritz Browser-Telefon

Softphone als Chrome-Erweiterung für die FRITZ!Box, angelehnt an PhonerLite:

- **Mehrere Leitungen parallel** (1–6, Standard 3). Beim Wählen einer zweiten Nummer wird das laufende Gespräch automatisch gehalten.
- **Heranholen** eines klingelnden Anrufs per Knopf (`*09`, einstellbar)
- **Verbinden (Vermitteln mit Rückfrage):** Zwei Gesprächspartner werden miteinander verbunden, man selbst ist danach raus.
- **Weiterleiten (blind)** an eine beliebige Nummer
- **Dreierkonferenz:** alle Leitungen zusammenschalten und wieder trennen
- **Halten, Stumm, Tonwahl (DTMF), Wahlwiederholung**
- Schalter in der Kopfzeile wie bei PhonerLite: **⏳ Anklopfen**, **🥸 Anonym** (wählt `*31#` vor externe Nummern), **🔔 Nicht stören**
- **Kurzwahltasten** für beliebige Nummern und FRITZ!Box-Codes, z. B. `Annahme = *09`, `JK = **615`, `Umleitung Pia = *21*+4930…#`. Interne Nummern zeigen zusätzlich frei/besetzt an.
- **HD-Telefonie (G.722)**, wenn die Gegenstelle es kann, sonst G.711
- Sound-Optionen: Echo-Unterdrückung, Rauschunterdrückung, automatische Verstärkung
- **Telefonbuch:** suchen, anlegen, Import (FRITZ!Box-XML, CSV, vCard, auch PhonerLite-Listen im Format „Nummer;Name“ mit `@fritz.box`), Export als CSV. Namen erscheinen bei eingehenden Anrufen; ☆ macht einen Kontakt zur Kurzwahltaste.
- **Anrufliste** mit Auslösegrund wie im PhonerLite-Logbuch. Wird ein Anruf an einem anderen Telefon angenommen („Call completed elsewhere“), erscheint er als **„anderswo angenommen“** und zählt **nicht** als verpasst. Dazu Rückruf und „ins Telefonbuch übernehmen“.
- **Nebenstellen-Übersicht:** Man sieht, welches DECT-Telefon gerade telefoniert und welcher Anruf gerade klingelt. Mit einem Klick ruft man intern an (`**610` …).
- **Eigenes Fenster**, frei verschiebbar; die Größe wird gemerkt. Dazu ein **Mini-Fenster**, das immer im Vordergrund bleibt (Knopf ⧉).
- Desktop-Benachrichtigung mit **Annehmen/Ablehnen**
- Rechtsklick auf markierte Nummer oder `tel:`-Link → **Anrufen**
- Tastenkürzel **Alt+Shift+T** öffnet das Telefon.

Die Telefonie läuft unsichtbar im Hintergrund der Erweiterung. Das Telefonfenster kann man deshalb schließen oder verschieben, ohne dass ein Gespräch abbricht. Die Erweiterung bleibt auch ohne offenes Fenster angemeldet und klingelt bei Anrufen.

## Warum ein Gateway?

Die FRITZ!Box spricht SIP nur über UDP/TCP. Ein Browser kann aus Sicherheitsgründen nur WebRTC über WebSocket. Dazwischen sitzt deshalb ein kleines Gateway (Asterisk im Docker-Container), das z. B. auf dem NAS läuft:

```
Chrome-Erweiterung  ──WebSocket/WebRTC──▶  Gateway (NAS)  ──SIP/UDP──▶  FRITZ!Box  ──▶  Telefonnetz
                    ◀── Nebenstellen-Status (HTTP) ── Monitor (NAS) ◀── Callmonitor (Port 1012)
```

Für die FRITZ!Box ist das Gateway ein ganz normales IP-Telefon.

## Einrichtung

### 1. IP-Telefon in der FRITZ!Box anlegen

Am besten ein **neues** IP-Telefon anlegen und nicht die Zugangsdaten von PhonerLite (`jkpcphone`) mitbenutzen. So können beide parallel laufen, solange getestet wird.

1. *Telefonie → Telefoniegeräte → Neues Gerät einrichten*
2. *Telefon (mit und ohne Anrufbeantworter)* → *LAN/WLAN (IP-Telefon)*, Name z. B. „Browser-Telefon“.
3. Einen Benutzernamen (z. B. `browserphone`) und ein Kennwort vergeben und notieren.
4. Ausgehende Rufnummer und die Nummern auswählen, auf die das Telefon reagieren soll.

### 2. Callmonitor einschalten (für die Nebenstellen-Anzeige)

An einem Telefon, das an der FRITZ!Box hängt, einmal **`#96*5*`** wählen. Mit `#96*4*` lässt er sich wieder ausschalten.

### 3. Gateway auf dem NAS starten

Voraussetzung ist Docker. Bei Synology heißt das *Container Manager*. Den Ordner `gateway/` aufs NAS kopieren, dann:

```bash
cd gateway
cp .env.example .env      # Werte eintragen (FRITZ!Box-IP, Benutzer/Kennwort aus Schritt 1, eigenes Webphone-Passwort)
docker compose up -d --build
docker compose logs -f    # sollte "Registered" bzw. "Callmonitor verbunden" zeigen
```

Kontrolle: `docker exec fritz-gateway asterisk -rx "pjsip show registrations"` → Status `Registered`.

Auf Synology: *Container Manager → Projekt → Erstellen*, als Pfad den Ordner `gateway` wählen. Die `docker-compose.yml` wird dann erkannt.

Folgende Ports müssen im LAN erreichbar sein (Host-Netzwerk): `8088/tcp` (WebSocket), `8089/tcp` (Monitor), `5070/udp` (SIP zur FRITZ!Box), `10000–10200/udp` (Sprache).

### 4. Erweiterung in Chrome installieren

1. `chrome://extensions` öffnen und rechts oben den **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** → den Ordner `extension/` auswählen.
3. Das Telefonfenster öffnet sich. Unter ⚙ Folgendes eintragen:
   - IP-Adresse des NAS, z. B. `192.168.10.20` (Gateway- und Monitor-Adresse werden daraus automatisch gebildet)
   - Benutzername/Passwort: `WEBPHONE_USER` / `WEBPHONE_PASSWORD` aus der `.env`
   - Nebenstellen, je Zeile `Name = interne Nummer`, z. B. `Werkstatt = **611`
4. Beim ersten Mal das **Mikrofon freigeben**. Die Erweiterung öffnet dafür einen Tab.

Die Erweiterung kann auf mehreren PCs mit denselben Zugangsdaten laufen. Dann klingeln alle.

## Bedienung – typischer Ablauf

**Kunde heranholen und an den Abschleppdienst übergeben:**

1. Es klingelt irgendwo. Auf **⤵ Heranholen** klicken. Der Kunde ist jetzt auf **L1**.
2. Im Suchfeld „Abschlepp…“ tippen und Enter drücken. L1 wird automatisch gehalten, der Kunde hört Wartemusik, und **L2** wählt.
3. Mit dem Abschleppdienst sprechen. Dann wählen:
   - **⇄ L1 mit L2 verbinden:** Kunde und Abschleppdienst sprechen direkt miteinander, man selbst ist raus.
   - oder **👥 Konferenz:** alle drei sprechen zusammen. **✂ Konferenz trennen** macht wieder zwei Gespräche daraus.
   - oder **Auflegen** auf L2 und mit **▶ Fortsetzen** zurück zum Kunden.

**Direkt weiterleiten ohne Rückfrage:** Auf der Leitung **↪** drücken und eine Nummer oder einen Namen eingeben.

**Tonwahl** (z. B. Sprachmenüs): Auf der Leitung **⌨** drücken. Die Wähltastatur sendet dann Töne.

## Grenzen / gut zu wissen

- Wie viele Gespräche gleichzeitig nach außen gehen, begrenzt der Telefonanschluss bzw. die FRITZ!Box, nicht die Erweiterung.
- Der FRITZ!Box-Callmonitor meldet nur **externe** Gespräche. Interne Gespräche zwischen zwei DECT-Telefonen zeigt er nicht als „besetzt“ an.
- Die Konferenz wird im Browser gemischt. Fällt der PC aus, endet die Konferenz. Beim „Verbinden“ übernimmt dagegen das Gateway, und das Gespräch läuft ohne PC weiter.
- Im LAN reicht `ws://`; die Sprache ist per WebRTC (DTLS-SRTP) trotzdem verschlüsselt. Von unterwegs nur über VPN zum Büro nutzen und die Ports **nicht** ins Internet freigeben.
- Die Codes `*09` (Heranholen) und `*31#` (Rufnummer unterdrücken) sind in den Einstellungen änderbar. Falls `*09` an eurer FRITZ!Box anders lautet, lässt er sich in den Einstellungen ändern.

## Aufbau

```
extension/            Chrome-Erweiterung (Manifest V3)
  background.js       Fenster, Benachrichtigungen, Kontextmenü, Anrufliste
  engine.js           Telefonie (JsSIP), Leitungen, Vermitteln, Konferenz-Mischung – läuft im Offscreen-Dokument
  app.html/.js/.css   Oberfläche (Fenster + Mini-Fenster)
  import.js           Telefonbuch-Import/-Export
  lib/jssip.min.js    JsSIP 3.13.8 (MIT-Lizenz)
gateway/
  Dockerfile, docker-compose.yml, .env.example
  config/             Asterisk-Konfiguration (Platzhalter werden beim Start aus .env gefüllt)
  monitor/            Nebenstellen-Monitor (liest den FRITZ!Box-Callmonitor)
```
