# KI-Assistent

Ein schlankes Desktop-Chatfenster mit animiertem Avatar, das mit einem **lokalen Sprachmodell aus LM Studio**
spricht. Spracherkennung und Sprachausgabe laufen ebenfalls lokal auf dem eigenen Rechner.

| Baustein | Technik | lokal? |
|---|---|---|
| Sprachmodell | LM Studio (OpenAI-kompatibler Server, Port 1234) | ✔ |
| Spracherkennung | Whisper (tiny / base / small) über transformers.js, WebGPU oder CPU | ✔ |
| Sprachausgabe | Piper (neuronale Stimmen, z. B. „Thorsten“) oder Systemstimmen | ✔ |
| Avatar | eigenes Bild, animiert: Atmen, Wiegen, Blinzeln, Mundbewegung zur Stimme | ✔ |

> Beim **ersten** Benutzen werden die Sprachmodelle einmalig von Hugging Face geladen (ca. 80 MB Whisper +
> 60 MB Stimme). Danach funktioniert alles offline. Unter ⚙ → Sprache → „Sprachmodelle jetzt herunterladen“
> lässt sich das vorab erledigen.

## Benutzen

1. **LM Studio** installieren, ein Modell laden (z. B. Qwen3 8B, Llama 3.1 8B, Mistral) und unter
   **Developer → Start Server** den lokalen Server starten.
2. `KI-Assistent-…-Setup.exe` (Installer, legt eine Desktop-Verknüpfung an) oder `KI-Assistent-…-portable.exe`
   (ohne Installation) starten.
3. Lostippen oder auf 🎤 klicken (bzw. **Strg + Leertaste**) und sprechen. Nach einer kurzen Sprechpause
   wird automatisch abgeschickt.

### Bedienung

- **🎤** – einmal zuhören (oder **Strg + Leertaste**; systemweit **Strg + Alt + Leertaste**). Im
  **Freihand-Modus** (⚙ → Sprache) hört der Assistent ständig zu, sobald er fertig gesprochen hat.
- **■ / Esc** – Antwort und Sprachausgabe abbrechen.
- **🧍** – Figur frei auf dem Desktop. Figur anklicken = Rahmen: ziehen verschiebt, Ecken (oder Mausrad)
  ändern die Größe; am blauen Griff **„✥ ziehen“** verschieben – auch auf einen anderen Bildschirm. Doppelklick = sprechen, Rechtsklick = Menü (Chat öffnen,
  „Auf Bildschirm verschieben“ …). Das Chatfenster kann dann
  geschlossen werden. Auch im Chatfenster lässt sich die Figur so verschieben und skalieren.
- **📄** – Ausgabefenster: Antworten groß und formatiert wie in LM Studio (Überschriften, Listen,
  Tabellen, Code mit Kopier-Knopf), mit ◀ ▶ durch frühere Antworten blättern. Knöpfe **PDF**, **Word**
  und **Text** speichern die Antwort als fertiges Dokument (A4-PDF mit Seitenzahlen, .docx mit echten
  Überschriften, Listen und Tabellen, Markdown) – komplett lokal erzeugt.
- **🗨＋** – Neuer Chat (auch Strg+N, „Neuer Chat“ sagen oder Rechtsklick auf die Figur): leert nur den
  Gesprächsverlauf; Persona, Gedächtnis, Avatar und Stimme bleiben. Direkt danach per „Rückgängig“ zurückholbar.
- **📌** – Chatfenster immer im Vordergrund.
- **📞** – Live-Gespräch: einfach losreden, die App hört dauerhaft zu. Spricht man dazwischen, verstummt der
  Avatar und hört zu. Reaktionszeit und Dazwischenreden unter ⚙ → Sprache. Am besten mit Headset.
- **⏻** – KI-Assistent komplett beenden (auch im Rechtsklick-Menü der Figur). ✕ schließt nur das Fenster;
  ist die Figur frei auf dem Desktop, läuft der Assistent dann weiter.

### 3D-VTuber (VRM)

Unter ⚙ → Avatar → **„VRM-Datei laden …“** eine 3D-Figur im VRM-Format laden. Sie bewegt sich live: Kopf und Blick,
Lippen zur Stimme, Atmen, Blinzeln, Nachdenken, Zuhören. Kostenlos erstellen mit **VRoid Studio** (vroid.com/Steam) →
„Exportieren“ → .vrm. Rahmen, Verschieben, Größe und die freie Figur auf dem Desktop funktionieren wie bei Bildern.
**Drehen:** Regler unter ⚙ → Avatar oder Umschalttaste halten und die Figur mit der Maus seitlich ziehen.
**Bildausschnitt:** Kopf & Schultern, Brustbild oder Ganzkörper.

**Figur aus eigenen Bildern:** ⚙ → Avatar → **„Aus Bildern erstellen …“** baut die 3D-Figur direkt aus einem
Ganzkörperbild (frontal, stehend). Optional machen eine **Rückansicht** (eigene Rückseite) und eine **Seitenansicht**
(echtes Körperprofil) die Figur deutlich besser; ein **Turnaround-Blatt** mit Front/Seite/Rücken nebeneinander wird
automatisch aufgeteilt. Gelenkpunkte und die Kästen um Augen und Mund lassen sich vor dem Erstellen verschieben. Die
Figur bekommt Blinzeln, Mundformen (A/I/U/E/O) und ein Lächeln; „Als .vrm speichern“ exportiert sie z. B. für VSeeFace.
Alles läuft lokal – Hintergründe werden wie beim Avatar-Bild freigestellt (Transparenz, einfarbig oder KI).
Bei **Fotos** erkennt die App Gesicht und Körper (MediaPipe): Gelenke sitzen genau, beim Blinzeln gleitet das eigene
Lid über das Auge und beim Sprechen öffnen sich die Lippen (statt aufgemalter Formen). Halbkörperbilder werden als
Brustbild gebaut, Arme vor dem Körper bleiben am Oberkörper. Rückansichten erkennt die App und legt sie automatisch
ins Feld „Rückansicht“; ohne erkanntes Gesicht gibt es keine Mimik. Erstellte Figuren können außerdem den Blick bewegen
(die Iris folgt dem Betrachter) und zeigen die Stimmung der Antwort über Augenbrauen, Lider und Mundwinkel
(überrascht, traurig, verärgert, fröhlich). Wird ein Gesicht nicht gefunden, lässt es sich mit **„Gesicht markieren“**
von Hand einrahmen; mit **„Freistellung bearbeiten“** lässt sich die Freistellung per Pinsel korrigieren (hinzufügen
holt Bildteile aus dem Original zurück, entfernen macht sie durchsichtig). Ohne Rückansicht bekommt die Figur eine neutrale Rückseite (Hinterkopf in Haarfarbe, Kleidung
ohne Details) – drehen lässt sie sich wie jede VRM-Figur über den Regler oder Umschalttaste + Ziehen.

### 2D-Figur aus mehreren Bildern

Avatar-Bild plus ② dasselbe Bild mit offenem Mund und ③ mit geschlossenen Augen (gleicher Bildausschnitt). Die
Freistellung des Avatar-Bilds wird automatisch übernommen. Für Bewegung im Leerlauf zusätzlich Posen oder kurze Videos.

**Lebendiges Gesicht (automatisch):** Beim Avatar-Bild erkennt die App einmalig das Gesicht (MediaPipe, lokal). Danach
blinzelt die Figur mit echten Lidern, macht kleine Blicksprünge, hebt beim Nachdenken/Zuhören die Brauen, lächelt leicht
und formt den Mund passend zum Laut (breit bei e/i, rund bei o/u – aus dem Klangspektrum der Stimme).

**Leicht drehen (2,5D):** Eine KI schätzt einmalig die Tiefe des Bildes; danach lässt sich die Bild-Figur per Regler
oder Umschalttaste + Ziehen bis etwa ±20° drehen und auf Wunsch im Leerlauf leicht mitdrehen.

**Bewegungsbilder (Morphing):** bis zu 4 weitere Bilder derselben Figur mit kleinen Unterschieden (Kopf geneigt,
Blick zur Seite, Lächeln). Die App berechnet den optischen Fluss zwischen den Bildern und verformt die Figur im
Leerlauf fließend dazwischen – deutlich natürlicher als Überblenden. Zum Sprechen geht es zurück zum Grundbild.

### Eigene Persona & Avatar

Systemprompts aus **LM Studio** (gespeicherte Presets und die Systemprompts deiner Chats) lassen sich unter
⚙ → Persona in die aktuelle Persona übernehmen oder direkt als neue Persona anlegen.

Unter ⚙ → **Persona**: Name, Charakter/Rolle (Systemprompt), Begrüßung, **Antwortsprache** (Deutsch/Englisch)
und **Antwortstil**:
- *Ausführlich wie in LM Studio* – mit Formatierung; die ersten Sätze sind zum Vorlesen gedacht.
- *Gesprächig & kurz* – optimiert fürs Vorlesen.
- *Nur mein Systemprompt* – keinerlei Zusatzanweisungen der App.

Personas lassen sich als `.persona.json` (inklusive Bild) exportieren und weitergeben.

Unter ⚙ → **Avatar**:

1. **Bild hochladen**, z. B. ein Foto vor einer weißen Wand.
2. **✂ Hintergrund entfernen** stellt die Figur frei (Toleranz bei Bedarf anpassen). PNGs mit
   transparentem Hintergrund funktionieren direkt.
3. **🖌 Lippen ausmalen**: Ober- und Unterlippe mit der Maus anmalen. Beim Sprechen öffnen sich dann die
   echten Lippen aus dem Bild (Oberlippe leicht hoch, Unterlippe runter), statt dass ein Mund aufgesetzt wird.
   Alternativ nur die Mundmitte anklicken.
4. Beide **Augen** anklicken (für das Blinzeln), dann **▶ Testsprechen**.

### Posen

Unter ⚙ → Avatar → **Posen** weitere Bilder derselben Figur hinzufügen (z. B. Hand gehoben, Kinn aufgestützt),
möglichst mit gleichem Bildausschnitt. Für jede Pose festlegen, wann sie erscheint: beim Sprechen, Nachdenken,
Zuhören oder ab und zu in Ruhe. Die App blendet weich über; Mund, Blinzeln und Kopfbewegung laufen in jeder Pose
weiter. Mund und Augen werden vom Grundbild übernommen und können pro Pose (✎) korrigiert werden.

**Anlässe** (je Pose wählbar, mehrere Posen je Anlass wechseln sich ab): sprechen (auch je Stimmung), Anfang einer
Antwort, nachdenken, **warten** (längere Antwort, Kalender), zuhören (auch aufmerksam bzw. je Stimmung), Ruhe,
**gelangweilt** (nach 5 min), **begrüßen**, **verabschieden**, **verstanden**, **geschafft**, **Entschuldigung**,
**Erinnerung**. Mit ▶ neben einer Pose lässt sich ihr Anlass ausprobieren. Dazu (⚙ → Avatar → Lebendigkeit):
Tageszeit, Begrüßung beim Start, Status-Leuchte, Sprechblase (z. B. im Büro ohne Ton).

### Bereiche und Firmenwissen (Beta)

- **Dienstlich / Privat** (💼/🏠 oben bzw. ⚙ → Wissen): getrennte Personas, Chats, Gedächtnis, API-Schlüssel und
  Google-Verbindung; beide nur auf diesem Gerät. Wechsel startet die App neu.
- **Firmenwissen** (nur Dienstlich): PDF, Word, Excel, PowerPoint, OpenDocument-Text und Textdateien aufnehmen. Sie werden
  lokal in Abschnitte zerlegt und durchsucht; zu einer Frage gehen nur die passendsten Abschnitte (höchstens 5) an den
  KI-Anbieter, unter der Antwort steht, welche Dokumente mitgegeben wurden. Keine Kundendaten aufnehmen.

### Büro (PC, Beta)

- **Strg+Alt+K** – markierten Text in jeder App bearbeiten: zusammenfassen, Antwort entwerfen (mit Firmenwissen),
  höflicher, übersetzen, korrigieren oder eigene Schnellbefehle; „Ersetzen“ fügt das Ergebnis direkt ein.
- **Strg+Alt+D** – Diktat in jede App: sprechen, nach einer Pause wird der Text am Cursor eingefügt (auf Wunsch geglättet).
- **Erinnerungen** als Windows-Benachrichtigung, **Tagesbriefing** einmal am Tag (Termine, Aufgaben, Wetter am Ort).
- **Nicht stören** bei Präsentation/Vollbild: Figur ausgeblendet, keine Sprachausgabe, Erinnerungen still.
- **Schnellbefehle** (⚙ → Büro): eigene Knöpfe über dem Eingabefeld, `{text}` = Text im Eingabefeld/Markierung.

### Privat-Funktionen auf dem Handy (Beta, nur Bereich Privat)

- **Echtzeit-Gespräch** (OpenAI Realtime): Antworten in ca. ½ s, Dazwischenreden; kostet mehr pro Minute.
- **Natürliches Gespräch** (Beta 89): „Stopp“, „Moment“, „weiter“ erledigt die App sofort selbst (ohne KI); kurze
  Äußerungen werden schneller ausgewertet; mit Headset reicht leiseres Dazwischenreden; „Nein, ich meinte …“ korrigiert;
  im Gespräch kurze, dialogische Antworten; 📝 lange drücken = Erzählen (die Figur hört zu und antwortet am Ende).
- **Aktivierungswort** frei wählbar (Standard: Name der Persona), auf dem Handy erkannt.
- **Diktat**: lange Gedanken am Stück sprechen, abschnittsweise mitgeschrieben; „fertig“ beendet, „als Notiz“ legt ab.
- **Second Brain**: Notizen in Ordnern (Eingang, Projekte, Themen, Personen, Tagebuch, Archiv), offene Punkte,
  Wochenrückblick, Export/Import als `.kibrain`-Datei (z. B. zum PC). Die Figur führt zusätzlich ein **eigenes Notizbuch**.
- **Für später** (Zwischenspeicher): „Für später: …“, im Widget oder per App-Verknüpfung nebenbei notieren, ohne dass die
  Figur antwortet; später gemeinsam durchgehen.
- **Vorhaben**: Aufgaben über mehrere Tage („Such mir bis Freitag Wallbox-Angebote heraus“) – die Figur arbeitet Schritt
  für Schritt daran (mit Internetsuche) und erzählt, was sie gefunden hat; **Tagesbegleiter** mit den drei wichtigsten
  Dingen des Tages.
- **Erinnerungen und Timer** auch ohne Google; bleiben stehen, bis sie bestätigt sind; Abgleich mit dem PC/der NAS.
- **Begleiter bei geschlossener App** (Beta 80): Morgen- und Feierabendrunde als Benachrichtigung zur gewählten Uhrzeit
  (Antippen startet die Runde); **Nachtschicht** – nachts zwischen 1 und 6 Uhr, nur beim Laden im WLAN, arbeitet die Figur
  einen Schritt an einem Vorhaben weiter (der Claude-Schlüssel bleibt im verschlüsselten Speicher des Geräts);
  **Orte und Situationen** (Beta 87): Orte per Adresse, Kontakt-Adresse, WLAN (am genauesten für Zuhause/Büro),
  Auto-Bluetooth oder „hier“ (wartet auf genaues GPS); Erinnerungen beim Ankommen oder Verlassen, einmal oder jedes Mal,
  mit Zeitfenster/werktags; Ortsgruppen („Supermarkt“); Notizen mit Ort erscheinen dort; „Was steht hier an?“;
  Feierabendrunde beim Heimkommen, Verkehrslage beim Verlassen des Büros; leise Orte (nichts vorlesen). Erkennung über
  die Google-Ortungsdienste (sonst Android-Näherungsalarm) – die Orte bleiben nur auf dem Handy.
- **Handy steuern**: Apps öffnen, Navigation, Wecker/Timer, Musik, YouTube, Lautstärke, Taschenlampe, „An Claude: …“;
  Anrufe und Nachrichten (auch WhatsApp, per Name aus dem Adressbuch) werden nur vorbereitet – gesendet wird per Tippen.
  Bei Telefonaten pausiert die Figur.
- **Videos auf Kommando**: bis zu 5 Videos der Figur; aus der Galerie teilen, Ausschnitt wählen, auf 720p verkleinern,
  Inhalt erkennen (nur auf Knopfdruck, 3 Standbilder an Claude); die Figur schaut klein in der Ecke mit.
- **Widget** (Glas, durchsichtig oder dunkel), Schnellkacheln, App-Verknüpfungen; **Teilen** mit der App legt Notizen an.
- **Fahrmodus**, **Nachrichten vorlesen** (mit der Stimme auf dem Gerät), **Bildschirm fragen**, schwebende Figur.
- **Abgleich mit dem PC im WLAN** (QR-Code) und über die **Synology-NAS** (Beta 91): am Handy über QuickConnect, am PC
  einfach über den Ordner des Synology-Clients/Netzlaufwerks; Abgleich gleich nach Änderungen, beim Öffnen und mit einem
  Kurz-Check alle 30 s; „🔌 Verbindung testen“ mit verständlichen Hinweisen; optional verschlüsselt (AES-256, eigenes
  Passwort auf jedem Gerät).
- **Läuft alles?** (⚙ → Verbindung): Ampel für Schlüssel, Mikrofon, Freigaben, Sicherung, Suche und Selbsttest – mit Knopf
  zum Beheben; wöchentliche **Sicherung auf dem Gerät**.

### Gedächtnis mit Suche nach Bedeutung (Beta 80)

Ein kleines Suchmodell (multilingual-e5-small, einmalig ca. 120 MB, auf dem Handy nur im WLAN) läuft auf dem Gerät und
durchsucht Notizen, das Notizbuch der Figur, frühere Gespräche, gespeichertes Wissen und – nur Dienstlich – das
Firmenwissen nach ihrer **Bedeutung** („Wann wollten wir verreisen?“ findet die Notiz „Gardasee im Juni“). Wortsuche
und Bedeutungssuche werden zusammengeführt; unter der Antwort steht, was aus dem Gedächtnis mitgegeben wurde (nicht
vorgelesen, abschaltbar). Die Suchdaten bleiben auf dem Gerät und werden weder abgeglichen noch exportiert.

### Einrichtung und Hilfe (Beta 80)

- **Ersteinrichtung** beim ersten Start: Namen, KI-Anbieter und Schlüssel (verdeckt, verschlüsselt gespeichert),
  Mikrofon und Stimme, Freigaben auf dem Handy, Ideen zum Ausprobieren. Später erneut über ⚙ → Verbindung →
  „🧭 Einrichtung erneut starten“.
- **Suche in den Einstellungen** (🔍 oben im ⚙) springt direkt zur Einstellung; **einfacher Modus** zeigt nur das
  Wichtigste („alle zeigen“ schaltet um).
- **„Was kannst du alles?“** – die Figur schlägt in der eingebauten Hilfe nach (passend zu Gerät und Bereich).
- **Selbsttest beim Start**: prüft Einstellungen und Daten und repariert Unstimmiges; Ergebnis unter „Läuft alles?“.

### Flüssigeres Gespräch und Humor-Stil (Beta 98)

- **Zuhören wie im Echtzeit-Gespräch** (Live-Gespräch am Handy, mit OpenAI-Schlüssel): die Cloud schreibt mit, während man spricht, und erkennt am Sinn, wann man fertig ist – keine festen Pausen, Rauschen wird nicht zu Sätzen, das Echo unterdrückt die Verbindung selbst. Antworten kommen weiter von der eigenen KI (Claude) mit der eigenen Stimme. Klappt die Verbindung nicht, läuft das bisherige Zuhören. Abschaltbar unter ⚙ → Sprache.
- **Humor-Stil je Persona:** Fein, Locker, Frech, Derb (Standard: Privat „Frech“, Dienstlich „Fein“; Dienstlich höchstens „Locker“). Feste Grenzen auf jeder Stufe: nichts gegen Gruppen, nichts Herabwürdigendes über Privatpersonen, nichts explizit Sexuelles; bei ernsten Themen kein Humor. Per Zuruf: „Sei mal frecher“, „Jetzt mal wieder ernst“.

### Kohärentes Gespräch (Beta 96)

- **Beim Thema bleiben:** Notizen, Vorhaben und offene Punkte gehen nur mit, wenn sie zur Frage passen – jedes Stück höchstens einmal je Gespräch; eigene Vorhaben der Figur nur zu Beginn eines Gesprächs; Erledigtes nur auf Nachfrage.
- **Falsch Erkanntes:** Echo der Figur wird auch kurz nach dem Sprechen erkannt (Nachhall, Auto); typische Erfindungen der Spracherkennung („Untertitel …“, „Abonniert den Kanal“) werden verworfen; bei unsicherer Erkennung fragt die Figur nach, statt aufs Falsche einzugehen.
- **„Vergiss das“ / „Das war Quatsch“** nimmt die letzte Eingabe samt Antwort aus dem Verlauf – ohne KI.
- **Neuer Chat mit Brücke:** das alte Gespräch wird sofort zusammengefasst („Wo ihr zuletzt wart“) und als Erinnerung abgelegt; lange Gespräche werden laufend zusammengefasst statt abgeschnitten.
- **Erledigt wirkt überall:** eine bestätigte Erinnerung hakt den passenden offenen Punkt im Second Brain mit ab.

### Sicherung & Geräte (Beta 94)

- Eigener Reiter **⚙ → Sicherung & Geräte**: Synology-NAS, WLAN-Kopplung und Abgleich, Sicherungen auf dem Gerät – auch in der einfachen Ansicht.
- **„Was ist abgeglichen?“** zeigt je Persona Gedächtnis, Selbstbild, Geschichte, Notizbuch, Verlauf und ob die Figur auf der NAS ist; dazu Second Brain und Erinnerungen und wann zuletzt über NAS/WLAN abgeglichen und gesichert wurde.
- **„🔁 Jetzt alles abgleichen“** und **„🗄 Jetzt auf der NAS sichern“** (sofort, auch wenn es heute schon eine Sicherung gab); per Zuruf: „Sichere jetzt auf die NAS“, „Ist alles synchron?“, „Wo stelle ich die NAS ein?“.
- Große Figuren (mehrere Videos) gehen in Teilen über die NAS (bis 300 MB); vorher blieben Figuren über 80 MB still zurück.
- Abgleich: selbst eingetragene Erinnerungen bleiben beim Begrenzen erhalten; das nächtliche Aufräumen des Notizbuchs überschreibt keine Persona-Änderungen vom anderen Gerät mehr.

### Second Brain am PC und Gerätewechsel (Beta 93, Bereich Privat)

- Second Brain (Notizen, Zwischenspeicher, Vorhaben der Figur) und Erinnerungen gibt es im Bereich Privat jetzt auch am PC – abgeglichen über WLAN oder die NAS.
- „Mach am PC weiter“ / „Weiter am Handy“: Die Figur legt eine Übergabe ab; am anderen Gerät greift sie nach dem Abgleich den Faden einmal auf („Wir waren gerade am Handy bei …“). Übergaben verfallen nach 8 Stunden.
- „Was gab's Neues?“ erzählt, was seit dem letzten Blick auf diesem Gerät dazukam (neue/geänderte/erledigte Notizen, Erinnerungen, Gesprächsthemen).

### Gedächtnis

Unter ⚙ → **Gedächtnis**: Nach jeder Antwort fragt die App das Modell in LM Studio kurz, welche Fakten dauerhaft
nützlich sind („Jens arbeitet bei …“, „mag kurze Antworten“, „merk dir, dass …“), und speichert sie lokal pro
Persona. Sie werden künftig mitgeschickt. Einträge lassen sich ansehen, bearbeiten, löschen oder selbst
hinzufügen. Beim Export einer Persona wird das Gedächtnis nicht mitgegeben.

### Ausdrucksstarke Stimme mit Chatterbox (optional, Grafikkarte)

Für deutlich natürlichere, emotionale Stimmen – und eine eigene, geklonte Stimme pro Persona – kann der lokale
Sprach-Server **Chatterbox** (MIT-Lizenz) genutzt werden. Er läuft auf der NVIDIA-Grafikkarte neben LM Studio.

1. Im Download-Paket bzw. unter ⚙ → Sprache → „Chatterbox installieren / starten …“ liegt
   `Chatterbox-installieren.bat` – einmal doppelklicken (10–20 Minuten, mehrere GB). Später `Chatterbox-starten.bat`.
2. ⚙ → Sprache → Engine **Chatterbox** → „Mehrsprachiges Modell aktivieren“ (für Deutsch, einmalig).
3. „🎙 Eigene Stimme aufnehmen“ (10–15 Sekunden vorlesen) oder eine Stimmprobe hochladen.
4. Mit **Ausdrucksstärke** die Lebendigkeit einstellen.

### Sprache

- **Piper** liest mit natürlichen Stimmen; englische Sätze automatisch mit der englischen Stimme.
  Empfohlen: „Thorsten“ (Deutsch) und „Lessac“ (Englisch).
- **Höchstens vorlesen** begrenzt lange Antworten (der Rest steht im Ausgabefenster).

### Zwei getrennte Programme: „KI-Assistent“ (lokal) und „KI-Assistent Cloud“

Es gibt zwei Installationen, die unabhängig nebeneinander laufen – jede mit eigenem Datenordner
(`%APPDATA%\KI-Assistent` bzw. `%APPDATA%\KI-Assistent Cloud`), eigenen Personas, Gedächtnis und Einstellungen:

- **KI-Assistent** (lokal): nur LM Studio und lokale Stimmen. Cloud-Anbieter und Schlüsselfelder gibt es
  dort gar nicht; der Hauptprozess lehnt Cloud-Anfragen zusätzlich ab.
- **KI-Assistent Cloud**: wie unten beschrieben, wahlweise Claude, ChatGPT oder weiterhin LM Studio.

### Cloud statt lokal (optional): Claude, ChatGPT, OpenAI-Stimme

Ist die eigene Grafikkarte zu langsam, kann das Sprachmodell in der Cloud laufen – alles andere (Avatar, Posen,
Gedächtnis, Personas, Spracherkennung) bleibt lokal:

- ⚙ → Verbindung → **KI-Anbieter**: *Claude (Anthropic)* oder *ChatGPT (OpenAI)*, API-Schlüssel eintragen.
  Für Claude ist **Haiku 5.5** (schnell, günstig) voreingestellt, Denktiefe „niedrig“ für flotte Antworten.
- ⚙ → Sprache → Engine **OpenAI-Stimme**: ausdrucksstarke Stimmen ohne Grafikkarte (z. B. Nova, Shimmer),
  Sprechstil per Anweisung („warm und lebendig …“).
- Schlüssel werden mit der Verschlüsselung von Windows gespeichert. Im Offline-Modus sind Cloud-Anbieter gesperrt.
- **Mit Claude zusätzlich** (⚙ → Verbindung, beide ab Werk an):
  - *Internetsuche*: Claude sucht selbst, liest Webseiten und hängt die **Quellen** an die Antwort (nicht vorgelesen).
  - *Dateien erstellen und bearbeiten*: „Mach daraus eine Excel-Tabelle / eine PowerPoint / ein Word-Dokument“ –
    Claude erstellt die Datei bei Anthropic, sie wird automatisch nach `Dokumente\KI-Assistent Cloud Dateien`
    geladen und erscheint im Chat mit „öffnen“ / „Im Ordner zeigen“. Folgefragen („noch eine Spalte“) arbeiten an
    derselben Datei weiter.
  - *Anhänge*: 📎 oder Datei ins Fenster ziehen – PDFs, Bilder, Texte und (mit Dateifunktion) Excel/Word/PowerPoint.
    Anhänge bleiben nur im Arbeitsspeicher und gehen ausschließlich mit der eigenen Nachricht an Claude.
- An den Anbieter geht nur der Chattext (Systemprompt, Verlauf, Gedächtnis-Notizen) bzw. der vorzulesende
  Satz. Bilder, Videos, Avatar und Sprachaufnahmen verlassen den Rechner nie.

### Datenschutz

Gespräche, Sprache, Bilder und Personas bleiben auf dem Rechner. Die Oberfläche hat technisch keinen
Internetzugriff; einzig der Hauptprozess lädt einmalig die Sprachmodelle von Hugging Face und speichert sie
in `%APPDATA%\KI-Assistent Modelle` (gemeinsam für beide Ausgaben). Im **Offline-Modus** (⚙ → Verbindung) entfällt auch das.

## Android-App (Testversion)

Die Oberfläche läuft auch als Android-App (Capacitor). Die APK kommt aus der GitHub-Action („KI-Assistent-Android“):
APK aufs Handy laden, öffnen, Installation aus dieser Quelle einmal erlauben.

- Denken über **Claude** oder **ChatGPT** (Schlüssel unter ⚙ → Verbindung, liegen im privaten App-Speicher),
  oder über **LM Studio auf dem PC im selben WLAN** (dort Server im Netzwerk freigeben und CORS aktivieren,
  Adresse z. B. `http://192.168.1.20:1234`) – dann bleibt alles im eigenen Netz.
- Spracherkennung wahlweise in der Cloud (OpenAI, schnell) oder auf dem Gerät (Whisper, langsamer).
- Avatar, 3D-Figur (VRM), Bewegungsbilder, lebendiges Gesicht, Live-Gespräch und Neuer Chat wie am PC.
- Personas vom PC: dort „Persona exportieren“, auf dem Handy „Persona importieren“.
- **Handy-Reiter** (⚙ → Handy): Widget, Kachel „KI sprechen“ in den Schnelleinstellungen, App als Standard-Assistent,
  Verknüpfungen (lange aufs App-Symbol) – öffnet die App und hört sofort zu.
- **Teilen → KI-Assistent** aus jeder App: Text/Link ins Eingabefeld, Fotos/PDFs als Anhang (Dateien nur mit Claude).
- **📷 Foto** direkt im Chat aufnehmen und dazu fragen (große Fotos werden verkleinert).
- **Ort** für Wetter, Verkehr & Co.: von Hand eintragen oder ungefähr vom Handy ermitteln (nur Ortsname).
- **Erinnerungen** (nur wenn eingeschaltet): Google-Termine/-Aufgaben der nächsten 2 Tage als Benachrichtigung, auch bei
  geschlossener App; bei offener App sagt die Figur sie an.
- **Gespräch im Hintergrund** (nur wenn eingeschaltet): läuft bei ausgeschaltetem Bildschirm weiter, Headset-Taste = sprechen.
- **Akku-Sparmodus**: Figur mit weniger Bildern pro Sekunde bei Energiesparmodus bzw. wenig Akku.
- **Beta-Linie** (Zweig `claude/ki-assistent-beta`, Datei `kanal.json`): App „KI-Assistent Beta“ mit eigener App-ID,
  installierbar neben der normalen App. Darin neu: **schwebende Figur** über anderen Apps (⚙ → Handy → Schwebende Figur;
  Android-Erlaubnis „Über anderen Apps einblenden“ nötig).
- Nicht auf dem Handy: freie Figur über anderen Apps (geplant), Ausgabefenster, PDF-Export, Chatterbox.

## Entwickeln

```bash
cd ki-assistent
npm install
npm start          # baut die Oberfläche und startet die App
npm test           # Sprachkette Piper → Whisper (braucht Internet) + „3D-Figur aus Bildern“ im Browser testen
npm run dist       # Windows-Installer + portable .exe nach release/
```

Die Windows-Programme werden bei jedem Push von GitHub Actions gebaut (Workflow „KI-Assistent“,
Artefakt **KI-Assistent-Windows**). Ein Tag `ki-assistent-v0.1.0` erzeugt zusätzlich ein GitHub-Release.

### Aufbau

```
main.js           Electron-Hauptprozess: Fenster, app://-Protokoll, LM-Studio-Anbindung (Streaming), Speicher
preload.js        sichere Brücke zwischen Oberfläche und Hauptprozess
src/app.js        Oberfläche: Chat, Einstellungen, Personas, Ablaufsteuerung
src/avatar.js     Avatar-Animation (Canvas): Atmen, Blinzeln, Lippen öffnen
src/cutout.js     Hintergrund entfernen (freistellen)
src/bild2vrm/     3D-Figur (VRM mit Mimik) aus Bildern erzeugen – Ursprung: bild2vrm/js im Repo
src/bild2vrm-dialog.js  Dialog „Aus Bildern erstellen“
src/bild2vrm-detect.js  Gesichts-/Körpererkennung dafür (MediaPipe, Modelle in assets/)
src/windows.js    freischwebende Figur + Ausgabefenster
src/piper.js      Piper-Anbindung mit korrekter Laut-Zuordnung je Stimme
src/stt.js        Mikrofon + Sprechpausen-Erkennung
src/stt-worker.js Whisper im Web-Worker
src/tts.js        Piper / Systemstimmen, satzweise Ausgabe während die Antwort noch entsteht
build.mjs         bündelt alles nach dist/ inkl. der WASM-Laufzeiten (keine CDN-Abhängigkeit)
```

Daten (Einstellungen, Personas, Verläufe) liegen in `%APPDATA%\KI-Assistent\daten.json`.
