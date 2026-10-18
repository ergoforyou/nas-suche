// Stimmung der Figur aus der Antwort: Das Sprachmodell (Claude, ChatGPT oder lokal in LM Studio) setzt eine kurze
// Marke wie [freudig] an den Anfang der Antwort. Die Marke wird aus Text und Sprachausgabe entfernt und steuert
// Mimik und Kopfhaltung. Hält sich ein (kleines lokales) Modell nicht daran, wird die Stimmung aus Wörtern erraten.

/** Stimmung -> Gesicht: smile (-0.5..1), brow (-1..1), energy (Kopfbewegung), nod (+ = Kopf gesenkt), tilt */
export const MOODS = {
  ruhig: { smile: 0, brow: 0, energy: 1, nod: 0, tilt: 0 },
  freudig: { smile: 0.55, brow: 0.25, energy: 1.45, nod: -0.04, tilt: 0.02 },
  nachdenklich: { smile: -0.1, brow: 0.35, energy: 0.7, nod: -0.02, tilt: 0.045 },
  überrascht: { smile: 0.1, brow: 0.9, energy: 1.3, nod: -0.05, tilt: 0 },
  traurig: { smile: -0.4, brow: 0.3, energy: 0.55, nod: 0.08, tilt: 0.03 },
  ernst: { smile: -0.2, brow: -0.45, energy: 0.8, nod: 0.02, tilt: 0 },
};

const ALIASES = {
  froh: 'freudig', fröhlich: 'freudig', glücklich: 'freudig', happy: 'freudig', joyful: 'freudig', begeistert: 'freudig',
  neutral: 'ruhig', calm: 'ruhig', entspannt: 'ruhig', freundlich: 'ruhig',
  thoughtful: 'nachdenklich', grübelnd: 'nachdenklich', unsicher: 'nachdenklich',
  surprised: 'überrascht', erstaunt: 'überrascht', ueberrascht: 'überrascht',
  sad: 'traurig', betroffen: 'traurig', mitfühlend: 'traurig',
  serious: 'ernst', sachlich: 'ernst', besorgt: 'ernst',
};

const WORDS = [...Object.keys(MOODS), ...Object.keys(ALIASES)].sort((a, b) => b.length - a.length).join('|');
// Marke: [freudig], [Stimmung: freudig], (*[freudig]*) – nur bekannte Wörter, damit Markdown-Links unberührt bleiben
const TAG = new RegExp(`\\**\\[(?:stimmung|mood)?\\s*:?\\s*(${WORDS})\\]\\**[ \\t]*`, 'giu');

// Gesten passend zum Inhalt: das Sprachmodell setzt vor einen Satz eine Marke wie [geste:nicken]; die Figur spielt dazu
// ein kurzes Video (Anlass „Geste: …“). Die Marke wird – wie die Stimmung – aus Text und Sprachausgabe entfernt.
export const GESTURES = {
  nicken: 'nicken (Zustimmung, „ja, genau“)',
  kopfschütteln: 'Kopf schütteln („nein“, „leider nicht“)',
  lachen: 'lachen (Witz, etwas Lustiges)',
  schulterzucken: 'Schulterzucken („keine Ahnung“, „kommt drauf an“)',
  abwägen: 'abwägen mit den Händen („einerseits … andererseits“)',
  aufzählen: 'an den Fingern aufzählen („erstens, zweitens“)',
  zeigen: 'zeigen / hindeuten („schau mal hier“, Ergebnis vorstellen)',
  fragend: 'fragend, Kopf leicht geneigt (wenn du eine Frage stellst)',
};
const GESTURE_ALIASES = { kopfschuetteln: 'kopfschütteln', abwaegen: 'abwägen', aufzaehlen: 'aufzählen', nod: 'nicken', laugh: 'lachen', shrug: 'schulterzucken', point: 'zeigen' };
const GTAG = /\**\[(?:geste|gesture)\s*:\s*([\p{L}-]+)\]\**[ \t]*/giu;
export const normalizeGesture = (w) => {
  const k = String(w ?? '').toLowerCase();
  return GESTURES[k] ? k : GESTURE_ALIASES[k] ?? null;
};
/** Anweisung für das Sprachmodell – nur mit den Gesten, für die es Videos gibt. */
export function gesturePrompt(names, lang = 'de') {
  const list = names.map((n) => (lang === 'en' ? n : GESTURES[n] ?? n)).join('; ');
  return lang === 'en'
    ? `You can show gestures: put an invisible tag like [geste:nicken] right before a sentence it fits. Available: ${list}. ` +
        'Only where it really fits – at most one per sentence and not in every sentence. The user never sees the tags.'
    : `Du kannst Gesten zeigen: setze direkt vor einen passenden Satz eine unsichtbare Marke wie [geste:nicken]. Verfügbar: ${list}. ` +
        'Nur, wo es wirklich passt – höchstens eine pro Satz und nicht in jedem Satz. Die Marken sieht und hört der Nutzer nicht.';
}

export const normalizeMood = (w) => {
  const k = String(w ?? '').toLowerCase();
  return MOODS[k] ? k : ALIASES[k] ?? null;
};

export const MOOD_PROMPT = {
  de:
    'Beginne jede Antwort mit genau einer Stimmungsmarke in eckigen Klammern, passend zu deinem Gefühl beim Antworten: ' +
    '[freudig], [ruhig], [nachdenklich], [überrascht], [traurig] oder [ernst]. Bei einem deutlichen Stimmungswechsel ' +
    'darfst du später eine weitere Marke setzen. Die Marken sieht und hört der Nutzer nicht – erwähne sie nie.',
  en:
    'Start every reply with exactly one mood tag in square brackets that fits how you feel while answering: ' +
    '[freudig] (happy), [ruhig] (calm), [nachdenklich] (thoughtful), [überrascht] (surprised), [traurig] (sad) or ' +
    '[ernst] (serious). If the mood clearly changes you may add another tag later. The user never sees or hears the ' +
    'tags – never mention them.',
};

/** Entfernt Stimmungsmarken aus dem Antwort-Stream und merkt sich die aktuelle Stimmung. */
export class MoodFilter {
  constructor() {
    this.buf = '';
    this.current = null;
    this.tagged = false;
    this.gesture = null; // zuletzt markierte Geste – gehört zum Satz, der gerade entsteht
  }
  /** Geste für den gerade fertigen Satz abholen (einmalig). */
  takeGesture() {
    const g = this.gesture;
    this.gesture = null;
    return g;
  }
  push(text) {
    this.buf += text;
    // Gesten-Marken entfernen und merken (auch unbekannte Gesten verschwinden aus dem Text)
    this.buf = this.buf.replace(GTAG, (_, g) => {
      this.gesture = normalizeGesture(g) ?? this.gesture;
      return '';
    });
    let out = '';
    TAG.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = TAG.exec(this.buf))) {
      out += this.buf.slice(last, m.index);
      this.current = normalizeMood(m[1]) ?? this.current;
      this.tagged = true;
      last = TAG.lastIndex;
    }
    let rest = this.buf.slice(last);
    // angefangene Marke zurückhalten, bis sie vollständig ist
    const open = rest.lastIndexOf('[');
    if (open >= 0 && rest.length - open < 26 && !rest.includes(']', open)) {
      const starOpen = rest.slice(0, open).match(/\**$/)[0].length;
      out += rest.slice(0, open - starOpen);
      this.buf = rest.slice(open - starOpen);
    } else {
      out += rest;
      this.buf = '';
    }
    return out;
  }
  flush() {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }
}

/** Ersatz ohne Marke: Stimmung grob aus dem Satz erraten (null = keine klare Stimmung). */
const word = (list, prefix = false) => new RegExp(`(?<!\\p{L})(?:${list})${prefix ? '' : '(?!\\p{L})'}`, 'iu');
const GUESS = [
  ['traurig', word('leider|tut mir (?:so |sehr )?leid|schade|traurig|bedaure|unfortunately|sorry|sadly')],
  ['überrascht', word('wow|ach was|tatsächlich|krass|unglaublich|whoa|really\\?')],
  ['ernst', word('achtung|vorsicht|wichtig|warnung|gefahr|risiko|beachte|warning|careful|important')],
  ['nachdenklich', word('hmm+|vielleicht|kommt darauf an|überleg\\p{L}*|einerseits|möglicherweise|maybe|it depends|perhaps')],
  ['freudig', word('super|toll|klasse|prima|gerne?|freut|freue|glückwunsch|perfekt|genial|großartig|hallo|great|awesome|glad|congrat', true)],
];
export function guessMood(sentence) {
  const s = String(sentence);
  for (const [mood, re] of GUESS) if (re.test(s)) return mood;
  return /!\s*$/.test(s.trim()) ? 'freudig' : null;
}

/** Sprechanweisung je Stimmung für die OpenAI-Stimme (gpt-4o-mini-tts) – so klingt die Stimme wie die Figur aussieht. */
export const MOOD_VOICE = {
  freudig: 'Gefühl jetzt: fröhlich und begeistert – mit hörbarem Lächeln, etwas lebhafter und schwungvoller.',
  ruhig: 'Gefühl jetzt: ruhig, freundlich und entspannt.',
  nachdenklich: 'Gefühl jetzt: nachdenklich – etwas langsamer, mit kleinen Denkpausen, abwägend.',
  überrascht: 'Gefühl jetzt: überrascht und erstaunt – lebhafte Betonung, etwas höher.',
  traurig: 'Gefühl jetzt: mitfühlend und sanft – leiser, langsamer, warm.',
  ernst: 'Gefühl jetzt: sachlich und ernst – klar, bestimmt, ohne Lächeln.',
};

// Piper (Stimme auf dem Gerät): Tempo (rate), Lebendigkeit der Betonung (noise) und Rhythmus (noiseW) je Stimmung
export const MOOD_PIPER = {
  freudig: { rate: 1.06, noise: 0.78, noiseW: 0.9 },
  ruhig: { rate: 0.96, noise: 0.6, noiseW: 0.75 },
  nachdenklich: { rate: 0.92, noise: 0.62, noiseW: 0.85 },
  überrascht: { rate: 1.08, noise: 0.85, noiseW: 0.95 },
  traurig: { rate: 0.88, noise: 0.55, noiseW: 0.7 },
  ernst: { rate: 0.97, noise: 0.56, noiseW: 0.7 },
};
