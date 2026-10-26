// Second Brain (Bereich Privat): Notizen des Nutzers in Ordnern – Eingang, Projekte, Themen, Personen, Tagebuch,
// Archiv – mit Stichworten, Verknüpfungen und offenen Punkten („Ich muss noch …“). Liegt auf dem Gerät, gleicht sich
// mit dem anderen Gerät ab (WLAN, später NAS) und lässt sich jederzeit als Obsidian-Ordner (Markdown) exportieren
// bzw. aus einem solchen Ordner importieren. Firmenwissen und Kundendaten gehören nicht hierher.

export const ORDNER = {
  eingang: 'Eingang',
  projekte: 'Projekte',
  themen: 'Themen',
  personen: 'Personen',
  tagebuch: 'Tagebuch',
  archiv: 'Archiv',
};
export const BRAIN_MAX = 3000;

const newId = () => Math.random().toString(36).slice(2, 10);
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Klingt nach etwas, das noch zu tun ist („ich muss noch …“, „nicht vergessen …“)? */
export const OPEN_RE = /\b(ich muss( noch)?|ich sollte( noch)?|ich wollte( noch)?|nicht vergessen|noch erledigen|to-?do|muss ich( noch)?|denk dran|daran denken)\b/i;

/** Neue Notiz (fehlende Felder ergänzt). */
export function makeNote(f = {}, now = Date.now()) {
  const text = String(f.text ?? '').trim().slice(0, 20000);
  const titel = clean(f.titel, 140) || clean(text.split('\n')[0], 80) || 'Notiz';
  const ordner = ORDNER[f.ordner] ? f.ordner : 'eingang';
  return {
    id: f.id ?? newId(),
    titel,
    text,
    ordner,
    tags: [...new Set((f.tags ?? []).map((t) => clean(String(t).replace(/^#/, ''), 40).toLowerCase()).filter(Boolean))].slice(0, 12),
    ...(f.projekt ? { projekt: clean(f.projekt, 80) } : {}),
    // Ort (Name eines gemerkten Orts oder einer Gruppe): beim Ankommen dort zeigt die Figur die Notiz
    ...(clean(f.ort, 60) ? { ort: clean(f.ort, 60) } : {}),
    ...(f.offen || (f.offen == null && OPEN_RE.test(`${titel} ${text}`)) ? { offen: true } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(f.faellig ?? '') ? { faellig: f.faellig } : {}),
    quelle: f.quelle ?? 'nutzer',
    ...(f.sortiert ? { sortiert: true } : {}),
    created: f.created ?? now,
    changed: f.changed ?? now,
  };
}

/** Offene Punkte: noch nicht erledigt, Fällige zuerst. */
export function openLoops(notes, max = 20) {
  return (notes ?? [])
    .filter((n) => n.offen && !n.erledigt)
    .sort((a, b) => (a.faellig ?? '9999') .localeCompare(b.faellig ?? '9999') || b.changed - a.changed)
    .slice(0, max);
}

/** Notiz per Kennung oder (Teil des) Titel finden. */
export function findNote(notes, ref) {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return null;
  return notes.find((n) => n.id === ref) ?? notes.find((n) => n.titel.toLowerCase() === r) ?? notes.find((n) => n.titel.toLowerCase().includes(r)) ?? null;
}

// ---------------------------------------------------------------- Markdown (Obsidian)
const yamlStr = (s) => (/^[\w äöüÄÖÜß.-]*$/.test(s) && s.trim() === s && s !== '' ? s : JSON.stringify(s));
const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
/** Dateiname aus dem Titel (für Windows, Android und Obsidian unbedenklich). */
export function fileName(titel) {
  return (
    String(titel ?? 'Notiz')
      .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Notiz'
  );
}

/** Eine Notiz als Markdown mit Kopfdaten (YAML), wie Obsidian sie liest. */
export function noteToMarkdown(n) {
  const fm = [
    '---',
    `id: ${n.id}`,
    `titel: ${yamlStr(n.titel)}`,
    `ordner: ${n.ordner}`,
    n.tags?.length ? `tags: [${n.tags.map(yamlStr).join(', ')}]` : null,
    n.projekt ? `projekt: ${yamlStr(n.projekt)}` : null,
    n.ort ? `ort: ${yamlStr(n.ort)}` : null,
    n.offen ? 'offen: true' : null,
    n.erledigt ? `erledigt: ${iso(n.erledigt)}` : null,
    n.faellig ? `faellig: ${n.faellig}` : null,
    `quelle: ${n.quelle ?? 'nutzer'}`,
    `erstellt: ${iso(n.created)}`,
    `geaendert: ${iso(n.changed)}`,
    '---',
  ].filter(Boolean);
  const head = n.offen ? `- [${n.erledigt ? 'x' : ' '}] ${n.titel}\n\n` : '';
  return `${fm.join('\n')}\n# ${n.titel}\n\n${head}${n.text}\n`;
}

/** Markdown-Datei (mit oder ohne Kopfdaten) zurück in eine Notiz. */
export function markdownToNote(md, path = '') {
  let body = String(md ?? '').replace(/\r\n/g, '\n');
  const meta = {};
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
      else if (/^".*"$/.test(v)) {
        try {
          v = JSON.parse(v);
        } catch {}
      }
      meta[kv[1]] = v;
    }
    body = body.slice(m[0].length);
  }
  const folder = String(path).split('/').slice(-2, -1)[0] ?? '';
  const ordner = meta.ordner && ORDNER[meta.ordner] ? meta.ordner : Object.keys(ORDNER).find((k) => ORDNER[k].toLowerCase() === folder.toLowerCase()) ?? 'eingang';
  const h1 = body.match(/^# (.+)\n+/);
  const titel = meta.titel || h1?.[1] || String(path).split('/').pop()?.replace(/\.md$/i, '') || 'Notiz';
  if (h1) body = body.slice(h1[0].length);
  const task = body.match(/^- \[( |x)\] .*\n+/);
  if (task) body = body.slice(task[0].length);
  const ms = (s) => (s ? Date.parse(String(s).length <= 19 ? `${s}Z` : s) || undefined : undefined);
  const tags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? meta.tags.split(/[,\s]+/) : [];
  const n = makeNote({
    id: meta.id || undefined,
    titel,
    text: body.trim(),
    ordner,
    tags,
    projekt: meta.projekt,
    ort: meta.ort,
    offen: meta.offen === 'true' || !!task,
    faellig: meta.faellig,
    quelle: meta.quelle || 'import',
    created: ms(meta.erstellt),
    changed: ms(meta.geaendert),
  });
  if (meta.erledigt || task?.[1] === 'x') n.erledigt = ms(meta.erledigt) ?? Date.now();
  return n;
}

/**
 * Alle Notizen als Obsidian-Ordner: { Pfad: Markdown }. Je Ordner ein Unterordner, dazu „Start.md“ mit Übersicht und
 * offenen Punkten. Gleiche Titel bekommen eine Nummer, damit nichts überschrieben wird.
 */
export function exportVault(notes, { now = Date.now() } = {}) {
  const files = {};
  const used = new Set();
  const pathOf = new Map();
  for (const n of notes) {
    const dir = ORDNER[n.ordner] ?? ORDNER.eingang;
    let base = `${dir}/${fileName(n.titel)}`;
    for (let i = 2; used.has(base.toLowerCase()); i++) base = `${dir}/${fileName(n.titel)} ${i}`;
    used.add(base.toLowerCase());
    pathOf.set(n.id, base);
    files[`${base}.md`] = noteToMarkdown(n);
  }
  const link = (n) => `[[${pathOf.get(n.id)}|${n.titel}]]`;
  const loops = openLoops(notes, 200);
  const lines = [
    '# Second Brain',
    '',
    `Exportiert am ${new Date(now).toLocaleString('de-DE')} aus dem KI-Assistenten (${notes.length} Notizen).`,
    '',
    '## Offene Punkte',
    '',
    ...(loops.length ? loops.map((n) => `- [ ] ${link(n)}${n.faellig ? ` (fällig ${n.faellig})` : ''}`) : ['- keine']),
    '',
  ];
  for (const [key, label] of Object.entries(ORDNER)) {
    const list = notes.filter((n) => n.ordner === key).sort((a, b) => b.changed - a.changed);
    if (!list.length) continue;
    lines.push(`## ${label} (${list.length})`, '', ...list.slice(0, 50).map((n) => `- ${link(n)}`), '');
  }
  files['Start.md'] = lines.join('\n');
  return files;
}

/** Obsidian-Ordner (Pfad → Markdown) einlesen; „Start.md“ und Dateien außerhalb von .md werden übergangen. */
export function importVault(files) {
  const out = [];
  for (const [path, md] of Object.entries(files)) {
    if (!/\.md$/i.test(path) || /(^|\/)Start\.md$/i.test(path) || /(^|\/)\.(obsidian|trash)\//.test(path)) continue;
    out.push(markdownToNote(md, path));
  }
  return out;
}

/** Zusammenführen (Import oder Abgleich): gleiche Kennung = gleiche Notiz, die zuletzt geänderte gewinnt. */
export function mergeNotes(mine = [], theirs = [], { dead = () => false } = {}) {
  const byId = new Map();
  for (const n of [...mine, ...theirs]) {
    if (!n?.id || dead(n.id)) continue;
    const cur = byId.get(n.id);
    if (!cur || (n.changed ?? 0) > (cur.changed ?? 0) || ((n.changed ?? 0) === (cur.changed ?? 0) && JSON.stringify(n) > JSON.stringify(cur))) byId.set(n.id, { ...n });
  }
  const list = [...byId.values()].sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  // begrenzen: Erledigtes und Archiv zuerst weglassen
  while (list.length > BRAIN_MAX) {
    const i = list.findIndex((n) => n.ordner === 'archiv' || n.erledigt);
    list.splice(i < 0 ? 0 : i, 1);
  }
  return list;
}

/** Notizen als Text für die Figur (Auszüge passend zur Frage bzw. offene Punkte). */
export function brainPrompt(hits, loops = [], lang = 'de') {
  const en = lang === 'en';
  const parts = [];
  if (hits.length) {
    parts.push(
      (en
        ? 'From the user’s Second Brain (their own notes – if one clearly fits, bring it up yourself briefly, e.g. “you noted …”, naming the title):\n'
        : 'Aus dem Second Brain deines Gegenübers (eigene Notizen – passt eine deutlich, bring sie von dir aus kurz ein, z. B. „Dazu hattest du notiert …“, mit Titel):\n') +
        hits.map((n) => `- „${n.titel}“ [${ORDNER[n.ordner] ?? n.ordner}${n.projekt ? ` · ${n.projekt}` : ''}]: ${clean(n.text, 500)}`).join('\n'),
    );
  }
  if (loops.length) {
    parts.push((en ? 'Open items:\n' : 'Offene Punkte:\n') + loops.map((n) => `- ${n.titel}${n.faellig ? ` (fällig ${n.faellig})` : ''}`).join('\n'));
  }
  return parts.join('\n\n');
}

/** Hilfsmodell sortiert den Eingang: Ordner, Projekt, Stichworte, ggf. besserer Titel. Antwort als JSON-Liste. */
export const INBOX_PROMPT =
  'Du sortierst Notizen in ein persönliches Second Brain. Ordner: projekte (etwas mit Ziel/Ende), themen (Wissen, Interessen, ' +
  'Ideen), personen (über eine bestimmte Person), tagebuch (Erlebtes, Gefühle), archiv (Erledigtes, nicht mehr wichtig). ' +
  'Gib für jede Notiz zurück: {"id":…, "ordner":…, "projekt": Name oder null, "tags": [2–5 kurze Stichworte, klein], ' +
  '"titel": kurzer treffender Titel, "offen": true, wenn noch etwas zu tun ist}. Bestehende Projekte bevorzugen, wenn sie ' +
  'passen. Antworte NUR mit einer JSON-Liste.';

/** Antwort des Hilfsmodells lesen; unbekannte Ordner fallen weg. */
export function parseInbox(text) {
  const m = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).filter((x) => x?.id && ORDNER[x.ordner] && x.ordner !== 'eingang');
  } catch {
    return [];
  }
}

/** Hilfsmodell: passende Notizen auch über Umschreibungen finden (bekommt nur Titel, Projekt und Stichworte). */
export const BRAIN_PICK_PROMPT =
  'Unten stehen eine Frage und eine Liste von Notizen (Kennung | Titel | Projekt | Stichworte). Welche Notizen passen ' +
  'inhaltlich zur Frage – auch wenn andere Wörter benutzt werden (Synonyme, Oberbegriffe, andere Sprache)? Antworte NUR ' +
  'mit JSON: {"ids": ["…", …]} – höchstens 5, die passendste zuerst, leere Liste, wenn nichts passt.';
export function brainPickInput(q, notes, max = 300) {
  const list = notes.slice(-max).map((n) => `${n.id} | ${n.titel} | ${n.projekt ?? ''} | ${(n.tags ?? []).join(', ')}`);
  return `Frage: ${q}\n\nNotizen:\n${list.join('\n')}`;
}
export function parsePick(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  try {
    const ids = JSON.parse(m?.[0] ?? '{}').ids;
    return Array.isArray(ids) ? ids.map(String).slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Kalenderwoche (ISO) als „KW 43/2026“. */
export function isoWeek(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const w = 1 + Math.round(((d - w1) / 86400e3 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `KW ${w}/${d.getFullYear()}`;
}
/** Was in der Woche im Second Brain passiert ist (Grundlage für den Rückblick). */
export function weekFacts(notes, since, now = Date.now()) {
  const neu = notes.filter((n) => (n.created ?? 0) >= since && n.quelle !== 'rueckblick');
  const erledigt = notes.filter((n) => (n.erledigt ?? 0) >= since);
  const offen = openLoops(notes, 15);
  const faellig = offen.filter((n) => n.faellig && Date.parse(`${n.faellig}T23:59`) < now + 7 * 86400e3);
  const projekte = [...new Set(neu.map((n) => n.projekt).filter(Boolean))];
  return { neu, erledigt, offen, faellig, projekte };
}
/** Rückblick als Markdown ohne Sprachmodell (Rückfall, wenn keines erreichbar ist). */
export function weekMarkdown(f) {
  const li = (l) => (l.length ? l.map((n) => `- ${n.titel}${n.faellig ? ` (fällig ${n.faellig})` : ''}`).join('\n') : '- –');
  return [`## Neu (${f.neu.length})`, li(f.neu.slice(0, 20)), '', `## Erledigt (${f.erledigt.length})`, li(f.erledigt), '', `## Noch offen (${f.offen.length})`, li(f.offen), ...(f.projekte.length ? ['', `## Projekte mit Bewegung`, f.projekte.map((p) => `- ${p}`).join('\n')] : [])].join('\n');
}
export const BRAIN_WEEK_PROMPT =
  'Schreib den Wochenrückblick für das Second Brain deines Gegenübers – kurz, klar, freundlich, auf Deutsch, als Markdown: ' +
  'zuerst 2–3 Sätze, was diese Woche los war und wo es vorangeht; dann „## Erledigt“, „## Noch offen“ (Fälliges zuerst) ' +
  'und „## Vorschlag für nächste Woche“ mit höchstens 3 konkreten Punkten. Nur, was unten steht – nichts erfinden.';

// ---------------------------------------------------------------- Datei zum Mitnehmen (Handy ↔ PC)
/**
 * Second Brain als eine Datei (.kibrain): die Notizen deines Gegenübers und die eigenen Notizbücher der Figuren.
 * figuren: { [personaId]: { name, notizen } }.
 */
export function brainFile({ nutzer = [], figuren = {}, bereich = 'privat', now = Date.now() } = {}) {
  return { typ: 'ki-brain', version: 1, bereich, exportiert: now, nutzer, figuren };
}
/** .kibrain lesen (wirft bei fremden Dateien). */
export function readBrainFile(text) {
  const d = typeof text === 'string' ? JSON.parse(text) : text;
  if (d?.typ !== 'ki-brain') throw new Error('Das ist keine Second-Brain-Datei (.kibrain).');
  const fix = (l) => (Array.isArray(l) ? l.filter((n) => n?.id && n.titel != null).map((n) => ({ ...makeNote(n), ...n })) : []);
  const figuren = {};
  for (const [id, f] of Object.entries(d.figuren ?? {})) figuren[id] = { name: String(f?.name ?? ''), notizen: fix(f?.notizen) };
  return { bereich: d.bereich, exportiert: d.exportiert, nutzer: fix(d.nutzer), figuren };
}
