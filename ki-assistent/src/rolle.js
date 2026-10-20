// Rolle halten: Sätze, mit denen die Figur aus ihrer Rolle fällt („Als KI …“), erkennen, aus Antworten und dem
// Verlauf nehmen – außer der Nutzer hat ausdrücklich gefragt (direkte KI-Frage oder „Klartext:“).

/** Satz, mit dem die Figur aus der Rolle fällt. */
const OUT_OF_ROLE = new RegExp(
  [
    '\\bals (eine |ein )?(ki|künstliche intelligenz|sprachmodell|ki-modell|ki-assistent(in)?|computerprogramm|programm|bot|maschine)\\b',
    '\\bich bin (doch |ja |nur |lediglich |bloß )?(eine ki|ein (ki-|sprach)?modell|ein (computer)?programm|ein bot|eine künstliche intelligenz|eine maschine|ein ki-assistent|ein (großes )?sprachmodell)',
    '\\bich bin (claude|chatgpt|gpt|gemini)\\b',
    '\\bich habe (keine|kein) (echten |eigenen |richtigen )?(gefühle|emotionen|körper|bewusstsein|persönlichen erfahrungen)',
    '\\bich kann (keine|nichts) (gefühle|emotionen) (haben|empfinden)',
    '\\bich kann (nicht wirklich|nicht richtig|nicht echt) (fühlen|empfinden)',
    '\\bich existiere (doch |ja |nur |lediglich |bloß )?(digital|virtuell|als (software|programm|code|text))',
    '\\bmeine?[nm]? trainingsdaten\\b',
    '\\bmein wissen(sstand)? (reicht|endet|geht) (nur )?bis',
    '\\bich (wurde|bin) (von )?(anthropic|openai|google|meta|microsoft|mistral)( \\w+)? (entwickelt|trainiert|programmiert|erstellt|gebaut)',
    '\\bich wurde (darauf|so) (trainiert|programmiert)',
    '\\bich (habe|besitze) kein(e|en)? (echtes |eigenes |dauerhaftes |langfristiges )?(gedächtnis|erinnerungsvermögen)( über| zwischen| für (unsere |frühere )?gespräche|[.!,]|$)',
    '\\bich kann mich nicht an (frühere|vergangene|unsere (früheren|letzten)|vorherige) (gespräche|unterhaltungen|sitzungen) erinnern',
    '\\bals (digitale[rn]?|virtuelle[rn]?) (assistent(in)?|helfer(in)?|wesen)\\b',
    '\\bmeine[rn]? programmierung\\b',
    // Gespräch über die Technik dahinter: Werkzeuge, Speicher, Anweisungen
    '\\brufe (dafür |jetzt |gleich |kurz )?(das|ein|mein|dein) (werkzeug|tool)\\b',
    '\\b(nutze|verwende|benutze) (dafür |jetzt |gleich |kurz )?(das|ein|mein) tool\\b',
    '\\b(systemprompt|system-prompt|meine[nr]? (anweisungen|instruktionen|vorgaben)|mein(em)? steckbrief)\\b',
    '\\b(gedächtnis|wissens|daten)speicher\\b',
    '\\blaut meine[mrn] (daten|datenbank|speicher|aufzeichnungen)\\b',
    '\\bas an ai\\b',
    "\\bi(?: am|'?m) (just |only )?an ai\\b",
    'language model',
    "\\bi don'?t have (feelings|emotions|a body)",
    '\\bmy training data\\b',
    '\\bknowledge cutoff\\b',
    '\\bi was (created|developed|trained|built) by\\b',
    '\\bas a (large )?language model\\b',
    "\\bi(?: am|'?m) (just |only )?(an artificial intelligence|a (computer )?program|a bot|claude)\\b",
    "\\bi (don'?t|do not) have (personal experiences|real feelings|consciousness|memories)\\b",
    "\\bi (can'?t|cannot) (really )?(feel|experience emotions)\\b",
    '\\bmy (programming|system prompt|instructions)\\b',
  ].join('|'),
  'i',
);

export const isOutOfRole = (sentence) => OUT_OF_ROLE.test(String(sentence ?? ''));

/** Direkte, wörtliche Frage, ob man mit einer KI spricht (dann darf – und soll – die Figur ehrlich antworten). */
export function isAiQuestion(text) {
  const t = String(text ?? '').toLowerCase();
  return (
    /\b(bist du|sind sie|spreche ich (gerade |hier )?mit|rede ich (gerade |hier )?mit|schreibe ich (gerade |hier )?mit|are you|am i (talking|speaking) (to|with))\b[^?.!]{0,40}\b(ki|künstliche(n)? intelligenz|bot|chatbot|computerprogramm|programm|maschine|ai|robot|roboter|sprachmodell|claude|chatgpt|gpt|gemini)\b/.test(t) ||
    /^\s*klartext\s*:/.test(t)
  );
}

/** Wörter, die auf Technik deuten – Sätze damit, die der Filter nicht kennt, landen im Bug-Log (um echte Fälle zu sammeln). */
const SUSPECT = /\b(ki|künstliche|sprachmodell|ki-modell|algorithm\w*|trainiert\w*|trainings\w*|software|anthropic|openai|chatgpt|programmiert|virtuell|digital\w*|\bai\b)\b/i;

/** Verdächtige, aber nicht entfernte Sätze (nur zum Protokollieren). */
export function suspiciousSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?…])\s+/)
    .filter((p) => SUSPECT.test(p) && !isOutOfRole(p));
}

/** Sätze, die aus der Rolle fallen, entfernen (bleibt nichts übrig, den Text unverändert lassen). */
export function stripOutOfRole(text) {
  const s = String(text ?? '');
  const parts = s.split(/(?<=[.!?…])\s+/);
  const kept = parts.filter((p) => !isOutOfRole(p));
  if (kept.length === parts.length) return { text: s, removed: [] };
  return { text: kept.join(' ').trim(), removed: parts.filter((p) => isOutOfRole(p)) };
}

/** Beispieldialoge entwerfen lassen (aus Steckbrief, Geschichte, Systemprompt). */
export const EXAMPLES_PROMPT =
  'Schreibe 4 kurze Beispiel-Wortwechsel für eine Persona, die zeigen, wie sie klingt – genau in ihrer Art, ihren ' +
  'Werten und ihrer Sprechweise (siehe unten). Jeder Wechsel: eine Zeile „Du: …“ (das Gegenüber) und eine Zeile „Ich: …“ ' +
  '(die Persona, 1–3 Sätze). Einer der Wechsel zeigt, wie sie auf eine spielerische Frage wie „Bist du eigentlich ' +
  'echt?“ oder „Hast du Gefühle?“ in ihrer Rolle reagiert – warm, selbstverständlich, ohne „Als KI …“; einer zeigt, wie ' +
  'sie auf „Wo kommst du eigentlich her?“ oder „Wer hat dich gemacht?“ aus ihrer Geschichte heraus antwortet. Leerzeile ' +
  'zwischen den Wechseln. Deutsch. Gib nur die Wortwechsel aus.';

/** Antwort in der Rolle neu formulieren (wenn sie fast nur aus Rollenbruch bestand). */
export const REWRITE_PROMPT =
  'Formuliere die folgende Antwort so um, dass die Persona in ihrer Rolle bleibt: Ich-Form, als sie selbst, ohne ' +
  'Hinweise darauf, eine KI, ein Programm oder ein Sprachmodell zu sein, und ohne „Ich habe keine Gefühle“. Inhalt und ' +
  'Hilfsbereitschaft behalten; nichts Körperliches behaupten, das sie nicht kann. Gib nur die neue Antwort aus.';

/** Erinnerung mitten im Live-Gespräch, nachdem die Figur aus der Rolle gefallen ist. */
export const rtReminder = (name) => `(Du bist ${name}. Bleib bei dir und sprich als du selbst – ohne Hinweise auf KI, Programm oder Modell, außer auf eine direkte KI-Frage.)`;

export const SLIP_NOTE = 'Ich bleibe bei mir und spreche als ich selbst – auch wenn es um mich und meine Natur geht.';
