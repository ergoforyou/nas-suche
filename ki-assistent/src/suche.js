// Suche nach Bedeutung über alles, was die Figur weiß: Notizen (Second Brain), ihr eigenes Notizbuch, frühere
// Gespräche, gespeichertes Wissen, Erinnerungen und – nur Dienstlich – das Firmenwissen.
// Ein kleines mehrsprachiges Modell (multilingual-e5-small, läuft lokal im Worker) macht aus jedem Text einen Vektor;
// ähnliche Bedeutung = ähnliche Richtung. Die Vektoren bleiben auf dem Gerät (IndexedDB), werden nie abgeglichen oder
// exportiert und lassen sich jederzeit neu berechnen. Die Wortsuche (BM25 in wissen.js) bleibt daneben bestehen: beide
// Ranglisten werden zusammengeführt, so zählen genaue Begriffe und Umschreibungen.

export const EMBED_MODEL = 'Xenova/multilingual-e5-small';
// Schwellen für die Ähnlichkeit (Kosinus). e5 liegt auch bei Unpassendem um 0,75 – darum eher streng; Treffer, die nur
// die Bedeutungssuche findet, müssen deutlich passen. Die Werte stehen im Protokoll (SUCHE), um sie nachzustellen.
export const VEC_MIN = 0.8;
export const VEC_ONLY_MIN = 0.835;
export const VEC_SPREAD = 0.05; // höchstens so weit unter dem besten Treffer
const BATCH = 8;
const MAX_CHARS = 1500; // e5-small liest höchstens 512 Wortteile – mehr bringt nichts

/** Kurzer Prüfwert eines Texts (FNV-1a): ändert sich der Text, wird neu berechnet. */
export function hashText(s) {
  let h = 0x811c9dc5;
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Vektor platzsparend als 8-Bit-Zahlen (ein Viertel des Speichers, Genauigkeit reicht für die Rangfolge). */
export function quantize(v) {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const s = max ? 127 / max : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] * s);
  return { s, v: q };
}
export function dot(item, q) {
  let sum = 0;
  const v = item.v;
  for (let i = 0; i < v.length; i++) sum += v[i] * q[i];
  return sum / item.s;
}

/**
 * Ranglisten zusammenführen (Reciprocal Rank Fusion): jede Liste ist eine Folge von Schlüsseln, beste zuerst.
 * Wer in beiden Listen vorn steht, gewinnt; ein Treffer aus nur einer Liste zählt trotzdem.
 */
export function fuse(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((key, i) => score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/** Text, wie er zum Vektor wird: Titel und Stichworte zuerst (die tragen am meisten Bedeutung). */
export function docText(...parts) {
  return parts
    .filter(Boolean)
    .map((p) => String(p).replace(/\s+/g, ' ').trim())
    .join('\n')
    .slice(0, MAX_CHARS);
}

/**
 * Index mit Hintergrund-Berechnung. embed(texts) → Float32Array[] (normalisiert); store: { load(), save(data) }.
 * Schlüssel tragen die Quelle vorn: b: Notiz, f: eigenes Notizbuch der Figur, e: Gespräch, s: gespeichertes Wissen,
 * r: Erinnerung, k: Firmenwissen-Abschnitt.
 */
export function createSemantik({ embed, store = null, log = () => {}, model = EMBED_MODEL } = {}) {
  let items = new Map(); // Schlüssel → { h, s, v }
  let want = new Map(); // Schlüssel → { h, text }
  let saveTimer = null;
  let lastQ = { text: '', vec: null };
  let failed = null;
  let loaded = false;

  const persist = () => {
    if (!store) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.save({ model, items: [...items.entries()].map(([key, it]) => ({ key, h: it.h, s: it.s, v: it.v })) }).catch?.((e) => log(`Speichern: ${e.message}`));
    }, 1500);
  };

  const api = {
    get failed() {
      return failed;
    },
    async load() {
      if (loaded) return;
      loaded = true;
      try {
        const d = await store?.load();
        if (d?.model === model && Array.isArray(d.items)) items = new Map(d.items.map((it) => [it.key, { h: it.h, s: it.s, v: it.v instanceof Int8Array ? it.v : Int8Array.from(it.v) }]));
      } catch (e) {
        log(`Laden: ${e.message}`);
      }
    },
    /** Gewünschten Bestand setzen: [{ key, text }]. Veraltetes fällt weg, Neues/Geändertes kommt in die Warteschlange. */
    sync(docs) {
      want = new Map();
      for (const d of docs) if (d?.key && String(d.text ?? '').trim()) want.set(d.key, { h: hashText(d.text), text: d.text });
      let dropped = 0;
      for (const key of [...items.keys()]) if (!want.has(key)) items.delete(key), dropped++;
      if (dropped) persist();
      return api.pending();
    },
    /** Wie viele Texte noch berechnet werden müssen. */
    pending() {
      let n = 0;
      for (const [key, w] of want) if (items.get(key)?.h !== w.h) n++;
      return n;
    },
    stats() {
      return { total: want.size, done: want.size - api.pending() };
    },
    /** Nächsten Schwung berechnen; liefert die Anzahl (0 = alles fertig). */
    async pump(batch = BATCH) {
      const todo = [];
      for (const [key, w] of want) {
        if (items.get(key)?.h === w.h) continue;
        todo.push([key, w]);
        if (todo.length >= batch) break;
      }
      if (!todo.length) return 0;
      try {
        const vecs = await embed(todo.map(([, w]) => `passage: ${w.text}`));
        todo.forEach(([key, w], i) => vecs[i] && items.set(key, { h: w.h, ...quantize(vecs[i]) }));
        failed = null;
        persist();
      } catch (e) {
        failed = e.message || String(e);
        throw e;
      }
      return todo.length;
    },
    ready(prefixes) {
      for (const [key, w] of want) if ((!prefixes || prefixes.some((p) => key.startsWith(p))) && items.get(key)?.h === w.h) return true;
      return false;
    },
    /** Passende Schlüssel zur Frage: [{ key, score }], beste zuerst; nur fertig berechnete Einträge. */
    async search(q, { prefixes = null, k = 5, min = VEC_MIN } = {}) {
      const text = String(q ?? '').trim();
      if (!text || !items.size) return [];
      if (lastQ.text !== text) lastQ = { text, vec: (await embed([`query: ${text.slice(0, MAX_CHARS)}`]))[0] };
      const qv = lastQ.vec;
      const out = [];
      for (const [key, it] of items) {
        if (prefixes && !prefixes.some((p) => key.startsWith(p))) continue;
        if (want.size && !want.has(key)) continue;
        if (it.v.length !== qv.length) continue; // aus einem anderen Modell – wird beim nächsten Erfassen ersetzt
        out.push({ key, score: dot(it, qv) });
      }
      out.sort((a, b) => b.score - a.score);
      const best = out[0]?.score ?? 0;
      return out.filter((h) => h.score >= min && h.score >= best - VEC_SPREAD).slice(0, k);
    },
    clear() {
      items = new Map();
      persist();
    },
  };
  return api;
}

/**
 * Wortsuche und Bedeutungssuche zusammenführen. words: Schlüssel aus der Wortsuche (beste zuerst), vec: Ergebnis von
 * search(). Treffer nur aus der Bedeutungssuche brauchen VEC_ONLY_MIN.
 */
export function combine(words, vec, k = 3) {
  const strong = vec.filter((h) => h.score >= VEC_ONLY_MIN || words.includes(h.key)).map((h) => h.key);
  return fuse([words, strong]).slice(0, k);
}

/** Zeile unter der Antwort: was aus dem eigenen Wissen mitgegeben wurde (wird nicht vorgelesen). */
export function sourcesLine(list, lang = 'de') {
  const names = [...new Set(list.filter(Boolean))].slice(0, 6);
  if (!names.length) return '';
  return lang === 'en' ? `🧠 *From memory: ${names.join(', ')}*` : `🧠 *Aus dem Gedächtnis mitgegeben: ${names.join(', ')}*`;
}

/** Einfache Ablage im Browser-Speicher (IndexedDB) – ein Datensatz je Bereich. */
export function idbStore(name) {
  const open = () =>
    new Promise((res, rej) => {
      const r = indexedDB.open('ki-suche', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('vec');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('vec', mode);
      const req = fn(t.objectStore('vec'));
      t.oncomplete = () => (db.close(), res(req?.result));
      t.onerror = () => (db.close(), rej(t.error));
    });
  };
  return {
    load: () => tx('readonly', (s) => s.get(name)),
    save: (data) => tx('readwrite', (s) => s.put(data, name)),
  };
}
