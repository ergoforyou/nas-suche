// Werkzeug-Auswahl je Gerät und Bereich: Handy-Steuerung nur in der Android-App (Privat), Claude-Übergabe-Werkzeug nur am PC.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { appTools } = require('../cloud.js');

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const names = (o) => appTools(() => {}, o).defs.map((d) => d.name);
const phonePriv = names({ desktop: false, privat: true });
const phoneWork = names({ desktop: false, privat: false });
const pcPriv = names({ desktop: true, privat: true });
check(phonePriv.includes('handy_steuern') && phonePriv.includes('video_abspielen') && !phonePriv.includes('an_claude_uebergeben'), 'Handy Privat: Handy steuern und Videos, keine PC-Übergabe', JSON.stringify(phonePriv));
check(!phoneWork.includes('handy_steuern') && !phoneWork.includes('video_abspielen'), 'Handy Dienstlich: keine Privat-Werkzeuge', JSON.stringify(phoneWork));
check(!pcPriv.includes('handy_steuern') && pcPriv.includes('an_claude_uebergeben') && pcPriv.includes('video_abspielen'), 'PC Privat: kein Handy steuern, aber Claude-Übergabe und Videos', JSON.stringify(pcPriv));
check(appTools(() => {}, { desktop: false, privat: true }).defs.every((d) => !('mobileOnly' in d) && !('privatOnly' in d) && !('desktopOnly' in d)), 'Merker gehen nicht an die API');
// YouTube-Ergebnisseite lesen (nachgebildet wie die echte Seite: ytInitialData im Skript)
const { parseResults, search } = require('../youtube.js');
const vid = (id, title, ch, len) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: ch }] }, lengthText: { simpleText: len } } });
const initial = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, vid('abcDEF12345', 'Entspannungsmusik zum Arbeiten', 'Calm Channel', '1:02:03'), vid('xyz_-987654', 'Lofi Beats', 'Lofi Girl', '3:00:00'), vid('abcDEF12345', 'doppelt', 'x', '1:00')] } }] } } } } };
const html = `<html><script nonce="x">var ytInitialData = ${JSON.stringify(initial)};</script></html>`;
const res = parseResults(html);
check(res.length === 2 && res[0].id === 'abcDEF12345' && res[0].titel === 'Entspannungsmusik zum Arbeiten' && res[0].kanal === 'Calm Channel' && res[1].laenge === '3:00:00', 'YouTube: Videos aus der Ergebnisseite (ohne Werbung, ohne Doppelte)', JSON.stringify(res));
check(parseResults('<html>keine Daten</html>').length === 0, 'YouTube: unbekannte Seite → leer');
let asked = null;
const got = await search('Entspannungsmusik zum Arbeiten', { fetchFn: async (url, headers) => ((asked = { url, headers }), { ok: true, status: 200, text: async () => html }) });
check(got[0]?.id === 'abcDEF12345' && /search_query=Entspannungsmusik%20zum%20Arbeiten/.test(asked.url) && /CONSENT/.test(asked.headers.Cookie), 'YouTube: Suche schickt nur den Suchbegriff (ohne Zustimmungsseite)', JSON.stringify(asked));
process.exit(failed ? 1 : 0);
