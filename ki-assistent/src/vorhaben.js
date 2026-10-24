// Die Figur arbeitet selbstständig (Bereich Privat): ihr Notizbuch pflegen, an Vorhaben über mehrere Tage
// weiterarbeiten (Schritt für Schritt, mit Internetsuche) und als Tagesbegleiter die drei wichtigsten Dinge des Tages
// festhalten. Hier stehen nur Aufträge und das Auswerten der Antworten – ausgeführt wird in app.js.

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const jsonIn = (text) => {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    // Antwort mit Text drumherum: den letzten JSON-Block versuchen
    const all = String(text).match(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g);
    for (const c of (all ?? []).reverse()) {
      try {
        return JSON.parse(c);
      } catch {}
    }
    return null;
  }
};

// ---------------------------------------------------------------- 1. Notizbuch selbst pflegen
export const OWN_TIDY_PROMPT =
  'Du pflegst dein eigenes Notizbuch (du bist die Figur, die es führt). Unten stehen deine Notizen (Kennung, Ordner, ' +
  'Alter in Tagen, offen/erledigt, Titel, Text). Räum behutsam auf: Was ist erledigt oder überholt? Was ist doppelt und ' +
  'gehört zusammen? Was ist älter als zwei Monate und nicht mehr wichtig (ins Archiv)? Was ließe sich klarer fassen? ' +
  'Gibt es etwas, das du deinem Gegenüber bei Gelegenheit sagen oder fragen solltest? Lösche nichts, was du noch ' +
  'brauchst; Vorhaben mit offenen Schritten bleiben. Antworte NUR mit JSON: {"erledigt": [Kennungen], "archiv": ' +
  '[Kennungen], "zusammen": [{"ids": [Kennungen], "titel": "…", "text": "…"}], "aendern": [{"id": "…", "titel": "…", ' +
  '"text": "…"}], "ansprechen": "ein kurzer Satz an dein Gegenüber oder null"}.';

export function tidyInput(notes, now = Date.now()) {
  return notes
    .slice(-80)
    .map((n) => `${n.id} | ${n.ordner} | ${Math.round((now - (n.changed ?? now)) / 86400e3)} T | ${n.erledigt ? 'erledigt' : n.offen ? 'offen' : '-'} | ${clean(n.titel, 80)} | ${clean(n.text, 240)}`)
    .join('\n');
}

/** Ergebnis des Aufräumens auf die Notizen anwenden; liefert die neue Liste, was geändert wurde und ggf. ein Thema. */
export function applyTidy(notes, res, now = Date.now()) {
  if (!res || typeof res !== 'object') return { notes, changed: 0, topic: null };
  const byId = new Map(notes.map((n) => [n.id, n]));
  const touch = (n, patch) => Object.assign(n, patch, { changed: now });
  let changed = 0;
  const keepSteps = (n) => (n.schritte ?? []).some((s) => !s.erledigt);
  for (const id of res.erledigt ?? []) {
    const n = byId.get(id);
    if (n && !n.erledigt && !keepSteps(n)) touch(n, { erledigt: now }), changed++;
  }
  for (const id of res.archiv ?? []) {
    const n = byId.get(id);
    if (n && n.ordner !== 'archiv' && !keepSteps(n)) touch(n, { ordner: 'archiv' }), changed++;
  }
  const drop = new Set();
  for (const z of res.zusammen ?? []) {
    const ids = (z?.ids ?? []).filter((id) => byId.has(id) && !drop.has(id));
    if (ids.length < 2) continue;
    const [first, ...rest] = ids.map((id) => byId.get(id));
    const steps = [first, ...rest].flatMap((n) => n.schritte ?? []);
    touch(first, {
      titel: clean(z.titel, 140) || first.titel,
      text: String(z.text ?? '').trim().slice(0, 20000) || [first, ...rest].map((n) => n.text).join('\n\n'),
      tags: [...new Set([first, ...rest].flatMap((n) => n.tags ?? []))].slice(0, 12),
      ...(steps.length ? { schritte: steps.slice(0, 20) } : {}),
      ...([first, ...rest].some((n) => n.offen && !n.erledigt) ? { offen: true } : {}),
    });
    for (const n of rest) drop.add(n.id);
    changed++;
  }
  for (const a of res.aendern ?? []) {
    const n = byId.get(a?.id);
    if (!n || drop.has(n.id)) continue;
    const patch = {};
    if (clean(a.titel, 140)) patch.titel = clean(a.titel, 140);
    if (String(a.text ?? '').trim()) patch.text = String(a.text).trim().slice(0, 20000);
    if (Object.keys(patch).length) touch(n, patch), changed++;
  }
  const topic = clean(res.ansprechen, 300) || null;
  return { notes: notes.filter((n) => !drop.has(n.id)), changed: changed + drop.size, topic };
}

// ---------------------------------------------------------------- 2. Vorhaben über mehrere Tage
export const VORHABEN_MAX_TAG = 3; // so viele Arbeitsschritte am Tag (Kosten)
/** Nächster offener Schritt eines Vorhabens (oder null). */
export const nextStep = (n) => (n?.schritte ?? []).find((s) => !s.erledigt && !s.wartet) ?? null;
/** Woran die Figur jetzt arbeiten kann: eigenes, offenes Vorhaben mit offenem Schritt, das länger nicht dran war. */
export function pickVorhaben(notes, now = Date.now(), pauseMs = 3 * 3600e3) {
  return (
    (notes ?? [])
      .filter((n) => n.ordner === 'projekte' && n.offen && !n.erledigt && nextStep(n) && now - (n.gearbeitet ?? 0) > pauseMs)
      .sort((a, b) => (a.gearbeitet ?? 0) - (b.gearbeitet ?? 0))[0] ?? null
  );
}
export function vorhabenPrompt(name) {
  return (
    `Du bist ${name} und arbeitest in einer ruhigen Minute selbstständig an einem deiner Vorhaben für dein Gegenüber. ` +
    'Erledige den unten genannten nächsten Schritt, so gut es geht – recherchiere dafür im Internet, wenn es hilft. ' +
    'Halte das Ergebnis knapp und brauchbar fest (Stichpunkte, Zahlen, Links/Quellen). Braucht der Schritt eine ' +
    'Entscheidung oder Auskunft deines Gegenübers, frag nicht ins Leere, sondern setz "frage". Antworte am Ende NUR mit ' +
    'JSON: {"ergebnis": "Markdown, höchstens 12 Zeilen", "schritt_erledigt": true/false, "neue_schritte": ["…"] (höchstens ' +
    '3, nur wenn wirklich nötig), "fertig": true/false (ganzes Vorhaben erledigt), "frage": "Frage an dein Gegenüber oder ' +
    'null", "nachricht": "ein Satz für dein Gegenüber, wenn es etwas Gutes zu berichten gibt, sonst null"}.'
  );
}
export function vorhabenInput(n) {
  const steps = (n.schritte ?? []).map((s, i) => `${i + 1}. ${s.erledigt ? '[x]' : s.wartet ? '[wartet]' : '[ ]'} ${s.text}`).join('\n');
  const step = nextStep(n);
  return `Vorhaben: ${n.titel}\n\nNotizen bisher:\n${String(n.text ?? '').slice(-3000) || '–'}\n\nSchritte:\n${steps}\n\nJetzt dran: ${step?.text ?? '–'}`;
}
export function parseVorhaben(text) {
  const j = jsonIn(text);
  if (!j || typeof j !== 'object') return null;
  return {
    ergebnis: String(j.ergebnis ?? '').trim().slice(0, 4000),
    erledigt: j.schritt_erledigt === true,
    neue: (Array.isArray(j.neue_schritte) ? j.neue_schritte : []).map((s) => clean(s, 160)).filter(Boolean).slice(0, 3),
    fertig: j.fertig === true,
    frage: clean(j.frage, 300) || null,
    nachricht: clean(j.nachricht, 300) || null,
  };
}
/** Arbeitsergebnis ins Vorhaben übernehmen (Text unten anfügen, Schritt abhaken, neue Schritte, ggf. fertig). */
export function applyVorhaben(n, r, now = Date.now()) {
  const step = nextStep(n);
  const day = new Date(now).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  if (r.ergebnis) n.text = `${n.text ? `${n.text}\n\n` : ''}### ${day} – ${step?.text ?? 'Arbeitsschritt'}\n${r.ergebnis}`.slice(-20000);
  if (step && r.erledigt) step.erledigt = now;
  if (step && r.frage && !r.erledigt) step.wartet = r.frage;
  for (const t of r.neue) if (!(n.schritte ?? []).some((s) => s.text.toLowerCase() === t.toLowerCase())) (n.schritte ??= []).push({ text: t });
  n.schritte = (n.schritte ?? []).slice(0, 20);
  if (r.fertig || !(n.schritte ?? []).some((s) => !s.erledigt)) n.erledigt = now;
  n.gearbeitet = now;
  n.changed = now;
  return n;
}
/** Schritte aus Text oder Liste (für das Werkzeug). */
export function stepsFrom(list) {
  return (Array.isArray(list) ? list : String(list ?? '').split(/\n|;/))
    .map((s) => clean(String(s).replace(/^\s*(\d+[.)]|[-*•])\s*/, ''), 160))
    .filter(Boolean)
    .slice(0, 12)
    .map((text) => ({ text }));
}

// ---------------------------------------------------------------- 3. Tagesbegleiter
export const TOP3_PROMPT =
  'Dein Gegenüber hat auf die Frage nach den wichtigsten Dingen für heute geantwortet. Nenne diese Dinge als kurze ' +
  'Aufgaben (je höchstens 8 Wörter, in der Reihenfolge der Antwort, höchstens 3). Hat die Antwort nichts damit zu tun, ' +
  'gib eine leere Liste. Antworte NUR mit JSON: {"heute": ["…"]}.';
export function parseTop3(text) {
  const j = jsonIn(text);
  return (Array.isArray(j?.heute) ? j.heute : []).map((s) => clean(s, 80)).filter(Boolean).slice(0, 3);
}
/** Frage am Ende der Morgenrunde (nur einmal am Tag). */
export const TOP3_ASK = 'Frag zum Schluss in einem kurzen Satz, was heute die drei wichtigsten Dinge für dein Gegenüber sind.';
