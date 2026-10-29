// Hilfe: was die App kann – für „Was kannst du alles?“ (Werkzeug app_hilfe), die Ersteinrichtung und die Suche in
// den Einstellungen. Jeder Eintrag sagt, wie man es benutzt und wo es eingestellt wird; „nur“ grenzt ein, wo es das
// gibt (mobil = Android-App, pc = Windows, privat = Bereich Privat, dienstlich, cloud = mit Claude/ChatGPT).

export const FEATURES = [
  // ---- Gespräch
  { id: 'sprechen', gruppe: 'Gespräch', titel: 'Sprechen statt tippen', text: '🎤 antippen (PC: Strg+Leertaste) und lossprechen; nach einer kurzen Pause wird abgeschickt.', wo: '⚙ → Sprache', stichworte: 'mikrofon spracheingabe reden zuhören' },
  { id: 'live', gruppe: 'Gespräch', titel: 'Live-Gespräch', text: '📞 – die App hört dauerhaft zu, Dazwischenreden unterbricht die Figur. Am besten mit Headset.', wo: '⚙ → Sprache → Live-Gespräch', stichworte: 'dauerhaft zuhören unterbrechen headset freihand' },
  { id: 'echtzeit', gruppe: 'Gespräch', titel: 'Echtzeit-Gespräch', text: 'Antworten in etwa einer halben Sekunde (OpenAI Realtime), kostet mehr pro Minute.', wo: '⚙ → Handy → Echtzeit-Gespräch', nur: { mobil: true, privat: true, cloud: true }, stichworte: 'schnell realtime' },
  { id: 'aktivierungswort', gruppe: 'Gespräch', titel: 'Aktivierungswort', text: 'Den Namen der Figur sagen, dann hört sie zu – das Wort wird auf dem Handy erkannt.', wo: '⚙ → Handy → Aktivierungswort', nur: { mobil: true }, stichworte: 'wake word hey name' },
  { id: 'diktat', gruppe: 'Gespräch', titel: 'Diktieren und Erzählen', text: '📝 antippen = Diktat (Text zum Prüfen, danach „Antworten lassen“ oder „Als Notiz“), 📝 lange drücken = Erzählen: so lange reden, wie du willst – am Ende antwortet die Figur. Ende per Zuruf: „fertig“, „Was meinst du?“, „als Notiz“.', wo: '⚙ → Sprache → Diktat und Erzählen', stichworte: 'diktieren lange sprachnachricht mitschreiben erzaehlen' },
  { id: 'zurufe', gruppe: 'Gespräch', titel: 'Stopp, Moment, weiter', text: '„Stopp“ macht die Figur sofort still, „Moment“ hält an, „weiter“ setzt fort – ohne Umweg über die KI. „Nein, ich meinte …“ korrigiert, statt neu anzufangen.', wo: '–', stichworte: 'stopp halt unterbrechen moment pause weiter korrigieren' },
  { id: 'klartext', gruppe: 'Gespräch', titel: 'Klartext', text: 'Beginnt eine Nachricht mit „Klartext:“, antwortet die Figur einmal sachlich außerhalb ihrer Rolle.', wo: '–', stichworte: 'rolle ehrlich ki' },
  { id: 'internet', gruppe: 'Gespräch', titel: 'Im Internet nachsehen', text: 'Fragen nach Aktuellem: die Figur sucht selbst und hängt die Quellen an.', wo: '⚙ → Verbindung (Claude: Internetsuche)', nur: { cloud: true }, stichworte: 'suche web aktuell quellen recherche' },
  { id: 'dateien', gruppe: 'Gespräch', titel: 'Dateien erstellen', text: '„Mach daraus eine Excel-Tabelle / PowerPoint / ein Word-Dokument“ – die Datei landet im Ordner und im Chat.', wo: '⚙ → Verbindung (Claude: Dateien)', nur: { cloud: true, pc: true }, stichworte: 'excel word powerpoint pdf dokument' },
  { id: 'anhang', gruppe: 'Gespräch', titel: 'Bilder und Dokumente zeigen', text: '📎 oder Datei ins Fenster ziehen: PDFs, Bilder, Texte – gehen nur mit deiner Nachricht an die KI.', wo: '📎 neben dem Eingabefeld', nur: { cloud: true }, stichworte: 'anhang pdf foto bild' },
  // ---- Gedächtnis & Wissen
  { id: 'gedaechtnis', gruppe: 'Gedächtnis', titel: 'Gedächtnis', text: 'Die Figur merkt sich Fakten über dich von selbst; „Merk dir, dass …“ oder „Vergiss …“ geht auch.', wo: '⚙ → Gedächtnis', stichworte: 'merken vergessen fakten' },
  { id: 'suche', gruppe: 'Gedächtnis', titel: 'Erinnert sich an alles', text: '„Weißt du noch …“, „Was hatten wir zu … besprochen?“ – sie durchsucht Notizen, frühere Gespräche und gespeichertes Wissen auch nach Bedeutung; unter der Antwort steht, was sie dafür genommen hat.', wo: '⚙ → Gedächtnis → Suche nach Bedeutung', stichworte: 'weißt du noch erinnern früher besprochen suchen' },
  { id: 'brain', gruppe: 'Gedächtnis', titel: 'Second Brain (Notizen)', text: '„Notier dir …“, Ordner, offene Punkte, Wochenrückblick; Export als Datei für den PC.', wo: '⚙ → Wissen → Second Brain', nur: { privat: true, mobil: true }, stichworte: 'notiz notizen ordner offene punkte wochenrückblick' },
  { id: 'zwischen', gruppe: 'Gedächtnis', titel: 'Für später (Zwischenspeicher)', text: '„Für später: …“ oder im Widget – nebenbei notieren, ohne dass die Figur antwortet; später mit „Lass uns den Zwischenspeicher durchgehen“.', wo: 'Widget, App-Verknüpfung, 📥 neben der Eingabe', nur: { privat: true, mobil: true }, stichworte: 'schnell notieren nebenbei inbox' },
  { id: 'wissen', gruppe: 'Gedächtnis', titel: 'Gespeichertes Wissen', text: '„Speicher das Ergebnis“ – Rechercheergebnisse bleiben und werden später wiedergefunden.', wo: '⚙ → Wissen', nur: { cloud: true }, stichworte: 'speichern ablegen recherche' },
  { id: 'firmenwissen', gruppe: 'Gedächtnis', titel: 'Firmenwissen', text: 'Preislisten, AGB & Co. aufnehmen; passende Abschnitte gehen zur Frage mit. Keine Kundendaten.', wo: '⚙ → Wissen → Firmenwissen', nur: { dienstlich: true }, stichworte: 'dokumente preisliste agb firma' },
  { id: 'vorhaben', gruppe: 'Gedächtnis', titel: 'Die Figur arbeitet an Vorhaben', text: 'Gib ihr eine Aufgabe über mehrere Tage („Such mir bis Freitag Wallbox-Angebote heraus“) – sie arbeitet Schritt für Schritt daran und erzählt, was sie gefunden hat.', wo: '⚙ → Gedächtnis', nur: { privat: true, mobil: true, cloud: true }, stichworte: 'aufgabe projekt recherche selbstständig' },
  // ---- Alltag
  { id: 'erinnerung', gruppe: 'Alltag', titel: 'Erinnerungen und Timer', text: '„Erinnere mich in 20 Minuten an …“, „Weck mich um 6:30“ – kommt auch, wenn die App zu ist, und bleibt stehen, bis du sie bestätigst.', wo: '⚙ → Handy → Erinnerungen', nur: { privat: true }, stichworte: 'timer wecker erinnern' },
  { id: 'ort', gruppe: 'Alltag', titel: 'Erinnerungen und Notizen an Orten', text: '„Merk dir Hauptstraße 5 als Zuhause“ oder „Merk dir dieses WLAN als Büro“, dann „Erinnere mich, wenn ich nach 17 Uhr zu Hause bin, …“ – beim Ankommen oder Verlassen, einmal oder jedes Mal; Notizen mit Ort („für den Baumarkt“) erscheinen dort; „Was steht hier an?“.', wo: '⚙ → Handy → Orte', nur: { privat: true, mobil: true }, stichworte: 'ort standort supermarkt ankommen verlassen zuhause buero wlan adresse auto' },
  { id: 'ortprofil', gruppe: 'Alltag', titel: 'Verhalten je Ort', text: 'An „leisen“ Orten (z. B. Büro) liest die Figur nichts vor und meldet sich nicht von selbst; beim Heimkommen kommt die Feierabendrunde, beim Verlassen des Büros die Verkehrslage für den Heimweg.', wo: '⚙ → Handy → Orte', nur: { privat: true, mobil: true }, stichworte: 'leise buero heimkommen feierabend verkehr heimweg' },
  { id: 'runden', gruppe: 'Alltag', titel: 'Morgen- und Feierabendrunde', text: 'Kurzer Überblick am Morgen (Termine, Wetter, Offenes) und Rückblick am Abend – auf Wunsch als Benachrichtigung zur festen Uhrzeit.', wo: '⚙ → Gedächtnis → Gesprächsgefühl', stichworte: 'morgen briefing tagesüberblick feierabend rückblick' },
  { id: 'nachtschicht', gruppe: 'Alltag', titel: 'Nachtschicht', text: 'Nachts beim Laden im WLAN arbeitet die Figur an einem Vorhaben weiter und erzählt morgens davon.', wo: '⚙ → Gedächtnis → Gesprächsgefühl', nur: { privat: true, mobil: true, cloud: true }, stichworte: 'nachts hintergrund' },
  { id: 'google', gruppe: 'Alltag', titel: 'Kalender und Aufgaben', text: 'Google Kalender & Aufgaben lesen; Eintragen nur nach deinem Ja. Im Bereich Privat auch Gmail lesen und Entwürfe.', wo: '⚙ → Verbindung → Google', nur: { cloud: true }, stichworte: 'termin kalender aufgaben gmail mail' },
  { id: 'wetter', gruppe: 'Alltag', titel: 'Wetter, Verkehr, Nachrichten', text: '„Wie wird das Wetter?“, „Staus auf der A2?“, „Was gibt es Neues?“', wo: '⚙ → Verbindung → Ort', stichworte: 'wetter stau autobahn nachrichten news' },
  { id: 'fahrmodus', gruppe: 'Alltag', titel: 'Fahrmodus', text: 'Startet mit dem Auto-Bluetooth: kurze Antworten, nur die Figur.', wo: '⚙ → Handy → Fahrmodus', nur: { mobil: true, privat: true }, stichworte: 'auto fahren bluetooth' },
  { id: 'vorlesen', gruppe: 'Alltag', titel: 'Nachrichten vorlesen', text: 'WhatsApp, Signal, SMS werden mit der Stimme auf dem Gerät vorgelesen.', wo: '⚙ → Handy → Nachrichten vorlesen', nur: { mobil: true, privat: true }, stichworte: 'whatsapp sms vorlesen benachrichtigung' },
  // ---- Handy steuern
  { id: 'handy', gruppe: 'Handy', titel: 'Handy steuern', text: '„Öffne Spotify“, „Navigiere nach Hause“, „Stell einen Timer auf 10 Minuten“, „Lauter“, „Taschenlampe an“, „Spiel auf YouTube …“.', wo: '–', nur: { mobil: true, privat: true }, stichworte: 'app öffnen navigation musik youtube spotify lautstärke taschenlampe' },
  { id: 'anrufen', gruppe: 'Handy', titel: 'Anrufen und Nachrichten', text: '„Ruf Anna an“, „Schreib Tom per WhatsApp, dass …“ – wird vorbereitet, du tippst zum Senden.', wo: '⚙ → Läuft alles? (Adressbuch)', nur: { mobil: true, privat: true }, stichworte: 'anrufen whatsapp sms kontakt' },
  { id: 'claude', gruppe: 'Handy', titel: 'An Claude übergeben', text: '„An Claude: …“ gibt eine Aufgabe an die Claude-App weiter.', wo: '✳ neben dem Eingabefeld', stichworte: 'claude cowork übergeben' },
  { id: 'widget', gruppe: 'Handy', titel: 'Widget und Schnellkacheln', text: 'Widget auf dem Startbildschirm (Sprechen, Diktat, Für später, Offen), Schnellkacheln und App-Verknüpfungen.', wo: '⚙ → Handy → Schnellstart', nur: { mobil: true }, stichworte: 'widget kachel startbildschirm verknüpfung' },
  { id: 'schwebend', gruppe: 'Handy', titel: 'Schwebende Figur', text: 'Die Figur schwebt über anderen Apps; antippen = sprechen, lange drücken = Menü (auch „Bildschirm fragen“).', wo: '⚙ → Handy → Schwebende Figur', nur: { mobil: true }, stichworte: 'über anderen apps bubble bildschirm' },
  // ---- Figur
  { id: 'persona', gruppe: 'Figur', titel: 'Eigene Figur und Persona', text: 'Name, Charakter, Geschichte und Stimme frei gestalten; mehrere Personas.', wo: '⚙ → Persona', stichworte: 'charakter rolle name persönlichkeit' },
  { id: 'avatar', gruppe: 'Figur', titel: 'Aussehen', text: 'Eigenes Bild (wird freigestellt und lebendig), Posen, 3D-Figur (VRM) oder aus eigenen Bildern bauen.', wo: '⚙ → Avatar', stichworte: 'bild foto vrm 3d pose aussehen' },
  { id: 'videos', gruppe: 'Figur', titel: 'Videos auf Kommando', text: 'Bis zu 5 Videos der Figur („Zeig das Geburtstagsvideo“); aus der Galerie teilen, zuschneiden, verkleinern.', wo: '⚙ → Avatar → Videos auf Kommando', nur: { privat: true }, stichworte: 'video film clip abspielen' },
  { id: 'selbstbild', gruppe: 'Figur', titel: 'Die Figur entwickelt sich', text: 'Sie denkt über eure Gespräche nach, führt Tagebuch und ein eigenes Notizbuch, hat Ziele und Stimmungen.', wo: '⚙ → Gedächtnis → Selbstbild', stichworte: 'tagebuch selbstbild stimmung entwicklung' },
  // ---- Geräte & Sicherheit
  { id: 'abgleich', gruppe: 'Geräte', titel: 'PC und Handy abgleichen', text: 'Einmal per QR-Code koppeln, danach gleichen sich Personas, Verlauf, Gedächtnis und Notizen im WLAN ab; im Bereich Privat auch über die Synology-NAS.', wo: '⚙ → Wissen → Abgleich', stichworte: 'synchron sync wlan nas synology qr' },
  { id: 'sicherung', gruppe: 'Geräte', titel: 'Sicherungen', text: 'Wöchentliche Sicherung auf dem Gerät, zurückholen mit einem Tipp; Persona als Datei exportieren.', wo: '⚙ → Verbindung → Sicherungen', stichworte: 'backup sicherung export wiederherstellen' },
  { id: 'status', gruppe: 'Geräte', titel: 'Läuft alles?', text: 'Ampel für Schlüssel, Mikrofon, Freigaben, Sicherung und Suche – mit Knopf zum Beheben.', wo: '⚙ → Verbindung → Läuft alles?', stichworte: 'status fehler problem prüfen freigabe' },
  { id: 'kosten', gruppe: 'Geräte', titel: 'Kosten im Blick', text: '💲 zeigt die geschätzten Kosten; Monatsbudget mit Sparmodus.', wo: '⚙ → Gedächtnis → Kostenbremse', stichworte: 'kosten geld budget preis' },
  { id: 'sperre', gruppe: 'Geräte', titel: 'App-Sperre', text: 'Mit Fingerabdruck oder Gesicht entsperren; Inhalt im App-Wechsler verborgen.', wo: '⚙ → Handy → App-Sperre', nur: { mobil: true }, stichworte: 'sperre fingerabdruck schutz' },
  { id: 'datenschutz', gruppe: 'Geräte', titel: 'Was bleibt auf dem Gerät?', text: 'Bilder, Avatar, Videos, Stimme und Suchdaten bleiben lokal; an die KI geht nur der Chattext (und was du selbst anhängst). Schlüssel liegen verschlüsselt.', wo: '⚙ → Verbindung → Datenschutz', stichworte: 'datenschutz privat lokal sicher cloud' },
  // ---- PC
  { id: 'buero', gruppe: 'PC', titel: 'Büro-Helfer', text: 'Strg+Alt+K bearbeitet markierten Text in jeder App, Strg+Alt+D diktiert in jede App, Schnellbefehle als Knöpfe.', wo: '⚙ → Büro', nur: { pc: true }, stichworte: 'markieren bearbeiten tastenkürzel büro' },
  { id: 'desktopfigur', gruppe: 'PC', titel: 'Figur frei auf dem Desktop', text: '🧍 stellt die Figur frei auf den Bildschirm; 📄 öffnet die Antworten groß mit PDF/Word-Export.', wo: 'Knöpfe oben', nur: { pc: true }, stichworte: 'desktop ausgabefenster pdf word' },
];

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss');
const words = (s) => (norm(s).match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const STOP = new Set('was wie kann kannst du ich mir mich mal bitte und oder der die das den dem ein eine einen geht gibt alles app machen funktioniert noch auch'.split(' '));

/** Gibt es die Funktion hier? ctx: { mobil, privat, cloud } */
export function available(f, ctx = {}) {
  const n = f.nur ?? {};
  if (n.mobil && !ctx.mobil) return false;
  if (n.pc && ctx.mobil) return false;
  if (n.privat && !ctx.privat) return false;
  if (n.dienstlich && ctx.privat) return false;
  if (n.cloud && !ctx.cloud) return false;
  return true;
}

/** Passende Einträge zu einer Frage (beste zuerst); ohne Frage: alle verfügbaren. */
export function helpSearch(q, ctx = {}, k = 6) {
  const list = FEATURES.filter((f) => available(f, ctx));
  const want = words(q);
  if (!want.length) return list.slice(0, k);
  return list
    .map((f) => {
      const hay = norm(`${f.titel} ${f.stichworte} ${f.text} ${f.gruppe}`);
      const title = norm(f.titel);
      const score = want.reduce((a, w) => a + (title.includes(w) ? 3 : hay.includes(w) ? 1 : hay.includes(w.slice(0, 5)) ? 0.5 : 0), 0);
      return [f, score];
    })
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([f]) => f);
}

/** Überblick nach Gruppen (für „Was kannst du alles?“): je Gruppe die Titel. */
export function helpOverview(ctx = {}) {
  const out = {};
  for (const f of FEATURES) if (available(f, ctx)) (out[f.gruppe] ??= []).push(f.titel);
  return out;
}

/** Für das Werkzeug: kurze, vollständige Einträge. */
export const helpEntry = (f) => ({ titel: f.titel, so_gehts: f.text, einstellung: f.wo });
