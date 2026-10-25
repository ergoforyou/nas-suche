// Startschutz (src/startschutz.js): Fehlstarts zählen, sicherer Modus, Rückkehr zum normalen Start, Fehler merken.
import { bootStart, bootStable, bootNext, rememberError, lastErrors, SAFE_AFTER } from '../src/startschutz.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

const st = mem();
const first = bootStart(st);
check(first.n === 1 && !first.safe, 'erster Start: normal');
bootStable(st);
check(bootStart(st).n === 1, 'gelungener Start setzt den Zähler zurück');
let r;
for (let i = 1; i < SAFE_AFTER; i++) r = bootStart(st); // zusammen mit dem Start oben: SAFE_AFTER Fehlstarts
check(!r.safe && r.n === SAFE_AFTER, `${SAFE_AFTER} Fehlstarts: noch normal`, JSON.stringify(r));
r = bootStart(st);
check(r.safe && !r.forced, 'danach: sicherer Modus', JSON.stringify(r));
bootNext(st, 'normal');
check(!bootStart(st).safe, '„Normal neu starten“: wieder normal');
bootNext(st, 'sicher');
const f = bootStart(st);
check(f.safe && f.forced, '„Sicher neu starten“: einmal sicher', JSON.stringify(f));
check(!bootStart(st).safe, 'nur einmal – danach wieder normal');
const broken = { getItem: () => '{kaputt', setItem: () => { throw new Error('voll'); } };
check(bootStart(broken).n === 1, 'kaputter oder voller Speicher: kein Absturz');

for (let i = 0; i < 15; i++) rememberError(st, `Fehler ${i}`);
const e = lastErrors(st);
check(e.length === 12 && e[0] === 'Fehler 3' && e.at(-1) === 'Fehler 14', 'die letzten 12 Fehler bleiben', JSON.stringify(e));

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Startschutz: alles in Ordnung');
process.exit(failed ? 1 : 0);
