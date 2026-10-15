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
  }
  push(text) {
    this.buf += text;
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
