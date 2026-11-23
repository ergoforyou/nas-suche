// Internetsuche ohne Schlüssel (für alle KI-Anbieter, nicht nur Claude): DuckDuckGo (HTML-Ergebnisseite), ersatzweise
// Wikipedia; dazu den Text einer Seite lesen. Hinaus geht nur der Suchbegriff bzw. die Adresse – nichts aus dem Gespräch.
// fetchFn(url, { method, headers, body }) → { ok, status, text() } (am PC net.fetch, am Handy nativ ohne Browser-Sperren).

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'de-DE,de;q=0.9' };
const entities = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const clean = (s) => entities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** DuckDuckGo-Ergebnisseite lesen: Titel, Adresse, Kurztext. */
function parseDdg(html, max = 6) {
  const out = [];
  // je Treffer-Block: Klassen des Blocks merken (Werbung = result--ad)
  const parts = String(html ?? '').split(/(<div[^>]+class="[^"]*\bresult\b[^"]*")/i);
  for (let i = 1; i < parts.length; i += 2) {
    const b = parts[i] + (parts[i + 1] ?? '');
    if (/result--ad\b/i.test(parts[i])) continue; // Werbung
    const a = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = entities(a[1]);
    const ud = url.match(/[?&]uddg=([^&]+)/);
    if (ud) url = decodeURIComponent(ud[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snip = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i);
    out.push({ titel: clean(a[2]), url, text: clean(snip?.[1]).slice(0, 400) });
    if (out.length >= max) break;
  }
  return out;
}

async function searchWeb(q, { fetchFn, max = 6 } = {}) {
  const query = String(q ?? '').trim().slice(0, 300);
  if (!query) throw new Error('Suchbegriff fehlt');
  let hits = [];
  try {
    const r = await fetchFn(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=de-de`, { headers: UA });
    if (r.ok) hits = parseDdg(await r.text(), max);
  } catch {}
  if (hits.length) return { quelle: 'DuckDuckGo', treffer: hits };
  // Ersatz: Wikipedia (Wissen, keine Tagesaktualität)
  try {
    const r = await fetchFn(`https://de.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${max}&srsearch=${encodeURIComponent(query)}`, { headers: UA });
    const j = JSON.parse(await r.text());
    hits = (j?.query?.search ?? []).map((x) => ({ titel: x.title, url: `https://de.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, text: clean(x.snippet).slice(0, 400) }));
  } catch {}
  if (hits.length) return { quelle: 'Wikipedia', treffer: hits };
  throw new Error('Die Suche hat nichts gefunden (oder ist gerade nicht erreichbar)');
}

/** Lesbaren Text einer Seite holen (ohne Menüs, Skripte, Stile), gekürzt. */
async function readPage(url, { fetchFn, max = 6000 } = {}) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) throw new Error('ungültige Adresse');
  const r = await fetchFn(url, { headers: UA });
  if (!r.ok) throw new Error(`Seite antwortet mit ${r.status}`);
  const html = String(await r.text());
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).slice(0, 200);
  const body = (html.match(/<(main|article)[\s>][\s\S]*?<\/\1>/i)?.[0] ?? html)
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)[\s>][\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, '\n');
  const text = clean(body.replace(/\n/g, ' ¶ ')).replace(/( ¶ )+/g, '\n').trim();
  return { titel: title, url, text: text.slice(0, max) };
}

/** Grob: verlangt die Frage eine Recherche im Internet (für Modelle ohne Werkzeuge, z. B. LM Studio)? */
const RECHERCHE_RE =
  /\b(such(e|st)? (mal |bitte )?(im internet|online|im netz|im web|nach)|recherchier\w*|google (mal )?|schau (mal |bitte )?(im internet|online|im netz|nach,? (was|wie|wann|wo|ob))|im internet (nach)?schauen|aktuell(e|en|er|es)? (preis|kurs|stand|nachrichten|lage|zahlen)|was kostet (aktuell|gerade|im moment)|öffnungszeiten|neuigkeiten (zu|über|von)|was gibt es neues (zu|über|bei))\b/i;
const wantsSearch = (text) => RECHERCHE_RE.test(String(text ?? ''));

module.exports = { searchWeb, readPage, parseDdg, wantsSearch };
