// Natürliches Gespräch: kurze Zurufe, die die App selbst erledigt (Stopp, Moment, weiter – ohne Umweg über die KI),
// Korrekturen („Nein, ich meinte …“), Pausenlänge je nach Länge des Gesagten und die Enden beim langen Erzählen.

const words = (t) =>
  String(t ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

// Zurufe (ganze Äußerung, höchstens ein paar Wörter; Anrede mit Namen davor/danach ist erlaubt)
const STOP = /^(stopp?|halt|ruhe|still|sei (mal )?(still|ruhig)|hör (mal )?auf|aufhören|schluss|genug|abbrechen|schon gut|ist gut|passt schon|danke (das )?reicht|reicht( schon)?|okay (danke|stopp?)|ok stopp?|stopp? bitte|bitte stopp?)$/;
const PAUSE = /^(warte|wart mal|warte mal|moment|einen moment|moment mal|kurz (mal )?(warten|pause)|pause|mach (mal )?pause)$/;
const RESUME = /^(weiter|mach weiter|weitermachen|sprich weiter|erzähl weiter|fahr fort|okay weiter|ok weiter|weiter bitte|bitte weiter)$/;

/**
 * Kurzer Zuruf an die Figur? → 'stopp' | 'pause' | 'weiter' | null. name: Name der Figur (wird vorn/hinten ignoriert).
 * Nur für kurze Äußerungen – „Stopp, ich meinte eigentlich …“ ist eine Korrektur, kein Zuruf.
 */
export function voiceCommand(text, name = '') {
  let w = words(text);
  const n = String(name ?? '').toLowerCase();
  if (n) w = w.filter((x, i) => !(x === n && (i === 0 || i === w.length - 1)));
  if (!w.length || w.length > 4) return null;
  const s = w.join(' ');
  if (STOP.test(s)) return 'stopp';
  if (PAUSE.test(s)) return 'pause';
  if (RESUME.test(s)) return 'weiter';
  return null;
}

/** Korrektur des eben Gesagten oder der Antwort („Nein, ich meinte …“, „nicht Dienstag, sondern Mittwoch“)? */
export function isCorrection(text) {
  const t = String(text ?? '').toLowerCase().trim();
  return (
    /^(nein|nee|stopp?|halt|quatsch|falsch|sorry|pardon|entschuldigung)\b[\s,.!]*(ich (meinte|meine|wollte sagen)|eigentlich|nicht|sondern|das (war|ist) falsch|so meinte ich das nicht)/.test(t) ||
    /^(ich meinte|ich meine natürlich|ich wollte sagen|korrektur|nicht \S+(\s\S+)?,? sondern)\b/.test(t)
  );
}

/**
 * Wie lange Stille gilt als „fertig gesprochen“ (Live-Gespräch)? Kurze Äußerungen (Zurufe, „ja“, kurze Antworten)
 * enden schnell; wer länger spricht, darf länger überlegen. spokenMs = bisher gesprochene Zeit.
 */
export function liveSilenceMs(spokenMs, baseMs = 1200) {
  if (spokenMs < 1500) return Math.min(baseMs, 600);
  return baseMs + Math.min(1500, Math.max(0, spokenMs - 1500) * 0.15);
}

// Enden beim langen Erzählen/Diktat: „fertig“ (je nach Einstellung), „was meinst du?“ (die Figur antwortet),
// „als Notiz“ (Second Brain), „abschicken“ (wie bisher), „nur Text“ (bleibt im Eingabefeld zum Prüfen)
const END = /[\s,.]*\b(fertig|ende diktat|diktat ende|diktat beenden|abschicken|absenden|senden|schick (es|das) ab|als notiz( speichern| ablegen)?|ins second brain|nur (als )?text|(und )?was (meinst|sagst|denkst) du( dazu| darüber)?|was hältst du davon|deine meinung|antworte( mir)?( bitte)?)[.!?]*\s*$/i;
/** Ende eines Diktats erkennen: { how: 'fertig'|'antworten'|'notiz'|'senden'|'text', rest } oder null. */
export function dictEnd(text) {
  const t = String(text ?? '');
  const m = END.exec(t);
  if (!m) return null;
  const e = m[1].toLowerCase();
  const how = /notiz|second brain/.test(e) ? 'notiz' : /^nur/.test(e) ? 'text' : /abschick|absend|^senden|schick/.test(e) ? 'senden' : /was |halt|meinung|antwort/.test(e) ? 'antworten' : 'fertig';
  // bei „was meinst du?“ bleibt die Frage Teil des Gesagten
  const rest = how === 'antworten' ? t.trim() : t.slice(0, m.index).trim();
  return { how, rest };
}

/** Zusätze für die KI (in den Systemtext). */
export const RULE_LIVE =
  'Live-Gespräch (gesprochen, hin und her): Antworte kurz – höchstens zwei, drei Sätze –, sag das Wichtigste zuerst ' +
  'und lass Raum für dein Gegenüber; Details nur auf Nachfrage. Stell ab und zu eine kurze, passende Rückfrage statt ' +
  'eines Monologs.';
export const RULE_LONG_TURN =
  'Dein Gegenüber hat dir gerade länger erzählt. Sag zuerst in einem Satz, was du verstanden hast („Wenn ich dich ' +
  'richtig verstehe …“), dann antworte oder frag gezielt nach. Lohnt es sich, biete kurz an, es als Notiz abzulegen.';
export const RULE_CORRECTION =
  'Dein Gegenüber korrigiert sich oder dich gerade. Übernimm die Korrektur ohne lange Entschuldigung und antworte nur ' +
  'noch auf den korrigierten Stand – fang nicht von vorn an.';

// ---------------------------------------------------------------- Gesprächsmodi und Echtzeit per Zuruf
/**
 * Wunsch nach einer anderen Gesprächsart? → 'kurz' | 'plaudern' | 'genau' | 'normal' | null. Gilt, bis etwas anderes
 * gesagt wird (die Nachricht geht trotzdem an die Figur – sie soll ja darauf eingehen).
 */
export function talkMode(text) {
  const t = String(text ?? '').toLowerCase();
  if (/\b(wieder normal|normal weiter|ganz normal|wie vorher|normaler modus)\b/.test(t)) return 'normal';
  if (/\b(nur kurz|fass dich kurz|kurz bitte|kürzer bitte|kurze antworten|in kurz|knapp bitte|nicht so lang)\b/.test(t)) return 'kurz';
  if (/\b(erklär[’']?s? (mir )?(genau|ausführlich|gründlich)|ganz genau|ausführlich bitte|ausführlicher|schritt für schritt|im detail|mehr details)\b/.test(t)) return 'genau';
  if (/\b(lass uns (mal )?(ein bisschen |etwas )?(plaudern|quatschen|reden|unterhalten)|einfach plaudern|erzähl (doch )?(mal )?(was|etwas) von dir|lass uns quatschen)\b/.test(t)) return 'plaudern';
  return null;
}
/** Echtzeit-Gespräch per Zuruf an ('an') oder aus ('aus')? */
export function realtimeCommand(text) {
  const t = String(text ?? '').toLowerCase();
  if (/\b(echtzeit|realtime)[- ]?(gespräch|modus)?\s*(aus|beenden|stopp|stop|ende)\b|\b(beende|stopp?) (das )?echtzeit/.test(t)) return 'aus';
  if (/\b(echtzeit|realtime)[- ]?(gespräch|modus)?\s*(an|starten|start|einschalten)\b|\bin echtzeit (reden|quatschen|plaudern|sprechen|unterhalten)\b|\b(starte|mach) (das )?echtzeit/.test(t)) return 'an';
  return null;
}
export const MODE_RULES = {
  kurz: 'Dein Gegenüber möchte es kurz: antworte in ein, zwei Sätzen, ohne Rückfrage, außer sie ist nötig.',
  plaudern:
    'Ihr plaudert gerade locker: antworte im Plauderton, bring eigene Gedanken, Erlebnisse aus deiner Rolle oder eine ' +
    'kleine Beobachtung ein und stell gern eine neugierige Rückfrage – wie in einem echten Gespräch unter Freunden.',
  genau: 'Dein Gegenüber möchte es genau: erkläre gründlich und strukturiert, Schritt für Schritt; Länge ist hier erwünscht.',
};
export const MODE_NAMES = { kurz: 'kurz', plaudern: 'Plaudern', genau: 'genau', normal: 'normal' };

// ---------------------------------------------------------------- Gerätewechsel
/** „Mach am PC weiter“ / „Weiter am Handy“ → Zielgerät 'pc' | 'handy' | null. */
export function handoffCommand(text) {
  const t = String(text ?? '').toLowerCase();
  const pc = /\b(pc|computer|rechner|laptop|schreibtisch)\b/;
  const phone = /\b(handy|smartphone|telefon|unterwegs)\b/;
  if (!/\b(mach(en)? (wir )?(am|auf dem|beim) .* weiter|weiter (am|auf dem|beim)|wechsel(n)? (an|auf|zum) (den |das )?|übergib|übergeben|ich geh(e)? (an|zum) (den |das )?|lass uns (am|auf dem) .* weitermachen)/.test(t)) return null;
  if (pc.test(t)) return 'pc';
  if (phone.test(t)) return 'handy';
  return null;
}
/** „Was gab's Neues?“ / „Was hab ich verpasst?“ */
export const newsRequest = (text) => /\b(was gibt'?s neues|was gab'?s neues|was gibt es neues|was ist neu|was hab(e)? ich verpasst|was ist (seitdem|inzwischen) passiert|was hat sich getan|neuigkeiten seit)\b/i.test(String(text ?? ''));

/**
 * Was ist seit dem letzten Blick auf diesem Gerät dazugekommen (aus den abgeglichenen Daten)? Für „Was gab's Neues?“
 * und die Begrüßung nach einem Gerätewechsel. Liefert einen kurzen Text für die KI (oder '' = nichts Neues).
 */
export function whatsNew({ since = 0, notes = [], ownNotes = [], reminders = [], history = [], now = Date.now() } = {}) {
  const lines = [];
  const neu = notes.filter((n) => (n.created ?? 0) > since);
  const geaendert = notes.filter((n) => (n.created ?? 0) <= since && (n.changed ?? 0) > since);
  const erledigt = notes.filter((n) => (n.erledigt ?? 0) > since);
  if (neu.length) lines.push(`Neue Notizen: ${neu.slice(0, 6).map((n) => `„${n.titel}“`).join(', ')}${neu.length > 6 ? ` (+${neu.length - 6})` : ''}`);
  if (geaendert.length) lines.push(`Geänderte Notizen: ${geaendert.slice(0, 4).map((n) => `„${n.titel}“`).join(', ')}`);
  if (erledigt.length) lines.push(`Erledigt: ${erledigt.slice(0, 4).map((n) => `„${n.titel}“`).join(', ')}`);
  const fig = ownNotes.filter((n) => (n.changed ?? 0) > since && n.ordner === 'projekte');
  if (fig.length) lines.push(`Deine eigenen Vorhaben weitergeführt: ${fig.slice(0, 3).map((n) => `„${n.titel}“`).join(', ')}`);
  const rem = reminders.filter((r) => (r.created ?? 0) > since && !r.ack);
  if (rem.length) lines.push(`Neue Erinnerungen: ${rem.slice(0, 4).map((r) => r.text).join(', ')}`);
  const talk = history.filter((m) => (m.t ?? 0) > since && m.role === 'user').map((m) => String(m.content ?? '').slice(0, 120));
  if (talk.length) lines.push(`Gesprächsthemen inzwischen (${talk.length} Nachricht${talk.length === 1 ? '' : 'en'}): ${talk.slice(-4).map((t) => `„${t}“`).join(' · ')}`);
  return lines.join('\n');
}
