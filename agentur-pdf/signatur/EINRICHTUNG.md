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

## 6. HubSpot verbinden (Service-Schlüssel)
1. In HubSpot links das Symbol **Entwicklung** (`</>`) → **Schlüssel → Service-Schlüssel** → **Service-Schlüssel erstellen**.
2. Name `Ergoforyou Sign` → **Neuen Bereich hinzufügen** und diese **8 Bereiche** anhaken:
   - `crm.objects.contacts.read`, `crm.objects.contacts.write`
   - `crm.objects.deals.read`, `crm.objects.deals.write`
   - `files.read`, `files.write`
   - `crm.schemas.contacts.write`, `crm.schemas.deals.write`
3. **Erstellen** → bei „Service-Schlüssel“ **Kopieren**.
4. Einrichtungsseite → **2 · HubSpot verbinden** → einfügen → **Speichern & prüfen**. Die Ampel wird grün.

**Was dann in HubSpot passiert:**
- Am Kontakt (und am Deal) erscheinen die Notizen **„Zur Unterschrift gesendet“** und **„✔ Unterschrieben“**. Die zweite hat die fertige PDF als Anhang, die PDF liegt zusätzlich unter Dateien im Ordner „Ergoforyou Sign“.
- Der Dienst legt selbst eine Feldgruppe **„Ergoforyou Sign“** an und hält diese Felder aktuell:
  - **Unterschrift Status** (Versendet / Geöffnet / Teilweise unterschrieben / Unterschrieben / Abgelaufen / Zurückgezogen)
  - **Unterschrift Dokument**
  - **Unterschrift gesendet am**
  - **Unterschrieben am**
  - **Auftragsnummer**

  Damit lassen sich Listen filtern („noch nicht unterschrieben“) und Workflows bauen, z. B. eine Erinnerung nach 3 Tagen.
- **Start direkt aus HubSpot:** siehe Schritt 7 – die Karte „Ergoforyou Sign“ in der rechten Seitenleiste.

## 7. HubSpot-Karte (rechte Seitenleiste, wie PandaDoc/Dropbox Sign)
Danach hat jeder Kontakt und jeder Deal rechts die Karte **„Ergoforyou Sign“**:
- großer Knopf **„✍ Neue Unterschrift anfordern“** → Fenster in HubSpot: PDF hineinziehen **oder** einen PDF-Anhang des Datensatzes wählen → Unterschriftsfelder setzen (✍ Unterschrift / 📅 Datum / Aa Name) → Personen (aus HubSpot vorbelegt) → **Zur Unterschrift senden** → Links kopieren oder per E-Mail schicken.
- darunter die letzten Anfragen mit Status, **Link kopieren**, **Details** (Links, Verlauf, Zurückziehen) und **PDF öffnen**.
- Niemand braucht dafür Ergoforyou PDF oder eine Chrome-Erweiterung – nur HubSpot.

Einmalig einrichten (ca. 10 Minuten, nur eine Person):
1. **Persönlicher Zugriffsschlüssel:** in HubSpot <https://app-eu1.hubspot.com/l/personal-access-key> öffnen → **Persönlichen Zugriffsschlüssel generieren** (Bereich **Developer Projects** anhaken) → **Kopieren**.
2. **Bei GitHub hinterlegen:** im Projekt `ergoforyou/nas-suche` → **Settings → Secrets and variables → Actions → New repository secret** → Name `HUBSPOT_PERSONAL_ACCESS_KEY`, Wert einfügen → **Add secret**.
3. **Karte hochladen:** **Actions → „HubSpot-Karte“ → Run workflow** → Branch `claude/happy-cerf-jpm98y`, bei *Öffentliche Adresse* die Adresse aus der Einrichtungsseite (Schritt 1, z. B. `https://ergoforyou-sign.tail1234.ts.net`) → **Run workflow**. Nach 2–3 Minuten ist der Lauf grün; die App „Ergoforyou Sign“ ist dann im HubSpot-Konto installiert.
4. **Client-Secret auf das NAS:** in HubSpot **Entwicklung (`</>`) → Projekte → ergoforyou-sign → Ergoforyou Sign** → Reiter **Authentifizierung** → **Client-Secret** anzeigen und kopieren → Einrichtungsseite **3 · HubSpot-Karte** → einfügen → **Speichern**.
5. **Karte einblenden:** einen Kontakt öffnen → oben **Datensatz anpassen** (bzw. Ansicht bearbeiten) → rechte Seitenleiste → **Karte hinzufügen → App-Karten → Ergoforyou Sign** → nach oben ziehen → **Speichern**. Dasselbe einmal bei einem Deal. Das gilt dann für alle Kollegen.
6. Kontakt neu laden – die Ampel „HubSpot-Karte“ auf der Einrichtungsseite wird grün.

Ändert sich die Adresse des NAS-Dienstes (z. B. Umzug auf die DS718+ mit anderem Tailscale-Namen), Schritt 3 einfach mit der neuen Adresse wiederholen.

**Sicherheit:** Die Karte ruft das NAS über HubSpot auf; HubSpot unterschreibt jede Anfrage mit dem Client-Secret der App (Signatur v3, max. 5 Minuten alt). Ohne gültige Unterschrift liefert das NAS nichts. Das Fenster bekommt daraus einen Schlüssel, der 8 Stunden und nur für diesen einen Kontakt/Deal gilt.

## 8. Ergoforyou PDF verbinden (optional)
1. Auf der Einrichtungsseite unter **4 · Ergoforyou PDF verbinden** auf **Code kopieren** klicken.
2. In Ergoforyou PDF oben rechts **Beta MK I** → **Online-Unterschrift** (oder direkt **Schützen → Zur Unterschrift senden**) → Code einfügen → **Verbinden**.

Ist in Ergoforyou PDF der **gemeinsame Einstellungsordner** auf dem NAS eingetragen, reicht das an **einem** PC. Alle anderen sind dann automatisch verbunden.

**Von zu Hause oder unterwegs:**
- Auf dem PC oder Laptop die **Tailscale-App** installieren und mit demselben Konto anmelden wie in Schritt 5.
- Ergoforyou PDF erreicht das NAS dann automatisch über `https://ergoforyou-sign.<name>.ts.net:8481`. Diese Adresse ist **nur für eure eigenen Tailscale-Geräte** erreichbar, nicht öffentlich.
- Im Büro wird weiterhin direkt die Büro-Adresse genutzt. Umstellen muss man nichts.
- Dafür den Verbindungscode einmal **neu kopieren und eintragen**, nachdem der Tunnel eingerichtet ist. Erst dann enthält der Code beide Adressen.

## 9. Ausprobieren
1. In HubSpot einen Testkontakt „Max Muster“ öffnen → Karte **Ergoforyou Sign** → **Neue Unterschrift anfordern**.
2. Test-PDF hineinziehen, **✍ Unterschrift** wählen und auf die Stelle im Dokument klicken.
3. **Zur Unterschrift senden** → **Link kopieren**. (Aus Ergoforyou PDF geht es genauso: **Schützen → Unterschriftsfeld**, dann **Zur Unterschrift senden**.)
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
- **Karte zeigt „nicht erreichbar“:** NAS oder Tunnel aus? Ampel „Zugang für Kunden“ prüfen. Stimmt die Adresse aus Schritt 7.3 noch mit der auf der Einrichtungsseite überein?
- **Karte zeigt „Client-Secret“ oder Ampel „HubSpot-Karte“ rot:** Client-Secret aus Schritt 7.4 neu kopieren und speichern.
- **Karte fehlt in der Kartenauswahl:** War der Lauf „HubSpot-Karte“ grün? In HubSpot unter Entwicklung → Projekte → ergoforyou-sign prüfen, ob die App installiert ist (sonst dort **Installieren** klicken).
- **HubSpot-Fehler in der Übersicht:** Token abgelaufen oder ein Bereich fehlt. Dann neues Token eintragen und in der Übersicht auf „Erneut an HubSpot“ klicken.
