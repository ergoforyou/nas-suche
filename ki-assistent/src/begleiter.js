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

// ---------------------------------------------------------------- Orte und Situationen
// Ein Ort kann auf drei Arten erkannt werden: Umkreis um einen Punkt (Adresse, Kontakt oder „hier“), ein WLAN
// („Zuhause“ = mit dem Heim-WLAN verbunden – genau, auch im Haus, ohne GPS) oder ein Bluetooth-Gerät (das Auto).
// Gemerkte Orte bleiben nur auf dem Handy. Erinnerungen an einem Ort: beim Ankommen oder Verlassen, einmal oder jedes
// Mal, optional nur in einem Zeitfenster und/oder werktags; Ort kann auch eine Gruppe sein („Supermarkt“).
export const ORT_RADIUS = 200; // Meter
export const ORT_RADIEN = [100, 200, 300, 500, 1000];
export const ORTE_MAX = 30;

const normOrt = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\b(wenn|sobald|ich|bin|bist|sind|wieder|komme|ankomme|beim|bei|im|in|am|an|auf|nach|vom|von|zum|zur|zu|der|die|das|dem|den|mein|meine|meinem|meiner|meinen|irgendeinem|einem|einen|ein|einer)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** „zu Hause“, „daheim“, „Zuhause“ meinen dasselbe – ebenso „Arbeit“ und „Büro“. */
const ALIAS = { hause: 'zuhause', daheim: 'zuhause', zuhause: 'zuhause', home: 'zuhause', arbeit: 'buero', buero: 'buero', firma: 'buero', office: 'buero' };
const canon = (s) => {
  const n = normOrt(s);
  return ALIAS[n] ?? ALIAS[n.replace(/\s+/g, '')] ?? n;
};
/** Schlüssel einer Ortsgruppe in Erinnerungen („gruppe:supermarkt“). */
export const gruppenKey = (g) => `gruppe:${canon(g)}`;
export const isHome = (o) => canon(o?.name) === 'zuhause';
export const isOffice = (o) => canon(o?.name) === 'buero';

/** Ort oder Gruppe zu einem Namen („beim Supermarkt“, „zu Hause“). Liefert { ort } oder { gruppe, orte } oder null. */
export function findOrt(orte, q) {
  const n = canon(q);
  if (!n) return null;
  const exact = orte.find((o) => canon(o.name) === n);
  if (exact) return exact;
  const group = orte.filter((o) => o.gruppe && canon(o.gruppe) === n);
  if (group.length) return { gruppe: group[0].gruppe, orte: group };
  return orte.find((o) => canon(o.name).includes(n) || n.includes(canon(o.name))) ?? null;
}
/** Wie das Gerät den Ort erkennt (für Anzeige und Hilfe). */
export const ortArt = (o) => (o.bt ? 'auto' : o.ssid ? 'wlan' : o.adresse ? 'adresse' : 'standort');

/** „17:30“ / „17 Uhr“ / 17 → „17:30“ bzw. null. */
export function hhmm(v) {
  const m = String(v ?? '').match(/(\d{1,2})(?:[:.](\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
}
/** Passt der Zeitpunkt in das Fenster einer Erinnerung (von/bis, nur werktags)? Fenster über Mitternacht geht. */
export function inWindow(r, now = Date.now()) {
  const d = new Date(now);
  if (r.werktags && (d.getDay() === 0 || d.getDay() === 6)) return false;
  const min = d.getHours() * 60 + d.getMinutes();
  const toMin = (s) => (s ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) : null);
  const a = toMin(r.von);
  const b = toMin(r.bis);
  if (a == null && b == null) return true;
  if (a != null && b != null) return a <= b ? min >= a && min < b : min >= a || min < b;
  return a != null ? min >= a : min < b;
}
/** Kurze Beschreibung der Bedingung: „beim Ankommen, jedes Mal, ab 17:00, werktags“. */
export function wannText(r) {
  return [
    r.wann === 'weg' ? 'beim Verlassen' : 'beim Ankommen',
    r.jedes ? 'jedes Mal' : null,
    r.von && r.bis ? `${r.von}–${r.bis} Uhr` : r.von ? `ab ${r.von} Uhr` : r.bis ? `bis ${r.bis} Uhr` : null,
    r.werktags ? 'werktags' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Was das Gerät überwachen soll. Je Ort: wie er erkannt wird (Umkreis, WLAN, Bluetooth) und welche Einträge beim
 * Ankommen/Verlassen erscheinen – Erinnerungen (auch über Gruppen), Notizen mit diesem Ort, Feierabendrunde beim
 * Heimkommen, Verkehrslage beim Verlassen des Büros. Bedingungen (Zeitfenster, werktags, „schon erledigt am …“) prüft
 * das Gerät selbst, die App muss dafür nicht laufen.
 */
export function ortWatch(orte, erinnerungen, { notizen = [], heimRunde = null, verkehr = false } = {}) {
  return orte
    .map((o) => {
      const mine = (r) => r.ort === o.id || (o.gruppe && r.ort === gruppenKey(o.gruppe));
      const texte = erinnerungen
        .filter((r) => mine(r) && !r.ack)
        .map((r) => ({ id: r.id, text: r.text, wann: r.wann === 'weg' ? 'weg' : 'an', ...(r.jedes ? { jedes: true } : {}), ...(r.von ? { von: r.von } : {}), ...(r.bis ? { bis: r.bis } : {}), ...(r.werktags ? { werktags: true } : {}) }));
      const notes = notizen.filter((n) => n.ort && !n.erledigt && (canon(n.ort) === canon(o.name) || (o.gruppe && canon(n.ort) === canon(o.gruppe))));
      if (notes.length) texte.push({ id: `notizen:${o.id}`, art: 'notiz', wann: 'an', jedes: true, text: notes.map((n) => n.titel).slice(0, 6).join(' · '), anzahl: notes.length });
      if (heimRunde && isHome(o)) texte.push({ id: 'runde:heim', art: 'runde', wann: 'an', jedes: true, von: heimRunde.ab || '16:00', bis: '22:30', erledigt: heimRunde.erledigt || '' });
      if (verkehr && isOffice(o)) texte.push({ id: 'verkehr:heim', art: 'verkehr', wann: 'weg', jedes: true, von: '15:00', bis: '21:00', werktags: true });
      return {
        id: o.id,
        name: o.name,
        ...(Number.isFinite(o.lat) && Number.isFinite(o.lon) ? { lat: o.lat, lon: o.lon, radius: o.radius || ORT_RADIUS } : {}),
        ...(o.ssid ? { ssid: o.ssid } : {}),
        ...(o.bt ? { bt: o.bt } : {}),
        texte,
      };
    })
    .filter((w) => w.texte.length && (w.lat != null || w.ssid || w.bt));
}

/** Was gerade „hier“ ansteht: offene Erinnerungen und Notizen für die Orte, an denen man gerade ist. */
export function hereNow(orte, drinIds, erinnerungen, notizen = []) {
  const here = orte.filter((o) => drinIds.includes(o.id));
  const out = [];
  for (const o of here) {
    const er = erinnerungen.filter((r) => !r.ack && (r.ort === o.id || (o.gruppe && r.ort === gruppenKey(o.gruppe))));
    const no = notizen.filter((n) => n.ort && !n.erledigt && (canon(n.ort) === canon(o.name) || (o.gruppe && canon(n.ort) === canon(o.gruppe))));
    out.push({ ort: o.name, erinnerungen: er.map((r) => `${r.text} (${wannText(r)})`), notizen: no.map((n) => n.titel) });
  }
  return out;
}
