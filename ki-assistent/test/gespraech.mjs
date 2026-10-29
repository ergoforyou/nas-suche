// Natürliches Gespräch (src/gespraech.js): Zurufe, Korrekturen, Pausenlänge, Enden beim Erzählen.
import { voiceCommand, isCorrection, liveSilenceMs, dictEnd } from '../src/gespraech.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};

const stops = ['Stopp!', 'Stop.', 'Halt', 'Lina, stopp', 'Sei mal still.', 'Hör auf', 'Schon gut.', 'Danke, das reicht.', 'Okay, stopp.'];
check(stops.every((t) => voiceCommand(t, 'Lina') === 'stopp'), 'Stopp-Zurufe (auch mit Namen)', JSON.stringify(stops.map((t) => voiceCommand(t, 'Lina'))));
check(['Moment.', 'Warte mal', 'Einen Moment!', 'Pause'].every((t) => voiceCommand(t) === 'pause'), 'Moment/Warte = anhalten');
check(['Weiter.', 'Mach weiter', 'Erzähl weiter!', 'Okay, weiter.'].every((t) => voiceCommand(t) === 'weiter'), 'Weiter = fortsetzen');
const not = ['Stopp, ich meinte eigentlich Mittwoch', 'Wie geht es weiter mit dem Projekt?', 'Halt die Liste bitte kurz', 'Moment mal, wann war das nochmal genau?', 'Ja'];
check(not.every((t) => voiceCommand(t) === null), 'Längere Sätze sind keine Zurufe', JSON.stringify(not.map((t) => voiceCommand(t))));

check(['Nein, ich meinte Mittwoch.', 'Nee, eigentlich um 10', 'Ich meinte den anderen Termin', 'Nicht Dienstag, sondern Mittwoch', 'Stopp, ich meinte das Büro', 'Quatsch, nicht Anna'].every(isCorrection), 'Korrekturen erkannt');
check(!['Nein danke.', 'Was meinst du?', 'Nicht schlecht!', 'Ja, genau so.'].some(isCorrection), 'Normale Sätze sind keine Korrektur');

check(liveSilenceMs(600, 1200) === 600 && liveSilenceMs(1400, 1200) === 600 && liveSilenceMs(1600, 1200) > 1200 && liveSilenceMs(30000, 1200) === 2700 && liveSilenceMs(500, 400) === 400, 'Kurz gesprochen = kurze Pause, lang = länger überlegen');

const e1 = dictEnd('Das war mein Tag heute. Fertig.');
const e2 = dictEnd('Und deshalb bin ich unsicher. Was meinst du?');
const e3 = dictEnd('Hecke schneiden am Samstag, als Notiz.');
const e4 = dictEnd('So, das schicke ich jetzt. Abschicken.');
const e5 = dictEnd('Nur ein Entwurf. Nur Text.');
check(e1.how === 'fertig' && e1.rest === 'Das war mein Tag heute', '„fertig“', JSON.stringify(e1));
check(e2.how === 'antworten' && /Was meinst du\?$/.test(e2.rest), '„Was meinst du?“ = Figur antwortet (Frage bleibt drin)', JSON.stringify(e2));
check(e3.how === 'notiz' && e3.rest === 'Hecke schneiden am Samstag', '„als Notiz“', JSON.stringify(e3));
check(e4.how === 'senden' && e5.how === 'text' && dictEnd('Ich bin noch nicht fertig mit dem Gedanken und') === null, '„abschicken“, „nur Text“; „fertig“ mitten im Satz zählt nicht');

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Gespräch: alles in Ordnung');
process.exit(failed ? 1 : 0);
