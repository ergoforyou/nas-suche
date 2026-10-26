// Begleiter bei geschlossener App (src/begleiter.js): Zeiten der Runden, Vorschau-Texte, Nachtschicht-Auftrag und
// -Ergebnis, Orte.
import { nextAt, roundPreview, roundItems, nightJob, readNightResult, findOrt, ortWatch, ortArt, hhmm, inWindow, wannText, hereNow } from '../src/begleiter.js';

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

const orte = [
  { id: 'o1', name: 'Supermarkt Lister Meile', gruppe: 'Supermarkt', lat: 52.1, lon: 9.7 },
  { id: 'o4', name: 'Rewe Podbi', gruppe: 'Supermarkt', lat: 52.15, lon: 9.75, radius: 300 },
  { id: 'o2', name: 'Zuhause', ssid: 'FritzBox-Jens' },
  { id: 'o3', name: 'Büro', lat: 52.3, lon: 9.8, adresse: 'Musterweg 1', leise: true },
  { id: 'o5', name: 'Auto', bt: 'Golf' },
];
check(findOrt(orte, 'wenn ich zu Hause bin')?.id === 'o2' && findOrt(orte, 'zu Hause')?.id === 'o2' && findOrt(orte, 'daheim')?.id === 'o2' && findOrt(orte, 'auf der Arbeit')?.id === 'o3', 'Umschreibungen: „zu Hause“/„daheim“, „Arbeit“ = Büro');
const grp = findOrt(orte, 'beim Supermarkt');
check(grp?.gruppe === 'Supermarkt' && grp.orte.length === 2 && !findOrt(orte, 'Bahnhof'), 'Gruppe: „beim Supermarkt“ = alle Supermärkte', JSON.stringify(grp));
check(ortArt(orte[2]) === 'wlan' && ortArt(orte[3]) === 'adresse' && ortArt(orte[4]) === 'auto' && ortArt({ lat: 1, lon: 1 }) === 'standort', 'Art der Erkennung');
check(hhmm('17 Uhr') === '17:00' && hhmm('7.30') === '07:30' && hhmm('25:00') === null && hhmm('') === null, 'Uhrzeiten lesen');
const mo18 = new Date('2026-10-26T18:00:00').getTime(); // Montag
const sa18 = new Date('2026-10-31T18:00:00').getTime(); // Samstag
check(inWindow({ von: '17:00' }, mo18) && !inWindow({ von: '19:00' }, mo18) && inWindow({ von: '22:00', bis: '06:00' }, new Date('2026-10-26T23:30:00').getTime()) && !inWindow({ werktags: true }, sa18) && inWindow({}, sa18), 'Zeitfenster (auch über Mitternacht) und werktags');
check(wannText({ wann: 'weg', jedes: true, von: '17:00', werktags: true }) === 'beim Verlassen, jedes Mal, ab 17:00 Uhr, werktags', 'Bedingung in Worten', wannText({ wann: 'weg', jedes: true, von: '17:00', werktags: true }));
const rem = [
  { id: 'r1', ort: 'gruppe:supermarkt', text: 'Milch', wann: 'an' },
  { id: 'r2', ort: 'o2', text: 'Post holen', wann: 'an', jedes: true, von: '17:00' },
  { id: 'r3', ort: 'o3', text: 'Einkaufen', wann: 'weg', werktags: true },
  { id: 'r4', ort: 'o5', text: 'Pfandflaschen', wann: 'an' },
  { id: 'r5', ort: 'o2', text: 'erledigt', ack: 1 },
  { id: 'r6', at: 5, text: 'Uhrzeit' },
];
const notes = [{ titel: 'Dübel 8 mm', ort: 'Supermarkt' }, { titel: 'Altes Zeug', ort: 'Supermarkt', erledigt: 1 }];
const w = ortWatch(orte, rem, { notizen: notes, heimRunde: { ab: '17:00', erledigt: '2026-10-25' }, verkehr: true });
const by = Object.fromEntries(w.map((x) => [x.id, x]));
check(by.o1.texte.some((t) => t.text === 'Milch') && by.o4.texte.some((t) => t.text === 'Milch') && by.o1.radius === 200 && by.o4.radius === 300, 'Gruppen-Erinnerung an jedem Supermarkt, Umkreis je Ort', JSON.stringify(by.o1));
check(by.o1.texte.some((t) => t.art === 'notiz' && t.text === 'Dübel 8 mm' && t.anzahl === 1), 'Notizen mit Ort erscheinen dort (Erledigtes nicht)');
check(by.o2.ssid === 'FritzBox-Jens' && by.o2.lat === undefined && by.o2.texte.some((t) => t.text === 'Post holen' && t.jedes && t.von === '17:00') && by.o2.texte.some((t) => t.art === 'runde' && t.erledigt === '2026-10-25') && !by.o2.texte.some((t) => t.text === 'erledigt'), 'Zuhause per WLAN: jedes Mal ab 17 Uhr, Feierabendrunde beim Heimkommen', JSON.stringify(by.o2));
check(by.o3.texte.some((t) => t.text === 'Einkaufen' && t.wann === 'weg' && t.werktags) && by.o3.texte.some((t) => t.art === 'verkehr' && t.wann === 'weg'), 'Büro verlassen: Erinnerung und Verkehrslage für den Heimweg', JSON.stringify(by.o3));
check(by.o5.bt === 'Golf' && by.o5.texte[0].text === 'Pfandflaschen', 'Auto über Bluetooth');
check(ortWatch([{ id: 'x', name: 'Leer', lat: 1, lon: 1 }], []).length === 0, 'Orte ohne Einträge werden nicht beobachtet');
const here = hereNow(orte, ['o1'], rem, notes);
check(here[0].ort === 'Supermarkt Lister Meile' && here[0].erinnerungen[0].startsWith('Milch') && here[0].notizen[0] === 'Dübel 8 mm', '„Was steht hier an?“', JSON.stringify(here));

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Begleiter: alles in Ordnung');
process.exit(failed ? 1 : 0);
