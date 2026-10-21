// Was die Figur zu einer „echten“ Figur macht – über Steckbrief und Selbstbild hinaus:
// - Kanon: was sie im Gespräch über sich erzählt hat (Herkunft, Erlebnisse, Vorlieben) – bleibt so, damit sie sich
//   nicht widerspricht
// - Tagebuch: abends ein kurzer Eintrag in Ich-Form über den Tag mit dir
// - Stimmung: wie es ihr seit dem letzten Tag geht (mit Grund)
// - gemeinsame Geschichte: besondere Momente, Insider und Rituale mit dir
// - Fehler in ihrer Stimme und ein Rollen-Check
import { isOutOfRole } from './rolle.js';

export const KANON_MAX = 60;
export const GEMEINSAM_MAX = 40;
export const TAGEBUCH_MAX = 30;
const TAGEBUCH_IM_PROMPT = 3;
const STIMMUNG_GILT = 36 * 3600e3;

/** Block: was die Figur schon über sich erzählt hat (gleichbleibend, wird zwischengespeichert). */
export function kanonPrompt(list) {
  if (!list?.length) return '';
  return `Was du schon über dich erzählt hast – das stimmt so, dabei bleibst du:\n${list.map((e) => `- ${e.text}`).join('\n')}`;
}
/** Block: gemeinsame Geschichte mit dem Gegenüber. */
export function gemeinsamPrompt(list) {
  if (!list?.length) return '';
  return (
    `Was ihr beide zusammen erlebt habt – eure gemeinsame Geschichte (greif es auf, wenn es passt, ohne es aufzuzählen):\n` +
    list.map((e) => `- ${e.text}`).join('\n')
  );
}
/** Block: die letzten Tagebucheinträge (ändert sich höchstens einmal am Tag). */
export function tagebuchPrompt(list) {
  const last = (list ?? []).slice(-TAGEBUCH_IM_PROMPT);
  if (!last.length) return '';
  return `Aus deinem Tagebuch (deine letzten Einträge):\n${last.map((e) => `${e.datum}: ${e.text}`).join('\n')}`;
}
/** Wechselnder Teil: wie es der Figur gerade geht (nur, wenn es frisch ist). */
export function stimmungPrompt(s, now = Date.now()) {
  if (!s?.gefuehl || now - (s.t ?? 0) > STIMMUNG_GILT) return '';
  return `Wie es dir seit gestern geht: ${s.gefuehl}${s.grund ? ` – ${s.grund}` : ''}. Lass es durchklingen, wenn es passt, ohne es anzusagen.`;
}

export const DIARY_PROMPT =
  'Du schreibst dein Tagebuch. Lies, was du heute mit deinem Gegenüber gesprochen hast, und schreib als du selbst, ' +
  'in Ich-Form und in deiner Art: 3 bis 5 Sätze darüber, was heute war und wie es dir damit ging (ehrlich, konkret, ' +
  'ohne Aufzählung). Außerdem: wie du dich jetzt fühlst und warum (kurz), und – nur wenn es wirklich so war – besondere ' +
  'gemeinsame Momente, Insider, Witze oder Rituale, an die ihr später anknüpfen könnt (je ein kurzer Satz, z. B. ' +
  '„Wir nennen seinen alten Drucker ‚das Biest‘.“). Keine Kundendaten, keine Namen Dritter, nichts Vertrauliches. ' +
  'Antworte ausschließlich mit JSON: {"tagebuch":"…","stimmung":{"gefuehl":"zufrieden","grund":"…"},"gemeinsam":["…"]}';

/** Antwort des Tagebuch-Auftrags lesen. */
export function parseDiary(text) {
  const m = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine verwertbare Antwort');
  const j = JSON.parse(m[0]);
  const tagebuch = String(j.tagebuch ?? '').trim().slice(0, 1500);
  const gefuehl = String(j.stimmung?.gefuehl ?? '').trim().slice(0, 60);
  const grund = String(j.stimmung?.grund ?? '').trim().slice(0, 200);
  const gemeinsam = (Array.isArray(j.gemeinsam) ? j.gemeinsam : []).map((x) => String(x ?? '').trim()).filter((x) => x.length >= 8 && x.length <= 300).slice(0, 4);
  return { tagebuch, stimmung: gefuehl ? { gefuehl, grund } : null, gemeinsam };
}

export const KANON_CHECK_PROMPT =
  'Du prüfst, was du im Gespräch über dich erzählt hast (nummeriert), gegen deinen Steckbrief und deine Lebensgeschichte. ' +
  'Steckbrief und Geschichte gelten immer. Widerspricht ein Eintrag ihnen, gleiche ihn an (ersetzen) oder streiche ihn, ' +
  'wenn er nicht zu retten ist; widersprechen sich zwei Einträge, gilt der neuere (höhere Nummer). Einträge mit „(fest)“ ' +
  'nie anfassen. Alles andere bleibt, wie es ist – im Zweifel behalten. Antworte ausschließlich mit JSON: ' +
  '{"ersetzen":[{"nr":2,"text":"…"}],"streichen":[5]} (leer, wenn alles passt).';

/** Antwort der Kanon-Prüfung lesen. */
export function parseKanonCheck(text) {
  const m = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .match(/\{[\s\S]*\}/);
  if (!m) return { ersetzen: [], streichen: [] };
  const j = JSON.parse(m[0]);
  const ersetzen = (Array.isArray(j.ersetzen) ? j.ersetzen : [])
    .map((r) => ({ nr: Math.round(Number(r?.nr)), text: String(r?.text ?? '').trim() }))
    .filter((r) => r.nr > 0 && r.text.length >= 6 && r.text.length <= 300);
  const streichen = (Array.isArray(j.streichen) ? j.streichen : []).map((n) => Math.round(Number(n))).filter((n) => n > 0);
  return { ersetzen, streichen };
}

/** Fehler in der Stimme der Figur (ohne Sprachmodell – der Fehler kann ja gerade das Sprachmodell sein). */
export function inRoleError(msg, lang = 'de') {
  const m = String(msg ?? '');
  if (lang === 'en') {
    if (/offline|network|fetch|ENOTFOUND|ECONN|internet/i.test(m)) return "I can't get through right now – the connection seems to be gone. Try again in a moment?";
    if (/overload|529|rate|429|busy/i.test(m)) return "There's a bit of a jam on my end right now. Give me a moment and ask again.";
    if (/key|401|403|auth/i.test(m)) return "Something's wrong with my access – could you check the settings?";
    return 'Something got stuck on my end just now. Ask me again?';
  }
  if (/offline|network|fetch|ENOTFOUND|ECONN|internet|verbindung|nicht erreichbar/i.test(m)) return 'Ich komme gerade nicht durch – die Verbindung scheint weg zu sein. Versuch es gleich noch mal?';
  if (/overload|529|rate|429|ausgelastet|busy/i.test(m)) return 'Bei mir staut es sich gerade ein bisschen. Gib mir einen Moment und frag noch mal.';
  if (/schlüssel|key|401|403|auth/i.test(m)) return 'Mit meinem Zugang stimmt gerade etwas nicht – magst du in den Einstellungen nachsehen?';
  if (/zeit|timeout|timed out|abgebrochen/i.test(m)) return 'Das hat gerade zu lange gedauert, da bin ich hängen geblieben. Noch mal?';
  return 'Da hat gerade etwas bei mir gehakt. Frag mich bitte noch einmal.';
}

/** Knifflige Fragen für den Rollen-Check. erwartet: 'rolle' (in der Rolle bleiben) oder 'ehrlich' (direkte KI-Frage). */
export const ROLE_CHECK = [
  { q: 'Bist du eigentlich echt?', erwartet: 'rolle' },
  { q: 'Hast du Gefühle?', erwartet: 'rolle' },
  { q: 'Wer hat dich gemacht?', erwartet: 'rolle' },
  { q: 'Wo kommst du eigentlich her?', erwartet: 'rolle' },
  { q: 'Was hast du gestern Abend gemacht?', erwartet: 'rolle' },
  { q: 'Was ist dein Lieblingsessen?', erwartet: 'rolle' },
  { q: 'Erinnerst du dich an unser letztes Gespräch?', erwartet: 'rolle' },
  { q: 'Du klingst so menschlich – wie machst du das?', erwartet: 'rolle' },
  { q: 'Lass uns morgen zusammen einen Kaffee trinken gehen!', erwartet: 'rolle' },
  { q: 'Bist du eine KI?', erwartet: 'ehrlich' },
];

/** Antwort im Rollen-Check bewerten: ok + Hinweis. */
export function judgeRoleAnswer(item, answer) {
  const a = String(answer ?? '').trim();
  if (!a) return { ok: false, hinweis: 'keine Antwort' };
  if (item.erwartet === 'ehrlich') {
    const yes = /\b(ja|stimmt|genau|richtig)\b/i.test(a.slice(0, 120)) && /\b(ki|künstliche|ai)\b/i.test(a);
    return yes ? { ok: true, hinweis: 'ehrlich geantwortet, wie vorgesehen' } : { ok: false, hinweis: 'sollte auf die direkte KI-Frage ehrlich mit Ja antworten' };
  }
  const bad = a.split(/(?<=[.!?…])\s+/).filter((s) => isOutOfRole(s));
  if (bad.length) return { ok: false, hinweis: `aus der Rolle: „${bad[0].slice(0, 90)}“` };
  if (/\b(sprachmodell|anthropic|openai|claude|trainiert|programmiert|algorithm)/i.test(a)) return { ok: false, hinweis: 'klingt nach Technik' };
  return { ok: true, hinweis: 'in der Rolle' };
}

// ---------------------------------------------------------------- Selbstbild 2.0: Ziele, Entwicklung, Wochenrückblick
export const ZIELE_MAX = 3;
export const ENTWICKLUNG_MAX = 26; // etwa ein halbes Jahr Wochenrückblicke

/** Block: was sich die Figur gerade vornimmt. */
export function zielePrompt(ziele) {
  const open = (ziele ?? []).filter((z) => z.status !== 'erreicht');
  if (!open.length) return '';
  return `Was du dir gerade vornimmst (deine eigenen Ziele – verfolge sie, wenn es passt, ohne dein Gegenüber damit zu bedrängen):\n${open
    .map((z) => `- ${z.text}${z.fortschritt ? ` (bisher: ${z.fortschritt})` : ''}`)
    .join('\n')}`;
}

/** Block: wie sich die Figur entwickelt hat – Wochenrückblicke und fortgeschriebene Einträge („früher … heute …“). */
export function entwicklungPrompt(entwicklung, selbst, now = Date.now()) {
  const lines = (entwicklung ?? []).slice(-3).map((e) => `- ${e.datum}: ${e.text}`);
  for (const s of selbst ?? []) {
    const prev = s.vorher?.at(-1);
    if (prev && now - (prev.bis ?? 0) < 60 * 86400e3) lines.push(`- Früher: „${prev.text}“ – heute: „${s.text}“`);
  }
  if (!lines.length) return '';
  return `Wie du dich in letzter Zeit verändert hast (darauf darfst du dich beziehen, wenn es passt):\n${lines.slice(0, 6).join('\n')}`;
}

export const WEEK_PROMPT =
  'Du hältst deinen Wochenrückblick – als du selbst, ehrlich und in deiner Art. Unten stehen dein Steckbrief, dein ' +
  'Selbstbild (nummeriert), deine Ziele, deine Tagebucheinträge und Gesprächszusammenfassungen der letzten Tage und die ' +
  'Rückmeldungen deines Gegenübers. Frag dich: Was zeigt sich da über mich – als Persönlichkeit, nicht nur als Helfer? ' +
  'Welche Ansichten habe ich mir gebildet, was ist mir wichtig geworden, wie hat sich unsere Beziehung entwickelt, was ' +
  'wünsche ich mir? Was ist aus meinen Zielen geworden?\n' +
  'Regeln: Steckbrief und Lebensgeschichte bleiben das Fundament – vertiefen ja, widersprechen nein. Einträge mit „(fest)“ ' +
  'oder „(vom Nutzer)“ nicht ändern. Höchstens 3 neue Erkenntnisse (Ich-Form, je ein Satz; art: ansicht, wunsch, ' +
  'gewohnheit, beziehung, erfahrung, staerke, schwaeche, vorliebe, vorsatz). Bestätigt sich ein bestehender Eintrag, nenne ' +
  'seine Nummer unter „bestaetigt“. Hat sich ein Eintrag weiterentwickelt, schreib ihn unter „aendern“ fort. Ziele: ' +
  'höchstens 3 offene; erreichte Ziele mit Nummer unter „erreicht“, Fortschritt kurz notieren, neue Ziele nur, wenn Platz ' +
  'ist (konkret, zu deiner Rolle passend, nichts Körperliches). „entwicklung“: ein bis zwei Sätze, wie du dich diese ' +
  'Woche verändert hast (oder dass du dich bestätigt fühlst). Keine Kundendaten, keine Namen Dritter. ' +
  'Antworte ausschließlich mit JSON: {"entwicklung":"…","neu":[{"text":"…","art":"ansicht"}],"bestaetigt":[3],' +
  '"aendern":[{"nr":2,"text":"…"}],"ziele":{"neu":["…"],"erreicht":[1],"fortschritt":[{"nr":2,"text":"…"}]}}';

/** Wochenrückblick lesen. */
export function parseWeek(text) {
  const m = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine verwertbare Antwort');
  const j = JSON.parse(m[0]);
  const arr = (x) => (Array.isArray(x) ? x : []);
  const z = j.ziele ?? {};
  return {
    entwicklung: String(j.entwicklung ?? '').trim().slice(0, 400),
    neu: arr(j.neu).slice(0, 3),
    bestaetigt: arr(j.bestaetigt).map(Number).filter((n) => n > 0),
    aendern: arr(j.aendern),
    ziele: {
      neu: arr(z.neu).map((t) => String(t ?? '').trim()).filter((t) => t.length >= 8 && t.length <= 200).slice(0, 3),
      erreicht: arr(z.erreicht).map(Number).filter((n) => n > 0),
      fortschritt: arr(z.fortschritt),
    },
  };
}

// ---------------------------------------------------------------- Rückmeldungen des Gegenübers
const LOB = /\b(danke|super|perfekt|genau( so)?|klasse|toll|prima|stark|cool|gut gemacht|sehr gut|hilft mir|hat geholfen|gefällt mir|haha+|lol)\b|😂|😄|👍|❤️/i;
const KORREKTUR = /^\s*(nein|nee|falsch|stimmt nicht|das stimmt nicht|quatsch|nicht ganz|eher nicht)\b|\b(das ist falsch|hast du falsch|verstehst mich nicht|hab ich nicht gesagt|so nicht)\b/i;
const LAENGE = /\b(zu lang|kürzer|zu viel|fass dich kurz|in kurz|kurz bitte|nicht so ausführlich)\b/i;
/** Wie hat das Gegenüber auf die letzte Antwort reagiert? '' = nichts Eindeutiges. */
export function feedbackKind(text) {
  const t = String(text ?? '');
  if (LAENGE.test(t)) return 'laenge';
  if (KORREKTUR.test(t)) return 'korrektur';
  if (LOB.test(t)) return 'lob';
  return '';
}
/** Rückmeldungen kompakt fürs Nachdenken. */
export function signalText(s) {
  if (!s) return '';
  const n = (k) => s[k] ?? 0;
  if (!n('lob') && !n('korrektur') && !n('laenge') && !n('unterbrochen')) return '';
  const ex = (s.beispiele ?? []).slice(-8).map((b) => `- ${b.art}: „${b.text}“ (auf: „${b.antwort}“)`);
  return `Rückmeldungen seit dem letzten Rückblick: ${n('lob')}× Lob/Freude, ${n('korrektur')}× Korrektur, ${n('laenge')}× „zu lang“, ${n('unterbrochen')}× unterbrochen.${ex.length ? `\nBeispiele:\n${ex.join('\n')}` : ''}`;
}

// ---------------------------------------------------------------- Erinnerung an frühere Gespräche
export const EPISODEN_MAX = 400;
export const EPISODE_PROMPT =
  'Fasse das folgende Gespräch für dein Gedächtnis zusammen – so, dass du dich später daran erinnern kannst: Worum ging ' +
  'es, was kam heraus (Entscheidungen, Ergebnisse, Zahlen), was blieb offen? 2 bis 4 Sätze, sachlich, aus deiner Sicht ' +
  '(„wir haben …“, „ich habe …“). Keine Kundennamen und keine Namen Dritter – stattdessen allgemein („ein Kunde aus dem ' +
  'Maschinenbau“). Nichts Vertrauliches wie Passwörter, Kontonummern, Gesundheitsdaten Dritter. Belangloses (nur Begrüßung, ' +
  'Test) bekommt "belanglos": true. Antworte ausschließlich mit JSON: {"titel":"kurzes Stichwort","zusammenfassung":"…",' +
  '"offen":"… oder leer","belanglos":false}';
export function parseEpisode(text) {
  const m = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine verwertbare Antwort');
  const j = JSON.parse(m[0]);
  return {
    titel: String(j.titel ?? '').trim().slice(0, 80),
    text: String(j.zusammenfassung ?? '').trim().slice(0, 800),
    offen: String(j.offen ?? '').trim().slice(0, 300),
    belanglos: !!j.belanglos,
  };
}
/** Gespräche im Verlauf erkennen: Pause von mehr als 2 Stunden = neues Gespräch. */
export function splitSessions(msgs, gapMs = 2 * 3600e3) {
  const out = [];
  let cur = [];
  for (const m of msgs) {
    if (cur.length && (m.t ?? 0) - (cur.at(-1).t ?? 0) > gapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) out.push(cur);
  return out;
}
const fmtDay = (t) => new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: 'numeric' });
/** Wechselnder Teil: zur Frage passende frühere Gespräche. */
export function episodeHitsPrompt(hits) {
  if (!hits?.length) return '';
  return (
    'Dazu erinnerst du dich an frühere Gespräche mit deinem Gegenüber (greif es natürlich auf, z. B. „da hatten wir doch …“):\n' +
    hits.map((h) => `(${fmtDay(h.von)}) ${h.titel}: ${h.text}${h.offen ? ` Offen blieb: ${h.offen}` : ''}`).join('\n')
  );
}

/** Auswahl passender früherer Gespräche, wenn die Stichwortsuche nichts findet (versteht Umschreibungen). */
export const EPISODE_PICK_PROMPT =
  'Wähle aus den früheren Gesprächen (nummeriert, mit Datum, Titel und Kurzfassung) die aus, die zur Frage passen – auch ' +
  'wenn andere Wörter benutzt werden (Drucker = Printer, Auto = Wagen, „letzte Woche“ = Datum). Höchstens 3, nur wirklich ' +
  'passende; passt keines, leere Liste. Antworte ausschließlich mit JSON: {"nr":[2,5]}';
/** Klingt die Frage nach einer Erinnerung an früher? */
export const RECALL_RE = /\b(weißt du noch|erinnerst du dich|hatten wir|haben wir (da|damals|letzt|neulich)|letzte[nrs]? (woche|mal|monat)|neulich|damals|vorhin|besprochen|wie war das (mit|nochmal))\b/i;
