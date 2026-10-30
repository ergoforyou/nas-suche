// Humor-Stil (src/humor.js): Stufen, Bereich Dienstlich gedeckelt, Zurufe, Grenzen immer dabei.
import { humorLevel, humorPrompt, humorCommand } from '../src/humor.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
check(humorLevel({}, { area: 'privat' }) === 'frech' && humorLevel({}, { area: 'dienstlich' }) === 'fein', 'Standard: Privat frech, Dienstlich fein');
check(humorLevel({ humorStil: 'derb' }, { area: 'dienstlich' }) === 'locker' && humorLevel({ humorStil: 'derb' }, { area: 'privat' }) === 'derb', 'Dienstlich höchstens locker');
check(humorLevel({ humorStil: 'fein' }, { area: 'privat', override: 'frech' }) === 'frech', 'Zuruf gilt für den Moment');
check(humorPrompt('fein') === '' && /Kraftausdruck/.test(humorPrompt('frech')) && /Gruppen herabsetzen/.test(humorPrompt('frech')) && /Gruppen herabsetzen/.test(humorPrompt('derb')) && /Politiker/.test(humorPrompt('derb')), 'Stil-Text mit festen Grenzen');
check(humorCommand('Sei mal frecher!', 'locker') === 'frech' && humorCommand('Hau mal einen raus', 'derb') === 'derb' && humorCommand('Jetzt mal wieder ernst bitte', 'derb') === 'fein' && humorCommand('Wie wird das Wetter?') === null, 'Zurufe');
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Humor: alles in Ordnung');
process.exit(failed ? 1 : 0);
