// Begleiter bei geschlossener App (src/begleiter.js): Zeiten der Runden, Vorschau-Texte, Nachtschicht-Auftrag und
// -Ergebnis, Orte.
import { nextAt, roundPreview, roundItems, nightJob, readNightResult, findOrt, ortWatch } from '../src/begleiter.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const at = (s) => new Date(s).getTime();
const day = (ms) => new Date(ms).toLocaleDateString('sv-SE');

const now = at('2026-10-24T06:00:00');
check(day(nextAt('07:30', null, now)) === '2026-10-24' && new Date(nextAt('07:30', null, now)).getHours() === 7, 'Morgenrunde heute, wenn noch nicht vorbei');
check(day(nextAt('07:30', null, at('2026-10-24T08:00:00'))) === '2026-10-25', 'schon vorbei → morgen');
check(day(nextAt('18:00', '2026-10-24', now)) === '2026-10-25', 'heute schon gelaufen → morgen');
check(nextAt('', null, now) === null, 'ohne Uhrzeit: nichts');

const data = {
  termine: [
    { titel: 'Zahnarzt', beginn: '2026-10-24T09:00:00+02:00' },
    { titel: 'Elternabend', beginn: '2026-10-24T19:00:00+02:00' },
    { titel: 'Urlaub', beginn: '2026-10-26' },
  ],
  erinnerungen: [{ at: at('2026-10-24T12:00:00'), text: 'Paket abholen' }],
  offen: 3,
  vorhaben: [{ titel: 'Gardasee', neu: true }],
  heute: [{ titel: 'Steuer', erledigt: true }, { titel: 'Reifen', erledigt: false }],
  name: 'Lina',
};
const m = roundPreview('morning', at('2026-10-24T07:30:00'), data);
check(/Lina/.test(m.title) && /2 Termine \(zuerst \d\d:\d\d Zahnarzt\)/.test(m.text) && /Paket abholen/.test(m.text) && /3 offene Punkte/.test(m.text) && /Gardasee/.test(m.text) && /Antippen/.test(m.text), 'Morgen-Vorschau: Termine, Erinnerung, offene Punkte, Vorhaben', m.text);
const e = roundPreview('evening', at('2026-10-24T18:00:00'), data);
check(/Reifen/.test(e.text) && /3 offene Punkte/.test(e.text) && /Tagesrückblick/.test(e.text), 'Feierabend-Vorschau: was von heute offen ist', e.text);
check(/^Heute: /.test(m.text) && !/Heute: /.test(roundPreview('morning', at('2026-10-24T07:30:00'), {}).text), 'ohne Inhalt: nur der Hinweis');
const items = roundItems({ morning: true, evening: true, morningAt: '07:30', eveningAt: '18:00', eveningDay: '2026-10-24' }, data, now);
check(items.length === 2 && items[0].key === 'runde:m:2026-10-24' && items[1].key === 'runde:f:2026-10-25', 'Runden-Benachrichtigungen mit eigenem Schlüssel', JSON.stringify(items.map((i) => i.key)));
check(roundItems({ morning: false, evening: false }, data, now).length === 0, 'Runden aus: keine Benachrichtigung');

const job = nightJob({ model: 'claude-haiku-5-5', system: 'S', input: 'I', noteId: 'p:n', step: 'Preise vergleichen', tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
check(job.body.model === 'claude-haiku-5-5' && job.body.messages[0].content === 'I' && job.body.thinking?.type === 'disabled' && job.body.tools.length === 1 && !JSON.stringify(job).includes('sk-'), 'Nachtschicht-Auftrag: fertige Anfrage ohne Schlüssel', JSON.stringify(job));
const res = readNightResult(JSON.stringify({
  noteId: 'p:n',
  step: 'Preise vergleichen',
  t: 1,
  antworten: [
    { model: 'claude-haiku-5-5', stop_reason: 'pause_turn', content: [{ type: 'server_tool_use' }, { type: 'text', text: '{"ergebnis": "A' }], usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } },
    { content: [{ type: 'text', text: '", "schritt_erledigt": true}' }], usage: { input_tokens: 50, output_tokens: 5 } },
  ],
}));
check(res.text === '{"ergebnis": "A", "schritt_erledigt": true}' && res.use.in === 150 && res.use.searches === 1 && res.model === 'claude-haiku-5-5', 'Nachtschicht-Ergebnis über mehrere Runden', JSON.stringify(res));
check(readNightResult('{"noteId":"p:n","fehler":"kein Claude-Schlüssel"}').error === 'kein Claude-Schlüssel' && readNightResult('kaputt') === null, 'Fehler der Nachtschicht wird erkannt');

const orte = [{ id: 'o1', name: 'Supermarkt', lat: 52.1, lon: 9.7 }, { id: 'o2', name: 'Zu Hause', lat: 52.2, lon: 9.8 }];
check(findOrt(orte, 'beim Supermarkt')?.id === 'o1' && findOrt(orte, 'zu Hause')?.id === 'o2' && !findOrt(orte, 'Bahnhof'), 'Ort über Umschreibung finden („beim Supermarkt“)');
const w = ortWatch(orte, [{ id: 'r1', ort: 'o1', text: 'Milch' }, { id: 'r2', ort: 'o1', text: 'Brot', ack: 1 }, { id: 'r3', at: 5, text: 'x' }]);
check(w.length === 1 && w[0].texte.length === 1 && w[0].texte[0].text === 'Milch' && w[0].radius === 150, 'Überwacht wird nur, wo noch etwas offen ist', JSON.stringify(w));

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Begleiter: alles in Ordnung');
process.exit(failed ? 1 : 0);
