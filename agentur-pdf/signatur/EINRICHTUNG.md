# Ergoforyou Sign – Einrichtung auf der Synology DS1517+

Ergoforyou Sign ist der kleine Dienst, über den Kunden Dokumente **per Link online unterschreiben**.
Er läuft als Container auf eurem NAS. Alle Dokumente bleiben bei euch, und es entstehen keine laufenden Kosten.

- **Kundenseite** (Port 8480): Über den mitgelieferten Tunnel (HTTPS, ohne Portfreigabe) ist nur sie aus dem Internet erreichbar, und nur unter `/s/<Link>`.
- **Einrichtung und Schnittstelle für Ergoforyou PDF** (Port 8481): nur im Büronetz erreichbar, wird am Router **nicht** freigegeben.

Die Einrichtung dauert einmalig etwa 30–45 Minuten. Ihr braucht:
- Admin-Zugang zu DSM,
- ein kostenloses Tailscale-Konto (wird in Schritt 5 per Klick angelegt),
- einen HubSpot-Super-Admin.

---

## 1. Container Manager installieren
DSM → **Paket-Zentrum** → „Container Manager“ suchen → **Installieren**.
Dabei wird der gemeinsame Ordner `docker` angelegt.

## 2. Dateien auf das NAS kopieren
1. **File Station** → Ordner `docker` → **Erstellen → Ordner** → `ergoforyou-sign`.
2. Den Inhalt von `Ergoforyou-Sign-NAS.zip` dort hineinladen. Danach liegen in `docker/ergoforyou-sign` die Dateien `Dockerfile`, `docker-compose.yml`, `requirements.txt`, `EINRICHTUNG.md` und die Ordner `ergoforyou_sign` und `daten`.
3. **Wichtig:** Der Ordner `daten` muss existieren, denn Synology legt ihn nicht selbst an. Fehlt er, legt ihr ihn in File Station an (Erstellen → Ordner erstellen → `daten`). Sonst meldet der Start „Bind mount failed … daten does not exist“.

## 3. Container starten
1. **Container Manager** → **Projekt** → **Erstellen**.
2. Projektname `ergoforyou-sign`, Pfad `/docker/ergoforyou-sign`. Als Quelle wählt ihr „Vorhandene docker-compose.yml verwenden“.
3. **Weiter**. Das Web-Portal (Web Station) **nicht** einrichten. Dann **Fertig**.
4. Der erste Start baut den Container. Das dauert auf der DS1517+ etwa 3–5 Minuten. Danach steht das Projekt auf „Wird ausgeführt“.

## 4. Einrichtungsseite öffnen (Assistent mit Ampeln)
Im Büro-Browser `http://<NAS-IP>:8481` öffnen, z. B. `http://192.168.178.20:8481`.
Dort ein **Einrichtungskennwort** festlegen (mind. 8 Zeichen) und gut aufbewahren.

## 5. Von außen erreichbar machen (Tunnel – ohne Router)
Zum Projekt gehört ein zweiter Container `ergoforyou-sign-tunnel`. Er baut eine **ausgehende**, verschlüsselte Verbindung auf und gibt **nur die Kundenseite** frei.
- Am Router muss kein Port geöffnet werden.
- Es klappt auch bei Glasfaser- oder Kabelanschlüssen ohne eigene IPv4 (DS-Lite).
- Einrichtung, DSM und Dateien bleiben im Büronetz.

1. Auf der Einrichtungsseite unter **1 · Zugang für Kunden** auf **„Bei Tailscale anmelden“** klicken.
   - Mit Google, Microsoft oder E-Mail ein **kostenloses** Tailscale-Konto anlegen oder anmelden.
   - Das Gerät „ergoforyou-sign“ bestätigen.
2. Zurück zur Einrichtungsseite. Sie aktualisiert sich selbst.
   - Erscheint **„Jetzt freischalten“**: einmal klicken und in Tailscale **Funnel** (öffentlicher Zugang) aktivieren.
3. Die Ampel „Zugang für Kunden“ wird grün, und die Kundenadresse steht da, z. B. `https://ergoforyou-sign.tail1a2b.ts.net`. Der Dienst trägt sie selbst ein. Sie bleibt dauerhaft gleich, auch nach Neustarts.
4. Zur Probe am Handy **ohne WLAN** die Adresse mit `/gesundheit` am Ende öffnen. Dort muss „ok“ stehen.

**Alternative mit eigener Domain** (z. B. `sign.ergoforyou.de`) über DSM-Reverse-Proxy und Portfreigabe 443: Diese Adresse unter „Eigene Adresse verwenden“ eintragen. Der Tunnel wird dann nicht benutzt.

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

## Mehrere Unterzeichner
- In Ergoforyou PDF bekommt jedes Unterschriftsfeld eine **Rolle**, z. B. Kunde, Ehepartner oder Makler. Felder mit derselben Rolle unterschreibt dieselbe Person.
- Beim Senden gibt es je Rolle eine Person mit **eigenem Link** und optional eigenem Zugangscode.
- Mit „Der Reihe nach unterschreiben“ kann die zweite Person erst nach der ersten unterschreiben.
- Jede Person sieht die bereits gesetzten Unterschriften. Die fertige PDF mit allen Unterschriften und dem Prüfprotokoll gibt es, sobald alle unterschrieben haben, für jeden über seinen eigenen Link.
- **Update von 0.1.0:** Bereits verschickte Links laufen weiter. Einfach die Dateien ersetzen und das Projekt neu erstellen (siehe „Updates“).

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

## Pflege
- **Kaum Pflege nötig.** Beide Container starten nach einem NAS-Neustart von selbst.
- Der Dienst prüft alle 2 Minuten den Tunnel und holt nicht geklappte HubSpot-Ablagen alle 30 Minuten automatisch nach.
- Der HubSpot-Schlüssel einer Private App läuft nicht ab.

## Updates
1. Container Manager → Projekt `ergoforyou-sign` → **Stopp**.
2. File Station → in den Ordner `docker/ergoforyou-sign` wechseln → **Hochladen – Überschreiben** → die neue `Ergoforyou-Sign-NAS.zip` wählen.
3. Rechtsklick auf die ZIP → **Extrahieren → Hierher extrahieren** → bei Rückfrage **Überschreiben**. Danach die ZIP löschen. Den Ordner `daten` nie löschen.
4. Container Manager → Projekt → **Aktion → Erstellen**. Damit wird neu gebaut und gestartet, das dauert ein paar Minuten.

Auf der Einrichtungsseite steht oben die laufende Version.

## Datensicherung
Den Ordner `docker/ergoforyou-sign/daten` in **Hyper Backup** aufnehmen. Darin liegen:
- alle Aufträge (Original, Ergebnis, Verlauf),
- die Einstellungen,
- der Ordner `unterschrieben` mit den fertigen PDFs.

## Wenn etwas nicht klappt
- **„Bind mount failed … /daten does not exist“:** Den Ordner `daten` in `docker/ergoforyou-sign` anlegen, dann Projekt → Aktion → Starten.
- **Einrichtungsseite lädt nicht:** Läuft das Projekt im Container Manager? Unter Protokoll steht „Kundenseite auf Port 8480, Einrichtung auf Port 8481“.
- **Kunde kann den Link nicht öffnen:** Auf der Einrichtungsseite die Ampel „Zugang für Kunden“ prüfen. Ist sie gelb, dem angezeigten Schritt folgen. Steht dort „Tunnel-Container läuft nicht“: Container Manager → Projekt → Aktion → Erstellen.
- **Tunnel neu anmelden** (z. B. anderes Tailscale-Konto): Projekt stoppen, Ordner `daten/tunnel` leeren, Projekt wieder erstellen.
- **HubSpot-Fehler in der Übersicht:** Token abgelaufen oder ein Bereich fehlt. Dann neues Token eintragen und in der Übersicht auf „Erneut an HubSpot“ klicken.
