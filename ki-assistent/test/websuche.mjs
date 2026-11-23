// Internetsuche (websuche.js): DuckDuckGo-Ergebnisse lesen, Ersatz Wikipedia, Seite lesen, Rechercheauftrag erkennen.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { searchWeb, readPage, parseDdg, wantsSearch } = require('../websuche.js');

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const ddg = `<div class="result results_links result--ad"><a class="result__a" href="https://ad.example">Werbung</a></div>
<div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.hannover.de%2Fzoo&amp;rut=x">Zoo <b>Hannover</b> – Öffnungszeiten</a></h2>
<a class="result__snippet" href="#">Täglich 9 &ndash; 18 Uhr, im Winter bis 16 Uhr.</a></div>
<div class="result results_links"><a class="result__a" href="https://de.wikipedia.org/wiki/Erlebnis-Zoo_Hannover">Erlebnis-Zoo Hannover</a><div class="result__snippet">Zoologischer Garten in Hannover.</div></div>`;
const hits = parseDdg(ddg);
check(hits.length === 2 && hits[0].url === 'https://www.hannover.de/zoo' && /Zoo Hannover/.test(hits[0].titel) && /9/.test(hits[0].text), 'DuckDuckGo-Treffer gelesen (ohne Werbung, echte Adresse)', JSON.stringify(hits));
const res = (body, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => body });
const s1 = await searchWeb('Zoo Hannover Öffnungszeiten', { fetchFn: async (u) => (u.includes('duckduckgo') ? res(ddg) : res('{}')) });
check(s1.quelle === 'DuckDuckGo' && s1.treffer.length === 2, 'Suche über DuckDuckGo');
const s2 = await searchWeb('Hannover', { fetchFn: async (u) => (u.includes('duckduckgo') ? res('<html>nichts</html>') : res(JSON.stringify({ query: { search: [{ title: 'Hannover', snippet: 'Landeshauptstadt <span>Niedersachsens</span>' }] } }))) });
check(s2.quelle === 'Wikipedia' && s2.treffer[0].url.includes('wikipedia.org/wiki/Hannover') && s2.treffer[0].text === 'Landeshauptstadt Niedersachsens', 'Ersatz: Wikipedia', JSON.stringify(s2));
const page = await readPage('https://x.de', { fetchFn: async () => res('<html><head><title>Zoo – Infos</title><script>var a=1</script></head><body><nav>Menü</nav><main><h1>Öffnungszeiten</h1><p>Täglich 9–18 Uhr.</p></main><footer>Impressum</footer></body></html>') });
check(page.titel === 'Zoo – Infos' && /Öffnungszeiten/.test(page.text) && /9–18/.test(page.text) && !/Menü|Impressum|var a/.test(page.text), 'Seite lesen (ohne Menü, Skripte, Fußzeile)', JSON.stringify(page));
check(['Such mal im Internet nach dem Zoo', 'Recherchier bitte die Öffnungszeiten', 'Was kostet aktuell ein Liter Diesel?', 'Schau mal nach, wann das Spiel ist'].every(wantsSearch) && !['Wie geht es dir?', 'Erzähl mir einen Witz'].some(wantsSearch), 'Rechercheauftrag erkannt');
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Internetsuche: alles in Ordnung');
process.exit(failed ? 1 : 0);
