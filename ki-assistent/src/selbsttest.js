// Selbsttest beim Start: prüft Einstellungen und Daten auf Unstimmigkeiten (falscher Typ, doppelte Kennungen, Verweise
// ins Leere) und repariert, was sich sicher reparieren lässt – nichts wird gelöscht, was Inhalt hat. Das Ergebnis steht
// im Protokoll (SELBSTTEST) und unter „Läuft alles?“.

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Einstellungen mit falschem Typ (z. B. Text statt Zahl, NaN) auf den Standard zurücksetzen. Nur Schlüssel, deren
 * Standard einen festen Typ hat (nicht null/leer), werden geprüft. Liefert die reparierten Schlüssel.
 */
export function repairSettings(settings, defaults) {
  const fixed = [];
  for (const [key, def] of Object.entries(defaults)) {
    if (!(key in settings) || def === null || def === '') continue;
    const v = settings[key];
    // Zahlen als Text aus Eingabefeldern („15“) und „true“/„false“ sind in Ordnung – nur Unbrauchbares wird ersetzt
    const numeric = typeof def === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
    const boolText = typeof def === 'boolean' && (v === 'true' || v === 'false');
    const bad = !numeric && !boolText && (kind(v) !== kind(def) || (typeof v === 'number' && !Number.isFinite(v)));
    if (bad && v !== undefined) {
      settings[key] = structuredClone(def);
      fixed.push(key);
    }
  }
  return fixed;
}

/** Doppelte oder fehlende Kennungen in einer Liste beheben (neue Kennung für die zweite). */
export function fixIds(list, newId) {
  const seen = new Set();
  let n = 0;
  for (const e of list ?? []) {
    if (!e || typeof e !== 'object') continue;
    if (!e.id || seen.has(e.id)) {
      e.id = newId();
      n++;
    }
    seen.add(e.id);
  }
  return n;
}

/**
 * Daten prüfen: Personas, Notizen, Erinnerungen. ctx: { personas, brain, erinnerungen, orte, activeId, newId }.
 * Liefert { issues: [Text], fixes: [Text] }; repariert direkt in den übergebenen Objekten.
 */
export function checkData(ctx) {
  const issues = [];
  const fixes = [];
  const personas = (ctx.personas ?? []).filter((p) => p && typeof p === 'object');
  if (!personas.length) issues.push('keine Persona vorhanden');
  const pid = fixIds(personas, ctx.newId);
  if (pid) fixes.push(`${pid} Persona-Kennung(en) erneuert`);
  if (ctx.activeId && personas.length && !personas.some((p) => p.id === ctx.activeId)) issues.push('aktive Persona fehlt');
  const nb = fixIds(ctx.brain, ctx.newId);
  if (nb) fixes.push(`${nb} Notiz-Kennung(en) erneuert`);
  for (const p of personas) {
    const n = fixIds(p.brain, ctx.newId);
    if (n) fixes.push(`${n} Kennung(en) im Notizbuch von ${p.name || 'einer Persona'} erneuert`);
  }
  // Erinnerungen: Zeit muss eine Zahl sein; Orts-Erinnerungen brauchen einen bekannten Ort
  const orte = new Set((ctx.orte ?? []).map((o) => o.id));
  for (const r of ctx.erinnerungen ?? []) {
    if (r.ort && !orte.has(r.ort) && !r.ack) {
      r.ack = Date.now();
      r.changed = Date.now();
      fixes.push(`Erinnerung „${String(r.text).slice(0, 30)}“: Ort fehlt – als erledigt markiert`);
    } else if (!r.ort && !Number.isFinite(r.at)) issues.push(`Erinnerung „${String(r.text).slice(0, 30)}“ ohne Zeit`);
  }
  return { issues, fixes };
}

/** Prüfungen mit Zeitlimit ausführen: [{ name, run: async () => true | Text }] → [{ name, ok, info }]. */
export async function runChecks(checks, ms = 3000) {
  const out = [];
  for (const c of checks) {
    let res;
    try {
      res = await Promise.race([c.run(), new Promise((r) => setTimeout(() => r('keine Antwort (Zeitlimit)'), ms))]);
    } catch (e) {
      res = e.message || String(e);
    }
    out.push({ name: c.name, ok: res === true, info: res === true ? '' : String(res) });
  }
  return out;
}
