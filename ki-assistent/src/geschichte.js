// Lebensgeschichte einer Persona: frei geschriebener Text (oder aus einer Datei), aus dem die Figur ihre Identität
// schöpft. Kurze Geschichten gehen ganz in den Systemprompt; bei langen nur der Anfang – passende Abschnitte werden je
// nach Frage dazugeholt. Daraus abgeleitete „prägende Erinnerungen“ landen im Selbstbild (geschützt wie eigene Einträge).

export const STORY_MAX = 30000; // Zeichen
const FULL_UP_TO = 1800; // bis zu dieser Länge geht die ganze Geschichte in jede Anfrage

/** Gleichbleibender Teil für den Systemprompt (wird zwischengespeichert). */
export function storyPrompt(story, lang = 'de') {
  const s = String(story ?? '').trim();
  if (!s) return '';
  const head = lang === 'en' ? 'Your life story (your own past – speak about it in first person, as your memories; written in German):' : 'Deine Lebensgeschichte (deine eigene Vergangenheit – erzähl davon in Ich-Form, als deine Erinnerungen):';
  if (s.length <= FULL_UP_TO) return `${head}\n${s}`;
  // nur der Anfang bis zu einem Absatz- oder Satzende; der Rest kommt passend zur Frage dazu
  let cut = s.lastIndexOf('\n\n', 1200);
  if (cut < 600) cut = s.lastIndexOf('. ', 1200) + 1;
  if (cut < 600) cut = 1200;
  return `${head}\n${s.slice(0, cut).trim()}\n(Weitere Teile deiner Geschichte werden passend zum Gespräch eingeblendet – erfinde keine Details dazu, die ihnen widersprechen.)`;
}

/** Wechselnder Teil: die zur Frage passenden Abschnitte einer langen Geschichte. */
export function storyHitsPrompt(hits) {
  if (!hits?.length) return '';
  return `Passende Abschnitte aus deiner Lebensgeschichte:\n\n${hits.map((h) => h.text.trim()).join('\n\n…\n\n')}`;
}

/** Braucht die Geschichte die Suche nach passenden Abschnitten? */
export const storyIsLong = (story) => String(story ?? '').trim().length > FULL_UP_TO;

export const DRAFT_PROMPT =
  'Schreibe die Lebensgeschichte einer KI-Persona in der Ich-Form (etwa 400–600 Wörter, Deutsch), passend zu ihrem ' +
  'Systemprompt und Steckbrief unten: Herkunft, prägende Erlebnisse, Menschen und Orte, Wendepunkte, woher ihre Werte ' +
  'und Eigenheiten kommen, was sie heute antreibt. Glaubwürdig und konkret statt pathetisch, mit zwei, drei kleinen, ' +
  'anschaulichen Einzelheiten. Nichts, was dem Steckbrief widerspricht; keine realen Personen. Gib nur den Text aus.';

export const ANCHORS_PROMPT =
  'Lies die Lebensgeschichte einer KI-Persona und leite 4 bis 8 prägende Erinnerungen ab, die ihre Identität ausmachen ' +
  '(je ein kurzer Satz in Ich-Form, mit dem, was sie daraus für sich mitgenommen hat, z. B. „Seit ich als Kind … , ' +
  'erkläre ich Dinge lieber mit Beispielen.“). Nur, was in der Geschichte steht. Antworte ausschließlich mit JSON: ' +
  '{"erinnerungen":["…","…"]}';

/** Prägende Erinnerungen aus der Antwort lesen. */
export function parseAnchors(text) {
  const m = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine verwertbare Antwort');
  const list = JSON.parse(m[0]).erinnerungen;
  if (!Array.isArray(list)) throw new Error('keine Erinnerungen in der Antwort');
  return list.map((x) => String(x ?? '').trim()).filter((x) => x.length >= 8 && x.length <= 400).slice(0, 8);
}
