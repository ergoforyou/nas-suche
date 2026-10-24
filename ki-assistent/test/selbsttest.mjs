// Selbsttest beim Start (src/selbsttest.js): Einstellungen reparieren, Kennungen, Verweise, Prüfungen mit Zeitlimit.
import { repairSettings, fixIds, checkData, runChecks } from '../src/selbsttest.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
let n = 0;
const newId = () => `neu${++n}`;

const defaults = { speak: true, livePauseMs: 1200, provider: 'anthropic', place: '', stageHeight: null, orte: [], reminderLead: 15 };
const s = { speak: 'ja', livePauseMs: NaN, provider: 'openai', place: 'Hannover', stageHeight: 300, orte: {}, reminderLead: '30', extra: 1 };
const fixed = repairSettings(s, defaults);
check(fixed.sort().join() === 'livePauseMs,orte,speak' && s.speak === true && s.livePauseMs === 1200 && Array.isArray(s.orte), 'falsche Typen auf Standard, NaN repariert', JSON.stringify({ fixed, s }));
check(s.provider === 'openai' && s.place === 'Hannover' && s.stageHeight === 300 && s.reminderLead === '30' && s.extra === 1, 'gültige Werte (auch Zahl als Text) bleiben unangetastet', JSON.stringify(s));

const list = [{ id: 'a' }, { id: 'a' }, {}, { id: 'b' }];
check(fixIds(list, newId) === 2 && new Set(list.map((x) => x.id)).size === 4, 'doppelte und fehlende Kennungen erneuert', JSON.stringify(list));

const er = [{ id: 'r1', ort: 'weg', text: 'Milch' }, { id: 'r2', ort: 'o1', text: 'Brot' }, { id: 'r3', text: 'kaputt' }, { id: 'r4', at: 5, text: 'gut' }];
const r = checkData({ personas: [{ id: 'p', name: 'Lina', brain: [{ id: 'x' }, { id: 'x' }] }], activeId: 'p', brain: [], erinnerungen: er, orte: [{ id: 'o1' }], newId });
check(!!er[0].ack && !er[1].ack && r.issues.some((i) => /kaputt/.test(i)) && r.fixes.some((f) => /Notizbuch von Lina/.test(f)), 'Verweise ins Leere repariert, Unstimmiges gemeldet', JSON.stringify(r));
check(checkData({ personas: [], newId }).issues.includes('keine Persona vorhanden'), 'fehlende Persona wird gemeldet');

const res = await runChecks([{ name: 'gut', run: async () => true }, { name: 'Fehler', run: async () => { throw new Error('kaputt'); } }, { name: 'hängt', run: () => new Promise(() => {}) }, { name: 'Hinweis', run: async () => 'Speicher fast voll' }], 200);
check(res.map((x) => `${x.name}:${x.ok}`).join() === 'gut:true,Fehler:false,hängt:false,Hinweis:false' && /Zeitlimit/.test(res[2].info), 'Prüfungen mit Zeitlimit, Fehler werden aufgefangen', JSON.stringify(res));

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Selbsttest: alles in Ordnung');
process.exit(failed ? 1 : 0);
