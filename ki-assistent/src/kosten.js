// Kostenzähler: schätzt, was Claude und OpenAI kosten – je Tag und Monat, getrennt nach Bereich (Dienstlich/Privat).
// Gerechnet wird mit den Listenpreisen in US-Dollar (so rechnen Anthropic und OpenAI ab). Die genaue Abrechnung steht
// in den Konten bei Anthropic bzw. OpenAI; Rabatte, Steuern und Wechselkurs sind hier nicht enthalten.
// Stand der Preise: Oktober 2026.

// US-$ je 1 Mio. Tokens; read = Cache-Lesen. Cache-Schreiben kostet bei Claude das 1,25-fache des Eingabepreises.
const CHAT_PRICES = [
  [/claude-opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/claude-sonnet-5-5/, { in: 2, out: 10, read: 0.2 }],
  [/claude-haiku-5-5/, { in: 0.1, out: 0.5, read: 0.01, big: { in: 0.5, out: 2.5, read: 0.05 } }],
  [/claude-(fable|mythos)-5-1/, { in: 10, out: 50, read: 0.25 }],
  [/claude-(fable|mythos)-5(?!-)/, { in: 10, out: 50, read: 1 }],
  [/claude-opus-5(?!-)/, { in: 5, out: 25, read: 0.5 }],
  [/^gpt-5-mini/, { in: 0.25, out: 2, read: 0.025 }],
  [/^gpt-5(?![.-])|^gpt-5-20/, { in: 1.25, out: 10, read: 0.125 }],
];
const WEB_SEARCH = 0.01; // je Suche ($10 je 1000)
// Spracherkennung: US-$ je Minute Audio
const STT_PER_MIN = { 'gpt-4o-transcribe': 0.006, 'gpt-4o-mini-transcribe': 0.003, 'whisper-1': 0.006 };
// Sprachausgabe: gpt-4o-mini-tts rechnet nach Audio-Tokens ($12 je 1 Mio.), das sind etwa 1,5 Cent je Minute;
// tts-1 / tts-1-hd nach Zeichen ($15 / $30 je 1 Mio. Zeichen)
const TTS = { 'gpt-4o-mini-tts': { perMin: 0.015 }, 'tts-1': { perChar: 15e-6 }, 'tts-1-hd': { perChar: 30e-6 } };
// Echtzeit-Gespräch (gpt-realtime): US-$ je 1 Mio. Tokens
const REALTIME = { audioIn: 32, audioOut: 64, cached: 0.4, textIn: 4, textOut: 16 };

const SERVICE = { chat: 'Chat', stt: 'Spracherkennung', tts: 'Sprachausgabe', realtime: 'Echtzeit-Gespräch' };

/** Kosten einer einzelnen Nutzung in US-$ (null = Preis für dieses Modell unbekannt). */
export function priceOf(u) {
  if (u.kind === 'chat') {
    const hit = CHAT_PRICES.find(([re]) => re.test(u.model ?? ''));
    if (!hit) return null;
    let p = hit[1];
    const inTotal = (u.in ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (p.big && inTotal > 100_000) p = { ...p, ...p.big };
    return (
      ((u.in ?? 0) * p.in + (u.out ?? 0) * p.out + (u.cacheRead ?? 0) * p.read + (u.cacheWrite ?? 0) * p.in * 1.25) / 1e6 +
      (u.searches ?? 0) * WEB_SEARCH
    );
  }
  if (u.kind === 'stt') {
    const perMin = STT_PER_MIN[u.model] ?? STT_PER_MIN['gpt-4o-transcribe'];
    return ((u.seconds ?? 0) / 60) * perMin;
  }
  if (u.kind === 'tts') {
    const t = TTS[u.model] ?? TTS['gpt-4o-mini-tts'];
    return t.perMin ? ((u.seconds ?? 0) / 60) * t.perMin : (u.chars ?? 0) * t.perChar;
  }
  if (u.kind === 'realtime') {
    const r = REALTIME;
    return (
      ((u.audioIn ?? 0) * r.audioIn + (u.audioOut ?? 0) * r.audioOut + (u.cached ?? 0) * r.cached + (u.textIn ?? 0) * r.textIn + (u.textOut ?? 0) * r.textOut) /
      1e6
    );
  }
  return null;
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class CostMeter {
  constructor(area = 'dienstlich', storage = globalThis.localStorage) {
    this.key = `ki-kosten-${area}`;
    this.storage = storage;
    this.listeners = new Set();
    this.data = this.load();
  }

  load() {
    try {
      const d = JSON.parse(this.storage?.getItem(this.key) ?? 'null');
      if (d?.days) return d;
    } catch {}
    return { days: {} };
  }

  save() {
    // nur gut ein Jahr aufheben
    const keys = Object.keys(this.data.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete this.data.days[k];
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.data));
    } catch {}
  }

  /** Nutzung erfassen, z. B. { kind: 'chat', model, in, out, cacheRead, cacheWrite, searches }. */
  add(u, when = new Date()) {
    const usd = priceOf(u);
    const day = (this.data.days[dayKey(when)] ??= { usd: 0, by: {}, unpriced: 0 });
    if (usd == null) day.unpriced++;
    else {
      day.usd += usd;
      const s = SERVICE[u.kind] ?? u.kind;
      day.by[s] = (day.by[s] ?? 0) + usd;
    }
    this.save();
    for (const f of this.listeners) f();
    return usd;
  }

  onChange(f) {
    this.listeners.add(f);
  }

  /** Summen: heute, gestern, dieser Monat, letzter Monat; nach Dienst für diesen Monat. */
  summary(now = new Date()) {
    const today = dayKey(now);
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yesterday = dayKey(y);
    const month = today.slice(0, 7);
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = dayKey(lm).slice(0, 7);
    const out = { today: 0, yesterday: 0, month: 0, lastMonth: 0, byService: {}, unpriced: 0, days: 0 };
    for (const [k, d] of Object.entries(this.data.days)) {
      if (k === today) out.today += d.usd;
      if (k === yesterday) out.yesterday += d.usd;
      if (k.startsWith(month)) {
        out.month += d.usd;
        out.unpriced += d.unpriced ?? 0;
        out.days++;
        for (const [s, v] of Object.entries(d.by ?? {})) out.byService[s] = (out.byService[s] ?? 0) + v;
      }
      if (k.startsWith(lastMonth)) out.lastMonth += d.usd;
    }
    return out;
  }

  reset() {
    this.data = { days: {} };
    this.save();
    for (const f of this.listeners) f();
  }
}

/** Betrag hübsch: „0,42 $“, kleine Beträge „< 0,01 $“. */
export function fmtUsd(v) {
  if (!v) return '0,00 $';
  if (v < 0.01) return '< 0,01 $';
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}
