// Verkehr auf Autobahnen über den freien Dienst der Autobahn GmbH (verkehr.autobahn.de, ohne Schlüssel):
// Verkehrsmeldungen (Stau, Unfall), Sperrungen und Baustellen je Autobahn. Hinaus geht nur die Autobahn-Nummer.

const BASE = 'https://verkehr.autobahn.de/o/autobahn';

/** „A 2“, „a2“, „Autobahn 7“ → „A2“ (sonst null). */
function roadId(s) {
  const m = String(s ?? '').match(/\b(?:a|autobahn)\s*-?\s*(\d{1,3})\b/i) ?? String(s ?? '').match(/^\s*(\d{1,3})\s*$/);
  return m ? `A${Number(m[1])}` : null;
}

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const lines = (d) => (Array.isArray(d) ? d.map(clean).filter(Boolean).join(' ') : clean(d));

/** Eine Meldung kompakt (Titel, Abschnitt, Beschreibung gekürzt, ggf. Länge/Verzögerung). */
function item(x) {
  const text = lines(x.description);
  const delay = text.match(/(\d+)\s*Minuten?\s*(Zeitverlust|Verzögerung)/i)?.[1];
  const len = text.match(/(\d+(?:[.,]\d+)?)\s*km\s*(Stau|stockender|Länge)/i)?.[1];
  return {
    titel: clean(x.title),
    abschnitt: clean(x.subtitle),
    text: text.slice(0, 260),
    ...(delay ? { verzoegerung_min: Number(delay) } : {}),
    ...(len ? { stau_km: String(len) } : {}),
    ...(x.startTimestamp ? { seit: String(x.startTimestamp).slice(0, 16).replace('T', ' ') } : {}),
  };
}

/**
 * Verkehrslage einer Autobahn. ort: optional – nur Meldungen, deren Abschnitt diesen Ort/diese Anschlussstelle nennt.
 * fetchFn: fetch der Umgebung (Electron net.fetch bzw. nativ auf dem Handy).
 */
async function traffic({ autobahn, ort } = {}, { fetchFn = fetch } = {}) {
  const id = roadId(autobahn);
  if (!id) throw new Error('Welche Autobahn? (z. B. A2)');
  const get = async (kind) => {
    const res = await fetchFn(`${BASE}/${id}/services/${kind}`);
    if (res.status === 404) throw new Error(`${id} ist nicht bekannt`);
    if (!res.ok) throw new Error(`Verkehrsdienst antwortet nicht (${res.status})`);
    return res.json();
  };
  const [w, c, r] = await Promise.all([get('warning'), get('closure').catch(() => ({})), get('roadworks').catch(() => ({}))]);
  const f = String(ort ?? '').trim().toLowerCase();
  const near = (x) => !f || `${x.title} ${x.subtitle} ${lines(x.description)}`.toLowerCase().includes(f);
  const warnings = (w.warning ?? []).filter(near);
  const closures = (c.closure ?? []).filter(near);
  // Baustellen nur mit spürbarer Wirkung (Sperrung, Engstelle) – die Liste ist sonst sehr lang
  const works = (r.roadworks ?? []).filter((x) => near(x) && (x.isBlocked === 'true' || x.isBlocked === true || /sperr|einspurig|nur ein fahrstreifen/i.test(lines(x.description))));
  return {
    autobahn: id,
    ...(f ? { gefiltert_nach: ort } : {}),
    quelle: 'Autobahn GmbH des Bundes',
    meldungen: warnings.slice(0, 8).map(item),
    sperrungen: closures.slice(0, 5).map(item),
    baustellen_mit_sperrung: works.slice(0, 5).map(item),
    anzahl: { meldungen: warnings.length, sperrungen: closures.length, baustellen: works.length },
  };
}

module.exports = { traffic, roadId };
