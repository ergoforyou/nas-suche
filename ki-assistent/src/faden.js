// Gesprächsfaden: das Gespräch bleibt beim Thema des Gegenübers. Zusatzwissen (Notizen, Vorhaben, offene Punkte) geht
// nur mit, wenn es passt, und jedes Stück höchstens einmal je Gespräch; falsch Erkanntes und Echos fliegen raus,
// „Vergiss das“ nimmt das Letzte zurück, und ein neuer Chat knüpft an den vorigen an.

export const SESSION_GAP = 45 * 60e3; // so lange Pause = neues Gespräch

/** Beginnt mit dieser Nachricht ein neues Gespräch (vorige Nachricht länger her)? */
export function isSessionStart(history, now = Date.now(), gap = SESSION_GAP) {
  const prev = [...(history ?? [])].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  return !prev || now - (prev.t ?? 0) > gap;
}

/**
 * Was in diesem Gespräch schon mitging, nicht noch einmal mitgeben (sonst bringt die Figur es bei jeder Antwort wieder).
 * shown: Set der Kennungen (wird ergänzt). keep: trotzdem mitgeben (z. B. ausdrücklich danach gefragt).
 */
export function onlyNew(items, shown, keyOf = (x) => x.id, keep = false) {
  const out = keep ? [...(items ?? [])] : (items ?? []).filter((x) => !shown.has(keyOf(x)));
  for (const x of out) shown.add(keyOf(x));
  return out;
}

/** „Vergiss das“ / „Das war Quatsch“ – die letzte Eingabe samt Antwort zurücknehmen? */
export function forgetCommand(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(bitte )?(vergiss (das|das letzte|es)( bitte| wieder)?|das war quatsch|das war falsch verstanden|ignorier (das|das letzte)( bitte)?|streich das( bitte)?|lösch das letzte( bitte)?|das war nicht für dich( gedacht)?|das gehörte nicht zu dir)$/.test(t);
}

// typische Erfindungen der Spracherkennung bei Rauschen/Stille (Whisper lernt an Untertiteln und Videos)
const PHANTOM = [
  /untertitel(ung)? (im auftrag|von|des|der)/i,
  /\b(abonniert?|abonnieren) (den|meinen|unseren) kanal/i,
  /\bwir sehen uns (im nächsten video|beim nächsten mal)/i,
  /\bdas war'?s (für heute|von mir)[.!]*$/i,
  /^(tschüss|ciao|bye)[.!]*$/i,
  /^(musik|applaus|lachen|stille)[.!]*$/i,
  /\bmehr infos? (unter|auf) www\./i,
  /^(ja|nein|okay|ok)[.!]?\s*(ja|nein|okay|ok)[.!]?\s*(ja|nein|okay|ok)[.!]?$/i,
  /^(\S+)([ ,.!]+\1){3,}[.!]*$/i, // dasselbe Wort viermal und mehr
];
export const isPhantom = (text) => PHANTOM.some((r) => r.test(String(text ?? '').trim()));

/**
 * Hat das Mikrofon nur die Figur selbst gehört? Wortpaare des Gehörten mit dem zuletzt Gesprochenen vergleichen.
 * Auch kurz NACH dem Sprechen (Nachhall, Auto-Lautsprecher) – dort mit etwas strengerer Schwelle.
 */
export function echoScore(heard, spoken) {
  const words = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  const pairs = (w) => w.slice(1).map((x, i) => w[i] + ' ' + x);
  const h = pairs(words(heard));
  if (h.length < 2) return 0;
  const said = new Set(pairs(words(String(spoken ?? '').slice(-800))));
  return h.filter((p) => said.has(p)).length / h.length;
}

/** Zusätze für die KI */
export const RULE_THREAD =
  'Bleib beim Thema deines Gegenübers. Notizen, Vorhaben, Erinnerungen oder offene Punkte, die du mitbekommst, bringst ' +
  'du nur ein, wenn sie direkt zur aktuellen Frage passen – nie als Themenwechsel mitten im Gespräch. Was erledigt ist ' +
  'oder wozu dein Gegenüber „nicht jetzt“ gesagt hat, sprichst du nicht wieder an.';
export const RULE_VOICE_UNSURE =
  'Was dein Gegenüber sagt, kommt über die Spracherkennung und kann falsch erkannt sein. Passt eine Äußerung nicht zum ' +
  'bisherigen Gespräch oder ergibt keinen rechten Sinn, frag kurz nach („Meintest du …?“), statt darauf einzugehen ' +
  'oder das Thema zu wechseln.';
export const RULE_UNSURE_NOW =
  'Diese letzte Äußerung wurde nur unsicher erkannt. Ergibt sie im Zusammenhang keinen klaren Sinn, frag kurz nach.';

/** Brücke vom vorigen Chat (für die ersten Nachrichten eines neuen Chats). */
export function bridgePrompt(b, lang = 'de') {
  if (!b?.text) return '';
  return lang === 'en'
    ? `Where you left off (previous chat): ${b.text}${b.offen ? ` Still open: ${b.offen}` : ''}\nPick it up only if it fits.`
    : `Wo ihr zuletzt wart (voriger Chat): ${b.text}${b.offen ? ` Noch offen: ${b.offen}` : ''}\nKnüpf nur daran an, wenn es passt.`;
}
/** Zusammenfassung des früheren Teils eines langen Gesprächs (der nicht mehr wörtlich mitgeht). */
export function earlierPrompt(text, lang = 'de') {
  if (!text) return '';
  return lang === 'en' ? `Earlier in this conversation (summary): ${text}` : `Früher in diesem Gespräch (Zusammenfassung): ${text}`;
}
/** Einfache Brücke ohne Hilfsmodell: die letzten Themen des Gegenübers. */
export function plainBridge(history, n = 3) {
  const said = (history ?? []).filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim()).slice(-n);
  if (!said.length) return null;
  return { text: `Zuletzt ging es um: ${said.map((m) => `„${m.content.trim().slice(0, 100)}“`).join(', ')}.`, t: Date.now() };
}
