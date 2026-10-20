// Wetter über Open-Meteo (frei, ohne Schlüssel): Ort → Koordinaten → aktuelles Wetter, die nächsten Stunden und Tage.
// Es geht nur der Ortsname bzw. die Koordinaten an Open-Meteo – nichts aus dem Gespräch.

const WMO = {
  0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt', 45: 'Nebel', 48: 'Nebel mit Reif',
  51: 'leichter Nieselregen', 53: 'Nieselregen', 55: 'starker Nieselregen', 56: 'gefrierender Nieselregen', 57: 'gefrierender Nieselregen',
  61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen', 67: 'starker gefrierender Regen',
  71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall', 77: 'Schneegriesel',
  80: 'leichte Regenschauer', 81: 'Regenschauer', 82: 'heftige Regenschauer', 85: 'Schneeschauer', 86: 'starke Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'schweres Gewitter mit Hagel',
};
const wmo = (c) => WMO[c] ?? 'unbekannt';
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Ort suchen: erst der ganze Text, dann nur der Teil vor dem ersten Komma („Hannover, Niedersachsen“). */
async function geocode(place, fetchFn) {
  const tries = [...new Set([place, place.split(',')[0]].map((s) => s.trim()).filter(Boolean))];
  for (const name of tries) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=de&format=json&name=${encodeURIComponent(name)}`;
    const j = await (await fetchFn(url)).json();
    const g = j?.results?.[0];
    if (g) return { name: [g.name, g.admin1, g.country_code !== 'DE' ? g.country : null].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude };
  }
  return null;
}

/**
 * Wetter abrufen. ort: Ortsname; tage: 1–7 (Vorhersage). Liefert eine kompakte Übersicht zum Vorlesen.
 * fetchFn: fetch der jeweiligen Umgebung (Electron net.fetch bzw. WebView-fetch).
 */
async function weather({ ort, tage = 2 } = {}, { fetchFn = fetch } = {}) {
  const place = String(ort ?? '').trim();
  if (!place) throw new Error('kein Ort angegeben und kein Standort bekannt');
  const g = await geocode(place, fetchFn);
  if (!g) throw new Error(`Ort „${place}“ nicht gefunden`);
  const days = Math.max(1, Math.min(7, Math.round(Number(tage) || 2)));
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&timezone=auto&forecast_days=${days}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,relative_humidity_2m' +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset';
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Wetterdienst antwortet nicht (${res.status})`);
  const j = await res.json();
  const c = j.current ?? {};
  // die nächsten 12 Stunden in Dreierschritten
  const h = j.hourly ?? {};
  const now = String(c.time ?? '').slice(0, 13);
  let i0 = (h.time ?? []).findIndex((t) => t.slice(0, 13) >= now);
  if (i0 < 0) i0 = 0;
  const stunden = [];
  for (let i = i0 + 3; i <= i0 + 12 && i < (h.time?.length ?? 0); i += 3) {
    stunden.push({ zeit: h.time[i].slice(11, 16), temp: r1(h.temperature_2m[i]), wetter: wmo(h.weather_code[i]), regenwahrscheinlichkeit: h.precipitation_probability?.[i] ?? null });
  }
  const d = j.daily ?? {};
  const tageListe = (d.time ?? []).map((t, i) => ({
    datum: t,
    wetter: wmo(d.weather_code[i]),
    min: r1(d.temperature_2m_min[i]),
    max: r1(d.temperature_2m_max[i]),
    regenwahrscheinlichkeit: d.precipitation_probability_max?.[i] ?? null,
    regen_mm: r1(d.precipitation_sum?.[i]),
    wind_max_kmh: r1(d.wind_speed_10m_max?.[i]),
    sonnenaufgang: d.sunrise?.[i]?.slice(11, 16),
    sonnenuntergang: d.sunset?.[i]?.slice(11, 16),
  }));
  return {
    ort: g.name,
    quelle: 'Open-Meteo (Deutscher Wetterdienst u. a.)',
    jetzt: {
      zeit: String(c.time ?? '').slice(11, 16),
      temp: r1(c.temperature_2m),
      gefuehlt: r1(c.apparent_temperature),
      wetter: wmo(c.weather_code),
      wind_kmh: r1(c.wind_speed_10m),
      boeen_kmh: r1(c.wind_gusts_10m),
      niederschlag_mm: r1(c.precipitation),
      luftfeuchte: c.relative_humidity_2m ?? null,
    },
    naechste_stunden: stunden,
    tage: tageListe,
  };
}

module.exports = { weather, wmo };
