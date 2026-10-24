// Begleiter bei geschlossener App (Android, Bereich Privat): Morgen- und Feierabendrunde als Benachrichtigung zur
// gewählten Uhrzeit, die Nachtschicht (ein Arbeitsschritt an einem Vorhaben, nachts beim Laden im WLAN) und
// Erinnerungen an Orten. Hier stehen nur Planung und Texte – geplant und ausgeführt wird auf dem Gerät
// (KIReminder, KINachtschicht, KIOrt) bzw. in app.js.

const dayKey = (ms) => new Date(ms).toLocaleDateString('sv-SE');
const hm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Nächster Zeitpunkt für „HH:MM“ – heute, oder morgen, wenn vorbei bzw. die Runde heute schon war. */
export function nextAt(hhmm, doneDay, now = Date.now()) {
  const mt = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/);
  if (!mt) return null;
  const [h, m] = [Number(mt[1]), Number(mt[2])];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now || doneDay === dayKey(now)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Vorschau-Text für die Benachrichtigung (aus dem, was auf dem Gerät liegt): Termine des Tages (falls bekannt),
 * eigene Erinnerungen, offene Punkte, Vorhaben mit Neuigkeiten. kind: 'morning' | 'evening'.
 */
export function roundPreview(kind, at, { termine = [], erinnerungen = [], offen = 0, vorhaben = [], heute = [], name = '' } = {}) {
  const day = dayKey(at);
  const tm = termine.filter((t) => String(t.beginn ?? '').slice(0, 10) === day).sort((a, b) => String(a.beginn).localeCompare(String(b.beginn)));
  const er = erinnerungen.filter((r) => !r.ack && dayKey(r.at) === day && (kind === 'morning' || r.at > at));
  const parts = [];
  if (kind === 'morning') {
    if (tm.length) {
      const first = tm[0];
      const time = String(first.beginn).length > 10 ? `${hm(Date.parse(first.beginn))} ` : '';
      parts.push(`${tm.length === 1 ? '1 Termin' : `${tm.length} Termine`} (zuerst ${time}${first.titel})`);
    }
    if (er.length) parts.push(er.length === 1 ? `Erinnerung: ${er[0].text}` : `${er.length} Erinnerungen`);
    if (offen) parts.push(offen === 1 ? '1 offener Punkt' : `${offen} offene Punkte`);
    const news = vorhaben.filter((v) => v.neu);
    if (news.length) parts.push(`Neues zu „${news[0].titel}“`);
    return {
      title: `☀️ Guten Morgen${name ? ` von ${name}` : ''}`,
      text: `${parts.length ? `Heute: ${parts.join(' · ')}. ` : ''}Antippen für die Morgenrunde.`,
    };
  }
  const left = heute.filter((h) => !h.erledigt);
  if (left.length) parts.push(left.length === 1 ? `noch offen von heute: ${left[0].titel}` : `${left.length} der wichtigsten Dinge von heute noch offen`);
  else if (heute.length) parts.push('die wichtigsten Dinge von heute sind erledigt');
  if (offen) parts.push(offen === 1 ? '1 offener Punkt' : `${offen} offene Punkte`);
  return {
    title: `🌆 Feierabend?`,
    text: `${parts.length ? `${parts.join(' · ').replace(/^./, (c) => c.toUpperCase())}. ` : ''}Antippen für den Tagesrückblick.`,
  };
}

/** Benachrichtigungen für die Runden (Schlüssel runde:m:… / runde:f:… – ohne Erledigt-Knöpfe). */
export function roundItems(cfg, data, now = Date.now()) {
  const out = [];
  if (cfg.morning) {
    const at = nextAt(cfg.morningAt || '07:30', cfg.morningDay, now);
    if (at) out.push({ key: `runde:m:${dayKey(at)}`, at, ...roundPreview('morning', at, data) });
  }
  if (cfg.evening) {
    const at = nextAt(cfg.eveningAt || '18:00', cfg.eveningDay, now);
    if (at) out.push({ key: `runde:f:${dayKey(at)}`, at, ...roundPreview('evening', at, data) });
  }
  return out;
}

// ---------------------------------------------------------------- Nachtschicht
export const NIGHT_FROM = 1; // frühestens ab 1 Uhr …
export const NIGHT_TO = 6; // … und bis 6 Uhr (danach wartet der Auftrag auf die nächste Nacht)

/**
 * Auftrag für die Nachtschicht: fertige Anfrage an Claude (ohne Schlüssel – den setzt das Gerät aus seinem
 * Schlüsselspeicher), dazu, zu welcher Notiz und welchem Schritt sie gehört.
 */
export function nightJob({ model, system, input, noteId, step, tools = [] }) {
  return {
    noteId,
    step,
    created: Date.now(),
    body: {
      model,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: input }],
      output_config: { effort: 'low' },
      ...(/haiku/.test(model) ? { thinking: { type: 'disabled' } } : {}),
      ...(tools.length ? { tools } : {}),
    },
  };
}

/** Ergebnis der Nachtschicht (Antwort von Claude, ggf. aus mehreren Runden) → Text und Verbrauch. */
export function readNightResult(raw) {
  let r;
  try {
    r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!r || !r.noteId) return null;
  const msgs = Array.isArray(r.antworten) ? r.antworten : [];
  const text = msgs
    .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  const use = msgs.reduce(
    (a, m) => ({
      in: a.in + (m?.usage?.input_tokens ?? 0),
      out: a.out + (m?.usage?.output_tokens ?? 0),
      cacheRead: a.cacheRead + (m?.usage?.cache_read_input_tokens ?? 0),
      searches: a.searches + (m?.usage?.server_tool_use?.web_search_requests ?? 0),
    }),
    { in: 0, out: 0, cacheRead: 0, searches: 0 },
  );
  return { noteId: r.noteId, step: r.step, t: r.t, error: r.fehler || null, text, use, model: msgs[0]?.model ?? r.model ?? '' };
}

// ---------------------------------------------------------------- Erinnerungen an Orten
export const ORT_RADIUS = 150; // Meter
export const ORTE_MAX = 20;

/** Ort zu einem Namen („beim Supermarkt“, „zu Hause“) aus der Liste der gemerkten Orte. */
export function findOrt(orte, q) {
  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/\b(beim|bei|im|in|am|an|zum|zur|zu|der|die|das|dem|den|mein|meine|meinem|meiner)\b/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const n = norm(q);
  if (!n) return null;
  return orte.find((o) => norm(o.name) === n) ?? orte.find((o) => norm(o.name).includes(n) || n.includes(norm(o.name))) ?? null;
}

/** Was das Gerät überwachen soll: je Ort mit offenen Erinnerungen ein Bereich (Mittelpunkt, Radius, Texte). */
export function ortWatch(orte, erinnerungen) {
  return orte
    .map((o) => ({ id: o.id, name: o.name, lat: o.lat, lon: o.lon, radius: o.radius || ORT_RADIUS, texte: erinnerungen.filter((r) => r.ort === o.id && !r.ack).map((r) => ({ id: r.id, text: r.text })) }))
    .filter((w) => w.texte.length && Number.isFinite(w.lat) && Number.isFinite(w.lon));
}
