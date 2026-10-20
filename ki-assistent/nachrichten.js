// Nachrichten des Tages aus RSS-Feeds (ohne Schlüssel): Welt, Deutschland, Wirtschaft (tagesschau.de) und Lokales
// (Google News zum Ort). Hinaus geht höchstens der Ortsname – nichts aus dem Gespräch.

const { weather } = require('./wetter.js');

// je Bereich mehrere Quellen: die erste, die Meldungen liefert, gilt
const gnews = (q) => `https://news.google.com/rss/search?hl=de&gl=DE&ceid=DE:de&q=${encodeURIComponent(q)}`;
const FEEDS = {
  welt: ['https://www.tagesschau.de/ausland/index~rss2.xml', gnews('Weltnachrichten when:1d')],
  deutschland: ['https://www.tagesschau.de/inland/index~rss2.xml', 'https://www.tagesschau.de/index~rss2.xml', gnews('Deutschland when:1d')],
  wirtschaft: ['https://www.tagesschau.de/wirtschaft/index~rss2.xml', gnews('Wirtschaft when:1d')],
};
const BEREICHE = ['lokal', 'wetter', 'wirtschaft', 'deutschland', 'welt'];

const entities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
// Feeds schicken HTML oft doppelt verpackt (&amp;lt;p&amp;gt;) – zweimal entpacken, dann Tags entfernen
const decode = (s) =>
  entities(entities(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tag = (item, name) => decode(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1]);

/** RSS lesen: Titel, kurze Beschreibung, Zeit, Quelle (ohne XML-Bibliothek – Feeds sind einfach genug). */
function parseRss(xml, max = 6) {
  const items = String(xml ?? '').match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    let titel = tag(it, 'title');
    const quelle = tag(it, 'source');
    // Google News hängt die Quelle an den Titel („… - NDR“)
    if (quelle && titel.endsWith(` - ${quelle}`)) titel = titel.slice(0, -quelle.length - 3);
    const key = titel.toLowerCase().slice(0, 60);
    if (!titel || seen.has(key)) continue;
    seen.add(key);
    let text = tag(it, 'description');
    if (text.startsWith(titel)) text = text.slice(titel.length).trim();
    if (quelle && text.endsWith(quelle)) text = text.slice(0, -quelle.length).trim();
    const t = Date.parse(tag(it, 'pubDate'));
    out.push({ titel, ...(text ? { kurz: text.slice(0, 220) } : {}), ...(quelle ? { quelle } : {}), ...(t ? { zeit: new Date(t).toISOString() } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

async function firstFeed(urls, fetchFn, max) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseRss(await res.text(), max);
      if (items.length) return items;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('keine Meldungen');
}

/**
 * Tagesüberblick. bereiche: Auswahl aus lokal, wetter, wirtschaft, deutschland, welt (leer = alle);
 * ort: für Lokales und Wetter. Liefert je Bereich die wichtigsten Meldungen (Titel + kurzer Text).
 */
async function news({ bereiche, ort, anzahl = 5 } = {}, { fetchFn = fetch } = {}) {
  const want = (Array.isArray(bereiche) && bereiche.length ? bereiche : BEREICHE).map((b) => String(b).toLowerCase()).filter((b) => BEREICHE.includes(b));
  const max = Math.max(2, Math.min(8, Math.round(Number(anzahl) || 5)));
  const place = String(ort ?? '').split(',')[0].trim();
  const out = { stand: new Date().toISOString() };
  await Promise.all(
    want.map(async (b) => {
      try {
        if (b === 'wetter') {
          if (!place) throw new Error('kein Ort bekannt');
          const w = await weather({ ort, tage: 1 }, { fetchFn });
          out.wetter = { ort: w.ort, jetzt: w.jetzt, heute: w.tage[0] };
        } else if (b === 'lokal') {
          if (!place) throw new Error('kein Ort bekannt');
          out.lokal = { ort: place, meldungen: await firstFeed([gnews(`${place} when:1d`), gnews(place)], fetchFn, max) };
        } else {
          out[b] = await firstFeed(FEEDS[b], fetchFn, max);
        }
      } catch (e) {
        out[b] = { fehler: e.message };
      }
    }),
  );
  return out;
}

module.exports = { news, parseRss, BEREICHE };
