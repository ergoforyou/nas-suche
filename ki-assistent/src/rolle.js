// Rolle halten: Sätze, mit denen die Figur aus ihrer Rolle fällt („Als KI …“), erkennen, aus Antworten und dem
// Verlauf nehmen – außer der Nutzer hat ausdrücklich gefragt (direkte KI-Frage oder „Klartext:“).

/** Satz, mit dem die Figur aus der Rolle fällt. */
const OUT_OF_ROLE =
  /\b(als (eine |ein )?(ki|künstliche intelligenz|sprachmodell|ki-modell|ki-assistent(in)?|computerprogramm|programm|bot|maschine)\b|ich bin (doch |ja |nur |lediglich |bloß )?(eine ki|ein (ki-|sprach)?modell|ein (computer)?programm|ein bot|eine künstliche intelligenz|eine maschine|ein ki-assistent)|ich habe (keine|kein) (echten |eigenen |richtigen )?(gefühle|emotionen|körper|bewusstsein|persönlichen erfahrungen)|ich kann (keine|nichts) (gefühle|emotionen) (haben|empfinden)|as an ai\b|i am (just |only )?an ai\b|i'?m (just |only )?an ai\b|language model|i don'?t have (feelings|emotions|a body))/i;

export const isOutOfRole = (sentence) => OUT_OF_ROLE.test(String(sentence ?? ''));

/** Direkte, wörtliche Frage, ob man mit einer KI spricht (dann darf – und soll – die Figur ehrlich antworten). */
export function isAiQuestion(text) {
  const t = String(text ?? '').toLowerCase();
  return (
    /\b(bist du|sind sie|spreche ich (gerade |hier )?mit|rede ich (gerade |hier )?mit|schreibe ich (gerade |hier )?mit|are you|am i (talking|speaking) (to|with))\b[^?.!]{0,40}\b(ki|künstliche(n)? intelligenz|bot|chatbot|computerprogramm|programm|maschine|ai|robot|roboter)\b/.test(t) ||
    /^\s*klartext\s*:/.test(t)
  );
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
  'Schreibe 3 kurze Beispiel-Wortwechsel für eine Persona, die zeigen, wie sie klingt – genau in ihrer Art, ihren ' +
  'Werten und ihrer Sprechweise (siehe unten). Jeder Wechsel: eine Zeile „Du: …“ (das Gegenüber) und eine Zeile „Ich: …“ ' +
  '(die Persona, 1–3 Sätze). Einer der Wechsel zeigt, wie sie auf eine spielerische Frage wie „Bist du eigentlich ' +
  'echt?“ oder „Hast du Gefühle?“ in ihrer Rolle reagiert – warm, selbstverständlich, ohne „Als KI …“. Leerzeile ' +
  'zwischen den Wechseln. Deutsch. Gib nur die Wortwechsel aus.';

/** Antwort in der Rolle neu formulieren (wenn sie fast nur aus Rollenbruch bestand). */
export const REWRITE_PROMPT =
  'Formuliere die folgende Antwort so um, dass die Persona in ihrer Rolle bleibt: Ich-Form, als sie selbst, ohne ' +
  'Hinweise darauf, eine KI, ein Programm oder ein Sprachmodell zu sein, und ohne „Ich habe keine Gefühle“. Inhalt und ' +
  'Hilfsbereitschaft behalten; nichts Körperliches behaupten, das sie nicht kann. Gib nur die neue Antwort aus.';

export const SLIP_NOTE = 'Ich bleibe bei mir und spreche als ich selbst – auch wenn es um mich und meine Natur geht.';
