# Ergoforyou Sign – Einrichtung auf der Synology DS1517+

Ergoforyou Sign ist der kleine Dienst, über den Kunden Dokumente **per Link online unterschreiben**.
Er läuft als Container auf eurem NAS. Alle Dokumente bleiben bei euch, und es entstehen keine laufenden Kosten.

- **Kundenseite** (Port 8480): Über den DSM-Reverse-Proxy und HTTPS ist nur sie aus dem Internet erreichbar, und nur unter `/s/<Link>`.
- **Einrichtung und Schnittstelle für Ergoforyou PDF** (Port 8481): nur im Büronetz erreichbar, wird am Router **nicht** freigegeben.

Die Einrichtung dauert einmalig etwa 30–45 Minuten. Ihr braucht:
- Admin-Zugang zu DSM,
- Zugang zum Router (z. B. FritzBox),
- einen HubSpot-Super-Admin.

---

## 1. Container Manager installieren
DSM → **Paket-Zentrum** → „Container Manager“ suchen → **Installieren**.
Dabei wird der gemeinsame Ordner `docker` angelegt.

## 2. Dateien auf das NAS kopieren
1. **File Station** → Ordner `docker` → **Erstellen → Ordner** → `ergoforyou-sign`.
2. Den Inhalt von `Ergoforyou-Sign-NAS.zip` dort hineinladen. Danach liegen in `docker/ergoforyou-sign` die Dateien `Dockerfile`, `docker-compose.yml`, `requirements.txt`, `EINRICHTUNG.md` und der Ordner `ergoforyou_sign`.

## 3. Container starten
1. **Container Manager** → **Projekt** → **Erstellen**.
2. Projektname `ergoforyou-sign`, Pfad `/docker/ergoforyou-sign`. Als Quelle wählt ihr „Vorhandene docker-compose.yml verwenden“.
3. **Weiter**. Das Web-Portal (Web Station) **nicht** einrichten. Dann **Fertig**.
4. Der erste Start baut den Container. Das dauert auf der DS1517+ etwa 3–5 Minuten. Danach steht das Projekt auf „Wird ausgeführt“.

## 4. Einrichtungsseite öffnen
Im Büro-Browser `http://<NAS-IP>:8481` öffnen, z. B. `http://192.168.178.20:8481`.
Dort ein **Einrichtungskennwort** festlegen (mind. 8 Zeichen) und gut aufbewahren.

## 5. Von außen erreichbar machen (HTTPS)
1. **Adresse anlegen:** Systemsteuerung → **Externer Zugriff** → **DDNS** → **Hinzufügen**.
   - Dienstanbieter „Synology“, Hostname z. B. `ergoforyou-sign.synology.me`.
   - Haken bei „Zertifikat von Let's Encrypt anfordern“ setzen, dann OK.
2. **Reverse-Proxy:** Systemsteuerung → **Anmeldeportal** → **Erweitert** → **Reverse Proxy** → **Erstellen**.
   - Beschreibung: `Ergoforyou Sign`
   - Quelle: Protokoll **HTTPS**, Hostname `ergoforyou-sign.synology.me`, Port **443**, HSTS aktivieren
   - Ziel: Protokoll **HTTP**, Hostname `localhost`, Port **8480**
   - Reiter **Benutzerdefinierte Kopfzeile** → Erstellen → **Leer**, zwei Einträge:
     - `X-Real-IP` = `$remote_addr`
     - `X-Forwarded-For` = `$proxy_add_x_forwarded_for`

     Nur damit steht die echte IP des Kunden im Prüfprotokoll.
3. **Zertifikat zuordnen:** Systemsteuerung → **Sicherheit** → **Zertifikat** → **Einstellungen**. Beim Dienst `ergoforyou-sign.synology.me` das Let's-Encrypt-Zertifikat auswählen.
4. **Router:** Portfreigabe **TCP 443 → NAS-IP, Port 443**.
   Bei der FritzBox: Internet → Freigaben → Portfreigaben → Gerät NAS → Neue Freigabe → HTTPS-Server.
   Die Ports **8481, 5000 und 5001 NICHT freigeben.**
5. Ist die **DSM-Firewall** aktiv, dort Port 443 erlauben und Port 8481 nur für das lokale Netz.
6. Auf der Einrichtungsseite unter **1 · Öffentliche Adresse** `https://ergoforyou-sign.synology.me` eintragen, dann Speichern und „Erreichbarkeit testen“.
   Zur Sicherheit auch am Handy **ohne WLAN** `https://ergoforyou-sign.synology.me/gesundheit` öffnen. Dort muss „ok“ stehen.

## 6. HubSpot verbinden
1. In HubSpot: **Einstellungen (Zahnrad)** → **Integrationen** → **Private Apps**. In neueren Oberflächen heißt das „Entwicklung → Legacy-Apps → Private App“.
2. **Private App erstellen**, Name `Ergoforyou Sign`.
3. Reiter **Bereiche (Scopes)**, diese fünf anhaken:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
   - `files`
4. **App erstellen** → **Zugriffstoken anzeigen** → kopieren. Das Token beginnt mit `pat-eu1-…`.
5. Auf der Einrichtungsseite unter **2 · HubSpot** einfügen und auf **Speichern & prüfen** klicken.

## 7. Ergoforyou PDF verbinden
1. Auf der Einrichtungsseite unter **3 · Ergoforyou PDF verbinden** auf **Code kopieren** klicken.
2. In Ergoforyou PDF oben rechts auf **Beta MK I** klicken (Einstellungen & Einrichtung) → **Online-Unterschrift** → Code einfügen → **Verbinden**.

Ist in Ergoforyou PDF der **gemeinsame Einstellungsordner** auf dem NAS eingetragen, reicht das an **einem** PC. Alle anderen sind dann automatisch verbunden.

## 8. Ausprobieren
1. Ein Test-PDF öffnen.
2. **Schützen → Unterschriftsfeld** aufziehen.
3. **Zur Unterschrift senden**: Kontakt „Max Muster“ (Testkontakt), dann **Link erstellen**.
4. Den Link am Handy öffnen, unterschreiben und die Kopie herunterladen.
5. In HubSpot am Kontakt erscheinen zwei Notizen: „Zur Unterschrift gesendet“ und „✔ Unterschrieben“, letztere mit der PDF.
6. Auf dem NAS liegt die PDF unter `docker/ergoforyou-sign/daten/unterschrieben/`.

---

## Was der Kunde sieht
- Das Dokument zum Durchblättern, mit gelb markierten Feldern.
- Unterschreiben per Finger oder Maus (oder Namen tippen), den Haken „gelesen“ und dann **Verbindlich unterschreiben**.
- Danach sofort **Kopie herunterladen** (30 Tage lang über denselben Link).

## Sicherheit
- Jeder Link ist ein zufälliger, nicht erratbarer Schlüssel (256 Bit). Er ist nur bis zum Ablaufdatum gültig und kann nur einmal unterschrieben werden.
- Optional gibt es einen **Zugangscode**. Nach 5 Fehlversuchen ist der Link gesperrt, das Büro kann ihn in der Übersicht wieder freigeben.
- Die Prüfsumme (SHA-256) des Originals wird vor der Unterschrift geprüft.
- Die fertige PDF enthält eine **Prüfprotokoll-Seite**: Zeitpunkte, IP-Adresse, Gerät, Prüfsumme und Zugangsart. Das Protokoll ist zusätzlich als `pruefprotokoll.json` eingebettet.
- Ein Zertifikatssiegel (PAdES) und eine SMS-TAN sind für später vorgesehen und bewusst noch nicht enthalten.
- Rechtlich ist das eine **einfache elektronische Signatur mit Protokoll**. Sie reicht für Textform und formfreie Erklärungen (z. B. Maklervertrag, Vollmacht, Beratungsprotokoll), aber **nicht** dort, wo das Gesetz die Schriftform verlangt (§ 126 BGB). Dafür braucht man eine QES.

## Updates
1. Die neuen Dateien in `docker/ergoforyou-sign` überschreiben. Der Ordner `daten` bleibt unberührt.
2. Container Manager → Projekt `ergoforyou-sign` → **Aktion → Erstellen**. Damit wird neu gebaut und gestartet.

## Datensicherung
Den Ordner `docker/ergoforyou-sign/daten` in **Hyper Backup** aufnehmen. Darin liegen:
- alle Aufträge (Original, Ergebnis, Verlauf),
- die Einstellungen,
- der Ordner `unterschrieben` mit den fertigen PDFs.

## Wenn etwas nicht klappt
- **Einrichtungsseite lädt nicht:** Läuft das Projekt im Container Manager? Unter Protokoll steht „Kundenseite auf Port 8480, Einrichtung auf Port 8481“.
- **Kunde kann den Link nicht öffnen:** Portfreigabe 443, Reverse-Proxy-Eintrag und Zertifikat prüfen. Testen mit `…/gesundheit` am Handy ohne WLAN.
- **HubSpot-Fehler in der Übersicht:** Token abgelaufen oder ein Bereich fehlt. Dann neues Token eintragen und in der Übersicht auf „Erneut an HubSpot“ klicken.
