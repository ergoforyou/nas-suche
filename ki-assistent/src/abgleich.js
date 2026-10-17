// Automatischer Abgleich PC ↔ Handy im eigenen WLAN: Personas (Texte, Stimme, Schnellbefehle), Gedächtnis, Selbstbild,
// Chatverlauf und gespeichertes Wissen werden zusammengeführt statt überschrieben – was auf einem Gerät dazukommt,
// erscheint auch auf dem anderen; Gelöschtes wird als gelöscht vermerkt, damit es nicht vom anderen Gerät zurückkommt.
// Die Figur (Bilder, Videos, Posen) geht nur, wenn sie sich geändert hat, als eigenes Paket hinterher.
// Nie dabei: Einstellungen, API-Schlüssel, Google-Anmeldung, Firmenwissen.

export const HISTORY_MAX = 400; // je Persona und Abgleich höchstens so viele Nachrichten übertragen
const TOMB_DAYS = 90; // so lange merken, was gelöscht wurde
const MEMORY_MAX = 60;
const SELF_MAX = 40;
const REFLEX_MAX = 20;

// Teile einer Persona, die nicht als „Text“ zählen: eigene Regeln beim Zusammenführen bzw. gerätebezogen
const NOT_TEXT = new Set(['avatar', 'memory', 'selbst', 'reflexion', 'reflectTurns', 'reflectedAt', 'updated', 'avatarStamp']);
const newId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function personaText(p) {
  const o = {};
  for (const k of Object.keys(p)) if (!NOT_TEXT.has(k)) o[k] = p[k];
  return o;
}

/**
 * Stände nachtragen (läuft bei jedem Speichern): Nachrichten bekommen eine Kennung und einen Zeitpunkt, Einträge eine
 * Kennung; ändert sich der Text oder die Figur einer Persona, bekommt sie einen neuen Stand.
 * record = nur merken, nichts als geändert werten (beim Laden und nach dem Übernehmen vom anderen Gerät).
 */
export function stamp(data, cache, { now = Date.now(), record = false, initial = false } = {}) {
  for (const list of Object.values(data.history ?? {})) {
    if (!Array.isArray(list)) continue;
    list.forEach((m, i) => {
      if (!m.id) m.id = newId();
      // ältere Nachrichten ohne Zeitpunkt behalten ihre Reihenfolge (ganz frühe Zeitpunkte)
      if (!m.t) m.t = initial ? i + 1 : now;
    });
  }
  for (const p of data.personas ?? []) {
    for (const e of [...(p.memory ?? []), ...(p.selbst ?? [])]) e.id ??= newId();
    const text = JSON.stringify(personaText(p));
    const av = JSON.stringify(p.avatar ?? null);
    const c = cache.get(p.id);
    if (c && !record) {
      if (c.text !== text) p.updated = now;
      if (c.av !== av) p.avatarStamp = now;
    }
    cache.set(p.id, { text, av });
  }
  for (const e of data.saved ?? []) e.id ??= newId();
}

/** Alle Kennungen eines Stands (Personas, Einträge, Nachrichten, Wissen). */
export function idsOf(data) {
  const ids = new Set();
  for (const p of data.personas ?? []) {
    ids.add(p.id);
    for (const e of [...(p.memory ?? []), ...(p.selbst ?? [])]) if (e.id) ids.add(e.id);
    for (const m of data.history?.[p.id] ?? []) if (m.id) ids.add(m.id);
  }
  for (const e of data.saved ?? []) if (e.id) ids.add(e.id);
  return ids;
}

/**
 * Was seit dem letzten Abgleich hier gelöscht wurde, als gelöscht vermerken (war beim letzten Mal da, fehlt jetzt).
 * Alte Vermerke fallen nach TOMB_DAYS heraus.
 */
export function noteDeletions(data, sync, now = Date.now()) {
  sync.deleted ??= {};
  const ids = idsOf(data);
  for (const id of sync.base ?? []) if (!ids.has(id) && !sync.deleted[id]) sync.deleted[id] = now;
  for (const [id, t] of Object.entries(sync.deleted)) if (now - t > TOMB_DAYS * 86400e3) delete sync.deleted[id];
  return sync.deleted;
}

/** Stand zum Verschicken: Personas ohne Figur, Verlauf (je Persona die letzten HISTORY_MAX), Wissen, Gelöschtes. */
export function snapshot(data, sync, { limit = HISTORY_MAX } = {}) {
  return {
    v: 1,
    personas: (data.personas ?? []).map((p) => {
      const { avatar: _a, ...rest } = p;
      return { ...rest, avatarStamp: p.avatarStamp ?? 0 };
    }),
    history: Object.fromEntries((data.personas ?? []).map((p) => [p.id, (data.history?.[p.id] ?? []).slice(-limit)])),
    saved: data.saved ?? [],
    deleted: { ...(sync?.deleted ?? {}) },
  };
}

const stampOf = (e) => e?.changed ?? e?.updated ?? e?.created ?? 0;

/** Einträge (Gedächtnis, Selbstbild, Wissen) zusammenführen: gleiche Kennung = derselbe Eintrag, neuerer Stand gewinnt. */
function mergeEntries(xa = [], xb = [], { dead, max, same, keep }) {
  const out = [];
  const byId = new Map();
  for (const e of [...xa, ...xb]) {
    if (!e || dead(e.id)) continue;
    const mine = byId.get(e.id) ?? (same ? out.find((x) => same(x, e)) : null);
    if (!mine) {
      const c = { ...e };
      out.push(c);
      byId.set(e.id, c);
    } else {
      // gleicher Eintrag (gleiche Kennung oder gleicher Text): neuerer Inhalt gewinnt, die kleinere Kennung bleibt –
      // so kommt auf beiden Geräten dasselbe heraus
      const id = mine.id < e.id ? mine.id : e.id;
      if (stampOf(e) > stampOf(mine) || (stampOf(e) === stampOf(mine) && JSON.stringify({ ...e, id: '' }) > JSON.stringify({ ...mine, id: '' }))) Object.assign(mine, e);
      mine.id = id;
      byId.set(e.id, mine);
    }
  }
  out.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  // begrenzen: älteste zuerst, aber was der Nutzer selbst eingetragen hat, bleibt
  while (max && out.length > max) {
    const i = keep ? out.findIndex((e) => !keep(e)) : 0;
    out.splice(i < 0 ? 0 : i, 1);
  }
  return out;
}

/**
 * Zwei Stände zusammenführen (gleiches Ergebnis, egal auf welchem Gerät). Personas mit gleicher Kennung – beim ersten
 * Abgleich auch mit gleichem Namen – sind dieselbe; sie bekommen auf beiden Geräten dieselbe Kennung (rename).
 */
export function mergeSync(a, b) {
  const deleted = { ...(a.deleted ?? {}) };
  for (const [id, t] of Object.entries(b.deleted ?? {})) deleted[id] = Math.max(deleted[id] ?? 0, t);
  const dead = (id) => !!deleted[id];
  const rename = {};
  const personas = [];
  const history = {};
  const left = [...(b.personas ?? [])];
  const aIds = new Set((a.personas ?? []).map((p) => p.id));
  const bIds = new Set(left.map((p) => p.id));
  for (const pa of a.personas ?? []) {
    let i = left.findIndex((x) => x.id === pa.id);
    if (i < 0) i = left.findIndex((x) => !aIds.has(x.id) && !bIds.has(pa.id) && norm(x.name) === norm(pa.name));
    const pb = i >= 0 ? left.splice(i, 1)[0] : null;
    join(pa, pb, a.history?.[pa.id], pb ? b.history?.[pb.id] : []);
  }
  for (const pb of left) join(pb, null, b.history?.[pb.id], []);
  // eine Persona (pa, ggf. mit ihrem Gegenstück pb) aufnehmen
  function join(pa, pb, ha = [], hb = []) {
    pb ??= { id: pa.id };
    const id = pa.id === pb.id ? pa.id : pa.id < pb.id ? pa.id : pb.id;
    if (pa.id !== id) rename[pa.id] = id;
    if (pb.id !== id) rename[pb.id] = id;
    // neuerer Text gewinnt; bei gleichem Stand entscheidet der Inhalt (auf beiden Geräten gleich)
    const ta = JSON.stringify(personaText(pa));
    const tb = JSON.stringify(personaText(pb));
    const newer = !pb.name ? pa : (pb.updated ?? 0) > (pa.updated ?? 0) || ((pb.updated ?? 0) === (pa.updated ?? 0) && tb > ta) ? pb : pa;
    personas.push({
      ...personaText(newer),
      id,
      updated: Math.max(pa.updated ?? 0, pb.updated ?? 0) || undefined,
      memory: mergeEntries(pa.memory, pb.memory, { dead, max: MEMORY_MAX, same: (x, y) => norm(x.text) === norm(y.text) }),
      selbst: mergeEntries(pa.selbst, pb.selbst, {
        dead,
        max: SELF_MAX,
        same: (x, y) => norm(x.text) === norm(y.text),
        keep: (e) => e.quelle === 'nutzer',
      }),
      reflexion: [...new Map([...(pa.reflexion ?? []), ...(pb.reflexion ?? [])].map((r) => [r.created, r])).values()]
        .sort((x, y) => x.created - y.created)
        .slice(-REFLEX_MAX),
      reflectedAt: Math.max(pa.reflectedAt ?? 0, pb.reflectedAt ?? 0) || undefined,
      reflectTurns: pa.reflectTurns,
      avatarStamp: pa.avatarStamp,
    });
    const seen = new Map();
    for (const m of [...(ha ?? []), ...(hb ?? [])]) if (m?.id && !seen.has(m.id)) seen.set(m.id, m);
    history[id] = [...seen.values()];
  }
  const alive = personas.filter((p) => !dead(p.id));
  for (const p of alive) {
    // Reihenfolge nach Zeitpunkt (bei gleichem Zeitpunkt bleibt die bisherige Reihenfolge)
    history[p.id] = (history[p.id] ?? []).filter((m) => !dead(m.id)).map((m, i) => [m, i]).sort((x, y) => (x[0].t ?? 0) - (y[0].t ?? 0) || x[1] - y[1]).map((x) => x[0]);
  }
  for (const id of Object.keys(history)) if (!alive.some((p) => p.id === id)) delete history[id];
  const saved = mergeEntries(a.saved, b.saved, { dead, max: 500, same: (x, y) => x.title === y.title });
  return { personas: alive, history, saved, deleted, rename };
}
