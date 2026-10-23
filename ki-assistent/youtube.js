// YouTube-Suche ohne Schlüssel: die Ergebnisseite lesen und die Videos daraus nehmen (Titel, Kanal, Länge, Kennung).
// Hinaus geht nur der Suchbegriff. Abgespielt wird dann in der YouTube-App des Handys.

/** Videos aus der Ergebnisseite (ytInitialData) – höchstens max, ohne Werbung, Shorts und Livestreams zuerst. */
function parseResults(html, max = 5) {
  const m = String(html ?? '').match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 40 || out.length >= max) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    const v = o.videoRenderer;
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? '';
      const live = (v.badges ?? []).some((b) => /LIVE/i.test(b?.metadataBadgeRenderer?.style ?? ''));
      out.push({ id: v.videoId, titel: text(v.title), kanal: text(v.ownerText ?? v.longBylineText), laenge: text(v.lengthText) || (live ? 'live' : ''), aufrufe: text(v.shortViewCountText) });
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(data);
  return out;
}

/** Suchen; fetchFn(url, headers) → { ok, status, text() } (Handy: nativ, ohne Browser-Sperren). */
async function search(q, { fetchFn, max = 5 } = {}) {
  const query = String(q ?? '').trim();
  if (!query) throw new Error('Wonach suchen?');
  const res = await fetchFn(`https://www.youtube.com/results?hl=de&gl=DE&search_query=${encodeURIComponent(query)}`, {
    'Accept-Language': 'de-DE,de;q=0.9',
    // ohne Zustimmungs-Seite (EU) direkt zu den Ergebnissen
    Cookie: 'CONSENT=YES+cb; SOCS=CAI',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  if (!res.ok) throw new Error(`YouTube antwortet nicht (${res.status})`);
  return parseResults(await res.text(), max);
}

module.exports = { parseResults, search };
