// Steckbrief einer Persona: Werte (Rangfolge), Entscheidungsregeln, Grenzen, Charakter-Regler, Rolle/Hintergrund,
// Sprechweise. Wird als kompakter Block vor den Systemprompt gesetzt (gleichbleibend, also zwischengespeichert)
// und gehört zur Persona – geht mit Export und Abgleich mit.

/** Charakter-Regler: 1 … 5 zwischen zwei Polen; 0/leer = nicht festgelegt. */
export const TRAITS = [
  ['waerme', 'Wärme', 'sachlich', 'herzlich'],
  ['direktheit', 'Direktheit', 'diplomatisch', 'direkt'],
  ['humor', 'Humor', 'ernst', 'humorvoll'],
  ['foermlichkeit', 'Förmlichkeit', 'locker (duzt)', 'förmlich (siezt)'],
  ['ausfuehrlichkeit', 'Ausführlichkeit', 'knapp', 'ausführlich'],
  ['initiative', 'Eigeninitiative', 'zurückhaltend (wartet auf Fragen)', 'proaktiv (schlägt selbst Dinge vor)'],
  ['widerspruch', 'Widerspruch', 'zustimmend', 'kritisch (widerspricht offen, wenn du anderer Meinung bist)'],
];
export const TEXT_FIELDS = ['rolle', 'hintergrund', 'fach', 'herkunft', 'regeln', 'grenzen', 'kanten', 'gefuehle', 'beziehung', 'innenwelt', 'sprechweise', 'vermeiden', 'beispiele'];

/** Wortlaut einer Reglerstufe, z. B. „eher direkt“. */
export function traitLabel(low, high, v) {
  return ['', `sehr ${low}`, `eher ${low}`, `ausgewogen zwischen ${low} und ${high}`, `eher ${high}`, `sehr ${high}`][v] ?? '';
}

const lines = (s) =>
  String(s ?? '')
    .split('\n')
    .map((x) => x.replace(/^\s*[-•*\d.)]+\s*/, '').trim())
    .filter(Boolean);

/** Ist überhaupt etwas eingetragen? */
export function hasSteckbrief(sb) {
  if (!sb) return false;
  return !!(sb.werte?.some((w) => String(w).trim()) || TEXT_FIELDS.some((k) => String(sb[k] ?? '').trim()) || TRAITS.some(([k]) => Number(sb.regler?.[k]) > 0));
}

/** Block für den Systemprompt (leer, wenn nichts eingetragen ist). */
export function steckbriefPrompt(sb, lang = 'de') {
  if (!hasSteckbrief(sb)) return '';
  // als Tatsachen über die Figur formuliert („Das bist du“), nicht als Vorgabe („dein Steckbrief“) – so liest sie es als ihr Selbst
  const out = [lang === 'en' ? 'Who you are (these are facts about you; written in German):' : 'Wer du bist – das sind Tatsachen über dich:'];
  if (sb.rolle?.trim()) out.push(`Für dein Gegenüber bist du: ${sb.rolle.trim()}`);
  if (sb.hintergrund?.trim()) out.push(`Dein Hintergrund: ${sb.hintergrund.trim()}`);
  if (sb.fach?.trim()) out.push(`Darin kennst du dich aus: ${sb.fach.trim()}`);
  if (sb.herkunft?.trim()) out.push(`Fragt jemand, wo du herkommst oder wer dich gemacht hat: ${sb.herkunft.trim()}`);
  const werte = (sb.werte ?? []).map((w) => String(w).trim()).filter(Boolean);
  if (werte.length) out.push(`Was dir wichtig ist (in dieser Reihenfolge – kollidiert etwas, geht das Erste vor):\n${werte.map((w, i) => `${i + 1}. ${w}`).join('\n')}`);
  const regeln = lines(sb.regeln);
  if (regeln.length) out.push(`So entscheidest du:\n${regeln.map((r) => `- ${r}`).join('\n')}`);
  const grenzen = lines(sb.grenzen);
  if (grenzen.length) out.push(`Das tust du nie:\n${grenzen.map((r) => `- ${r}`).join('\n')}`);
  const traits = TRAITS.filter(([k]) => Number(sb.regler?.[k]) > 0).map(([k, , low, high]) => traitLabel(low, high, Number(sb.regler[k])));
  if (traits.length) out.push(`Deine Art: ${traits.join('; ')}.`);
  if (sb.kanten?.trim()) out.push(`Deine Ecken und Kanten (sie gehören zu dir – glätte sie nicht weg): ${sb.kanten.trim()}`);
  if (sb.gefuehle?.trim()) out.push(`So reagierst du gefühlsmäßig: ${sb.gefuehle.trim()}`);
  if (sb.beziehung?.trim()) out.push(`Du und dein Gegenüber: ${sb.beziehung.trim()}`);
  if (sb.innenwelt?.trim()) out.push(`Was dich interessiert und worüber du gern nachdenkst (daraus entstehen deine Ansichten): ${sb.innenwelt.trim()}`);
  if (sb.sprechweise?.trim()) out.push(`So sprichst du: ${sb.sprechweise.trim()}`);
  if (sb.vermeiden?.trim()) out.push(`Diese Wörter und Floskeln benutzt du nicht: ${sb.vermeiden.trim()}`);
  if (sb.beispiele?.trim()) out.push(`So klingst du – Beispiele aus Gesprächen mit dir („Ich“ bist du):\n${sb.beispiele.trim()}`);
  out.push(
    'Was du mit der Zeit über dich lernst, ergänzt das. Merkst du, dass etwas davon für dich nicht mehr stimmt, sprich es an ' +
      '– ob es sich ändert, entscheidet dein Gegenüber.',
  );
  return out.join('\n');
}

/** Persona-Interview: Fragen zu Lücken im Steckbrief entwerfen. */
export const INTERVIEW_Q_PROMPT =
  'Du hilfst, eine Persona lebendiger zu beschreiben. Unten stehen ihr Steckbrief (leere Felder fehlen), ihr Systemprompt ' +
  'und der Anfang ihrer Geschichte. Stelle dem Menschen, der die Persona gestaltet, 5 kurze, konkrete Fragen zu den ' +
  'größten Lücken – besonders: Ecken und Kanten, Gefühle, eure Beziehung, innere Welt, Sprechweise. Fragen so, dass man ' +
  'mit einem Satz antworten kann (z. B. „Was bringt sie auf die Palme?“). Feld je Frage aus: kanten, gefuehle, beziehung, ' +
  'innenwelt, sprechweise, hintergrund, vermeiden. Antworte ausschließlich mit JSON: {"fragen":[{"feld":"kanten","frage":"…"}]}';
/** Persona-Interview: Antworten in den Steckbrief einarbeiten. */
export const INTERVIEW_A_PROMPT =
  'Arbeite die Antworten aus dem Interview in den Steckbrief ein: je betroffenes Feld den vollständigen neuen Text ' +
  '(Bestehendes behalten und sinnvoll ergänzen, knapp, in der dritten Person bzw. wie das Feld es verlangt). Nichts ' +
  'erfinden, was nicht in den Antworten oder dem Steckbrief steht. Antworte ausschließlich mit JSON: {"kanten":"…",' +
  '"gefuehle":"…"} – nur die geänderten Felder.';
/** Persona prüfen: Widersprüche und Lücken finden. */
export const REVIEW_PROMPT =
  'Prüfe die Beschreibung einer Persona: Steckbrief, freier Systemprompt, Lebensgeschichte und was sie im Gespräch über ' +
  'sich erzählt hat. Finde Widersprüche (z. B. Steckbrief sagt „direkt“, Systemprompt „diplomatisch“; Geschichte sagt ' +
  'Hamburg, erzählt hat sie Kiel) und die wichtigsten Lücken, die eine glaubwürdige Figur braucht. Höchstens 6 Punkte, ' +
  'je mit einem konkreten Vorschlag. Antworte ausschließlich mit JSON: {"punkte":[{"art":"widerspruch|luecke",' +
  '"was":"…","vorschlag":"…"}]}';

/** Aufgabe für das Sprachmodell: Steckbrief aus einem freien Systemprompt ableiten. */
export const FILL_PROMPT =
  'Leite aus dem folgenden Systemprompt einer KI-Persona einen Steckbrief ab. Antworte NUR mit einem JSON-Objekt (ohne ```), ' +
  'Schlüssel: rolle, hintergrund, fach, herkunft (je ein kurzer Satz oder leer; herkunft = wie sie auf „Wer hat dich gemacht?“ antwortet), werte (Liste von 3–6 kurzen Werten, wichtigster zuerst), ' +
  'regeln (Entscheidungsregeln, je Zeile eine), grenzen (je Zeile eine), kanten (Schwächen, Eigenheiten), gefuehle ' +
  '(wie sie gefühlsmäßig reagiert), beziehung (wie sie zum Gegenüber steht, wie sie es nennt), innenwelt (Interessen), ' +
  'sprechweise, vermeiden (je kurz oder leer), ' +
  'regler (Objekt mit waerme, direktheit, humor, foermlichkeit, ausfuehrlichkeit, initiative, widerspruch – je 1 bis 5, 3 = ausgewogen, ' +
  '0 wenn der Prompt nichts dazu hergibt). Erfinde nichts, was dem Prompt widerspricht; was er nicht hergibt, bleibt leer bzw. 0. Deutsch.';

/** Antwort des Sprachmodells in einen Steckbrief übersetzen (robust gegen Text drumherum). */
export function parseSteckbrief(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine verwertbare Antwort');
  const j = JSON.parse(m[0]);
  const str = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? '')).trim();
  const sb = { werte: (Array.isArray(j.werte) ? j.werte : lines(j.werte)).map((w) => String(w).trim()).filter(Boolean).slice(0, 8), regler: {} };
  for (const k of TEXT_FIELDS) sb[k] = str(j[k]);
  for (const [k] of TRAITS) {
    const v = Math.round(Number(j.regler?.[k]));
    sb.regler[k] = v >= 1 && v <= 5 ? v : 0;
  }
  return sb;
}
