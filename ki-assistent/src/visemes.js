// Mundbilder (Viseme) passend zu den Lauten: m/b/p schließen die Lippen, f/w sind fast zu, o/u rund, i/e breit.
// Bei Piper kommen die Laute direkt aus dem Lautwandler, bei anderen Stimmen (OpenAI, Sprach-Server) aus der
// Schreibweise – im Deutschen passt die gut genug. Die Laute werden über die hörbare Dauer des Satzes verteilt.

const V = {
  closed: { open: 0, shape: 0, w: 0.9 },
  fv: { open: 0.12, shape: 0.25, w: 0.9 },
  round: { open: 0.6, shape: -0.9, w: 1.5 },
  wide: { open: 0.5, shape: 0.75, w: 1.4 },
  open: { open: 1, shape: 0.1, w: 1.6 },
  mid: { open: 0.75, shape: 0, w: 1.2 }, // Schwa (e in „bitte“)
  cons: { open: 0.35, shape: 0, w: 0.8 },
  pause: { open: 0, shape: 0, w: 0.5 },
  stop: { open: 0, shape: 0, w: 2.2 }, // Satzzeichen: hörbare Pause
};

// Lautschrift (espeak/IPA) und Buchstaben
const MAP = new Map();
const put = (chars, v) => [...chars].forEach((c) => MAP.set(c, v));
put('mbpɱ', V.closed);
put('fvwʋ', V.fv);
put('oɔuʊyʏøœöüɒ', V.round);
put('iɪeɛjäéè', V.wide);
put('aɑæɐ', V.open);
put('əɜ', V.mid);
put(' \t\n-', V.pause);
put('.,;:!?…—', V.stop);

/** Text oder Lautfolge -> Liste von Mundbildern. */
export function visemeUnits(symbols) {
  const out = [];
  for (const raw of symbols) {
    const c = String(raw).toLowerCase();
    if (c === 'ː' || c === ':') {
      // Längenzeichen: vorherigen Laut verlängern
      if (out.length) out[out.length - 1] = { ...out[out.length - 1], w: out[out.length - 1].w * 1.6 };
      continue;
    }
    if (/^[ˈˌ'"()*_#`]$/.test(c)) continue;
    const v = MAP.get(c[0]) ?? (/\p{L}/u.test(c) ? V.cons : null);
    if (!v) continue;
    // doppelte Pausen zusammenfassen
    if ((v === V.pause || v === V.stop) && (out.at(-1)?.pause ?? false)) {
      if (v === V.stop) out[out.length - 1] = { ...V.stop, pause: true };
      continue;
    }
    out.push(v === V.pause || v === V.stop ? { ...v, pause: true } : v);
  }
  return out;
}

/**
 * Zeitplan der Mundbilder für ein Audiostück: Stille am Anfang und Ende wird abgeschnitten.
 * @returns {{t: number, open: number, shape: number}[]} Startzeiten in Sekunden
 */
export function visemeTimeline(units, pcm, sampleRate) {
  if (!units?.length || !pcm?.length) return null;
  const frame = Math.max(1, Math.round(sampleRate * 0.01));
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 7) peak = Math.max(peak, Math.abs(pcm[i]));
  const thr = peak * 0.08;
  const loud = (f) => {
    let m = 0;
    for (let i = f * frame; i < Math.min(pcm.length, (f + 1) * frame); i++) m = Math.max(m, Math.abs(pcm[i]));
    return m > thr;
  };
  const frames = Math.floor(pcm.length / frame);
  let a = 0;
  while (a < frames && !loud(a)) a++;
  let b = frames - 1;
  while (b > a && !loud(b)) b--;
  const start = (a * frame) / sampleRate;
  const end = ((b + 1) * frame) / sampleRate;
  // Pausen am Rand gehören zur abgeschnittenen Stille
  let lo = 0;
  let hi = units.length;
  while (lo < hi && units[lo].pause) lo++;
  while (hi > lo && units[hi - 1].pause) hi--;
  const list = units.slice(lo, hi);
  const total = list.reduce((s, u) => s + u.w, 0);
  if (!total || end <= start) return null;
  let t = start;
  const out = [];
  for (const u of list) {
    out.push({ t, open: u.open, shape: u.shape });
    t += ((end - start) * u.w) / total;
  }
  out.push({ t: end, open: 0, shape: 0 });
  return out;
}

/** Mundbild zum Zeitpunkt t (Sekunden) – mit kurzer Überblendung zum nächsten Laut. */
export function visemeAt(timeline, t) {
  if (!timeline?.length || t < timeline[0].t) return null;
  let i = 0;
  while (i < timeline.length - 1 && timeline[i + 1].t <= t) i++;
  const cur = timeline[i];
  const next = timeline[i + 1];
  if (!next) return { open: 0, shape: 0 };
  // in den letzten 30 % eines Lauts schon zum nächsten überblenden (Koartikulation)
  const k = Math.max(0, ((t - cur.t) / Math.max(1e-3, next.t - cur.t) - 0.7) / 0.3);
  return { open: cur.open + (next.open - cur.open) * k, shape: cur.shape + (next.shape - cur.shape) * k };
}
