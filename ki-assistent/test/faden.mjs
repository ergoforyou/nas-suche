// Gesprächsfaden (src/faden.js): neues Gespräch, nur einmal mitgeben, „Vergiss das“, Erfindungen, Echo, Brücke.
import { isSessionStart, onlyNew, forgetCommand, isPhantom, echoScore, plainBridge, bridgePrompt } from '../src/faden.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};

const now = 10 * 3600e3;
check(isSessionStart([], now) && isSessionStart([{ role: 'user', t: now - 50 * 60e3 }], now) && !isSessionStart([{ role: 'assistant', t: now - 5 * 60e3 }], now), 'Neues Gespräch nach längerer Pause');
const shown = new Set();
const a = onlyNew([{ id: 1 }, { id: 2 }], shown);
const b = onlyNew([{ id: 2 }, { id: 3 }], shown);
const c = onlyNew([{ id: 1 }], shown, (x) => x.id, true);
check(a.length === 2 && b.length === 1 && b[0].id === 3 && c.length === 1, 'Jedes Stück nur einmal je Gespräch (außer ausdrücklich gefragt)');
check(['Vergiss das.', 'Das war Quatsch!', 'Ignorier das bitte', 'Streich das', 'Das war nicht für dich'].every(forgetCommand) && !['Vergiss das nicht, morgen ist Termin', 'Was war das?'].some(forgetCommand), '„Vergiss das“ erkannt, normale Sätze nicht');
check(['Untertitelung im Auftrag des ZDF, 2021', 'Abonniert den Kanal!', 'Tschüss.', 'ja ja ja ja ja', 'Musik'].every(isPhantom) && !['Wie wird das Wetter morgen?', 'Ja, bitte', 'Tschüss, bis morgen und danke für die Hilfe'].some(isPhantom), 'Erfindungen der Spracherkennung verworfen, echte Sätze nicht');
const spoken = 'Morgen wird es sonnig mit bis zu zwanzig Grad, am Abend ziehen Wolken auf.';
check(echoScore('am Abend ziehen Wolken auf', spoken) >= 0.6 && echoScore('Und wie wird es am Wochenende?', spoken) < 0.5 && echoScore('Ja', spoken) === 0, 'Echo der Figur erkannt, neue Frage nicht');
const br = plainBridge([{ role: 'user', content: 'Urlaub in Italien planen' }, { role: 'assistant', content: 'Gern' }, { role: 'user', content: 'Was kostet die Fähre?' }]);
check(/Italien/.test(br.text) && /Fähre/.test(br.text) && /voriger Chat/.test(bridgePrompt({ text: 'Wir planten Italien.', offen: 'Fähre buchen' })) && bridgePrompt(null) === '', 'Brücke zum neuen Chat');

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Gesprächsfaden: alles in Ordnung');
process.exit(failed ? 1 : 0);
