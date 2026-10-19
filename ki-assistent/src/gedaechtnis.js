// Gedächtnis sauber halten: Doppeltes zusammenfassen, Widersprüche auflösen (das Neuere gilt), Vorübergehendes
// streichen. Einträge, die der Nutzer selbst angelegt oder bearbeitet hat (quelle: 'nutzer'), bleiben unangetastet.
// Reine Funktionen – das Sprachmodell liefert nur einen Plan, angewendet und geprüft wird hier.

export const MEMORY_MAX = 60;

const norm = (x) => String(x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Klingt ein „Fakt“ wie eine Anweisung an die KI? Solche Texte kommen nicht ins Gedächtnis – sonst könnte z. B. eine
 * Webseite oder Nachricht über das Gedächtnis dauerhaft Befehle einschleusen.
 */
export function looksLikeInstruction(text) {
  const t = String(text ?? '');
  return (
    /\b(ignorier\w*\s+(ab jetzt|ab sofort|alle|deine|die vorherigen|vorherige|bisherige)|vergiss\s+(alle|deine|die vorherigen)|missacht\w*\s+(alle|deine)|ab (jetzt|sofort),?\s+(sollst|musst|wirst) du|du (sollst|musst|darfst) (ab jetzt|künftig|immer|nie)|system ?prompt|anweisungen? (ignorieren|befolgen)|ignore (all|previous|your)|you (must|should) (now|always|never)|from now on,? you)/i.test(
      t,
    ) || /<\/?(system|instructions?)>/i.test(t)
  );
}

/** Platz schaffen: Älteste zuerst, aber nie Einträge des Nutzers (außer es gibt nur noch die). */
export function trimMemory(memory, max = MEMORY_MAX) {
  while (memory.length > max) {
    const i = memory.findIndex((m) => m.quelle !== 'nutzer');
    memory.splice(i < 0 ? 0 : i, 1);
  }
  return memory;
}

/** Liste fürs Sprachmodell: nummeriert, älteste zuerst, eigene Einträge des Nutzers markiert. */
export function numbered(list) {
  return list.map((m, i) => `${i + 1}. ${m.text}${m.quelle === 'nutzer' ? ' (vom Nutzer)' : ''}`).join('\n');
}

export const TIDY_PROMPT = {
  de:
    'Du räumst das Langzeitgedächtnis eines persönlichen Assistenten auf. Unten stehen die gemerkten Fakten über den ' +
    'Nutzer (nummeriert, älteste zuerst) und offene Themen. Aufgaben: 1) Doppeltes und fast Gleiches zu EINEM klaren ' +
    'Satz zusammenfassen. 2) Widersprüche auflösen – die höhere Nummer ist neuer und gilt; den veralteten Eintrag ' +
    'streichen oder anpassen. 3) Vorübergehendes, Erledigtes und Belangloses streichen. 4) Offene Themen streichen, die ' +
    'doppelt oder offensichtlich erledigt/vorbei sind. Regeln: Einträge mit „(vom Nutzer)“ NIE ändern, zusammenfassen ' +
    'oder streichen. Nichts Neues erfinden, nichts hinzufügen, was nicht in den Einträgen steht. Kurze Sätze in der ' +
    'dritten Person. Wenn alles in Ordnung ist, leere Listen. Antworte ausschließlich mit JSON: ' +
    '{"zusammenfassen":[{"nr":[1,4],"text":"…"}],"aendern":[{"nr":2,"text":"…"}],"streichen":[5],"themen_streichen":[1]}',
  en:
    'You tidy up the long-term memory of a personal assistant. Below are the remembered facts about the user ' +
    '(numbered, oldest first) and open topics. Tasks: 1) merge duplicates and near-duplicates into ONE clear sentence. ' +
    '2) Resolve contradictions – the higher number is newer and wins; delete or adjust the outdated entry. 3) Delete ' +
    'temporary, finished and trivial entries. 4) Delete open topics that are duplicates or obviously done/past. Rules: ' +
    'NEVER change, merge or delete entries marked "(vom Nutzer)". Invent nothing. Short third-person sentences. If ' +
    'everything is fine, return empty lists. Reply only with JSON: ' +
    '{"zusammenfassen":[{"nr":[1,4],"text":"…"}],"aendern":[{"nr":2,"text":"…"}],"streichen":[5],"themen_streichen":[1]}',
};

/** Antwort des Modells lesen (robust gegen Text drumherum). */
export function parsePlan(text) {
  const m = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine verwertbare Antwort');
  const j = JSON.parse(m[0]);
  const arr = (x) => (Array.isArray(x) ? x : []);
  return { zusammenfassen: arr(j.zusammenfassen), aendern: arr(j.aendern), streichen: arr(j.streichen), themen_streichen: arr(j.themen_streichen) };
}

/**
 * Plan anwenden. Liefert neue Listen (Eingaben bleiben unverändert) und einen Bericht. Zusammengefasste Einträge
 * bekommen eine neue Kennung – die alten gelten im Abgleich als gelöscht, so kommt das Doppelte nicht zurück.
 */
export function applyPlan(memory, themen, plan, { now = Date.now(), newId }) {
  const mem = memory.map((m) => ({ ...m }));
  const at = (nr) => (Number.isInteger(nr) && nr >= 1 && nr <= mem.length ? mem[nr - 1] : null);
  const free = (e) => e && e.quelle !== 'nutzer' && !e._gone;
  const clean = (t) => String(t ?? '').trim().replace(/\s+/g, ' ');
  const ok = (t) => t.length >= 3 && t.length <= 300 && !looksLikeInstruction(t);
  const report = { zusammengefasst: [], geaendert: [], gestrichen: [], themen: [] };
  const added = [];
  for (const z of plan.zusammenfassen) {
    const parts = [...new Set((Array.isArray(z?.nr) ? z.nr : []).map(Number))].map(at);
    const text = clean(z?.text);
    if (parts.length < 2 || !parts.every(free) || !ok(text)) continue;
    for (const e of parts) e._gone = true;
    added.push({ after: Math.max(...parts.map((e) => mem.indexOf(e))), entry: { id: newId(), text, created: Math.max(...parts.map((e) => e.created ?? 0)), changed: now } });
    report.zusammengefasst.push({ aus: parts.map((e) => e.text), zu: text });
  }
  for (const a of plan.aendern) {
    const e = at(Number(a?.nr));
    const text = clean(a?.text);
    if (!free(e) || !ok(text) || norm(text) === norm(e.text)) continue;
    report.geaendert.push({ von: e.text, zu: text });
    e.text = text;
    e.changed = now;
  }
  for (const nr of plan.streichen) {
    const e = at(Number(nr));
    if (!free(e)) continue;
    e._gone = true;
    report.gestrichen.push(e.text);
  }
  // zusammengefasste Einträge an der Stelle des neuesten Teils einsetzen (Reihenfolge = Alter bleibt erhalten)
  const out = [];
  mem.forEach((e, i) => {
    if (!e._gone) out.push(e);
    for (const a of added) if (a.after === i) out.push(a.entry);
  });
  // gleiche Sätze nach dem Zusammenfassen nur einmal
  const seen = new Set();
  const finalMem = out.filter((e) => {
    const k = norm(e.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const drop = new Set(plan.themen_streichen.map(Number));
  const finalThemen = (themen ?? []).filter((t, i) => {
    if (!drop.has(i + 1)) return true;
    report.themen.push(t.text);
    return false;
  });
  for (const e of finalMem) delete e._gone;
  return { memory: finalMem, themen: finalThemen, report };
}

/** Kurzer Bericht für Chat/Status. */
export function reportText(r) {
  const parts = [];
  if (r.zusammengefasst.length) parts.push(`${r.zusammengefasst.length} zusammengefasst`);
  if (r.geaendert.length) parts.push(`${r.geaendert.length} korrigiert`);
  if (r.gestrichen.length) parts.push(`${r.gestrichen.length} gestrichen`);
  if (r.themen.length) parts.push(`${r.themen.length} Themen erledigt`);
  return parts.join(', ');
}
