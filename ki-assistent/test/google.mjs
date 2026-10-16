// Google Kalender/Aufgaben ohne Netz prüfen: Zeitumrechnung (Ortszeit -> UTC), Termin- und Aufgaben-Anfragen.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const g = require('../google.js');

const calls = [];
const replies = {
  token: { access_token: 'AT', expires_in: 3600 },
  list: { items: [{ id: 'e1', summary: 'Zahnarzt', start: { dateTime: '2026-10-17T14:00:00+02:00' }, end: { dateTime: '2026-10-17T15:00:00+02:00' } }] },
};
const google = g.createGoogle({
  http: async (req) => {
    calls.push(req);
    if (req.url.includes('oauth2.googleapis.com/token')) return { status: 200, data: replies.token };
    if (req.method === 'GET' && req.url.includes('/events?')) return { status: 200, data: replies.list };
    if (req.method === 'POST' && req.url.includes('/events')) return { status: 200, data: { id: 'n1', ...JSON.parse(req.body) } };
    if (req.method === 'POST' && req.url.includes('/tasks')) return { status: 200, data: { id: 't1', title: JSON.parse(req.body).title, due: JSON.parse(req.body).due } };
    if (req.method === 'GET' && req.url.includes('/tasks?')) return { status: 200, data: { items: [{ id: 't1', title: 'Angebot', due: '2026-10-23T00:00:00.000Z', status: 'needsAction' }] } };
    return { status: 404, data: {} };
  },
  load: async () => ({ clientId: 'c', clientSecret: 's', refresh: 'R', access: null, expires: 0, email: 'a@b' }),
  save: async () => {},
});
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${what}${detail ? ` – ${detail}` : ''}`);
  if (!ok) failed++;
};
const tz = { timeZone: 'Europe/Berlin' };

const list = await g.runTool(google, 'kalender_termine_lesen', { von: '2026-10-17T00:00', bis: '2026-10-18T00:00' }, tz);
const q = new URL(calls.find((c) => c.url.includes('/events?')).url).searchParams;
check(q.get('timeMin') === '2026-10-16T22:00:00.000Z' && q.get('timeMax') === '2026-10-17T22:00:00.000Z', 'Ortszeit Berlin (Sommerzeit) richtig nach UTC', `${q.get('timeMin')} – ${q.get('timeMax')}`);
check(list.termine[0].titel === 'Zahnarzt' && list.termine[0].id === 'e1', 'Termine gelesen');
await g.runTool(google, 'kalender_termine_lesen', { von: '2026-12-01', bis: '2026-12-02' }, tz);
const q2 = new URL(calls.filter((c) => c.url.includes('/events?')).at(-1).url).searchParams;
check(q2.get('timeMin') === '2026-11-30T23:00:00.000Z', 'Winterzeit und reines Datum', q2.get('timeMin'));

const made = await g.runTool(google, 'kalender_termin_anlegen', { titel: 'Zahnarzt', beginn: '2026-10-22T14:00', dauer_minuten: 45, erinnerung_minuten: 60, ort: 'Praxis' }, tz);
const body = JSON.parse(calls.filter((c) => c.method === 'POST' && c.url.includes('/events')).at(-1).body);
check(body.start.dateTime === '2026-10-22T14:00:00' && body.end.dateTime === '2026-10-22T14:45:00' && body.start.timeZone === 'Europe/Berlin', 'Termin mit Dauer und Zeitzone', JSON.stringify(body.start) + JSON.stringify(body.end));
check(body.reminders?.overrides?.[0]?.minutes === 60 && body.location === 'Praxis' && made.eingetragen.id === 'n1', 'Erinnerung und Ort');
await g.runTool(google, 'kalender_termin_anlegen', { titel: 'Urlaub', beginn: '2026-12-24', ganztags: true }, tz);
const allDay = JSON.parse(calls.filter((c) => c.method === 'POST' && c.url.includes('/events')).at(-1).body);
check(allDay.start.date === '2026-12-24' && allDay.end.date === '2026-12-25', 'Ganztägiger Termin', JSON.stringify(allDay.end));

const task = await g.runTool(google, 'aufgabe_anlegen', { titel: 'Angebot schicken', faellig: '2026-10-23' }, tz);
check(task.angelegt.faellig === '2026-10-23', 'Aufgabe mit Fälligkeit');
const tasks = await g.runTool(google, 'aufgaben_lesen', {}, tz);
check(tasks.aufgaben[0].titel === 'Angebot' && tasks.aufgaben[0].faellig === '2026-10-23', 'Aufgaben gelesen');
const tok = calls.find((c) => c.url.includes('/token'));
check(/grant_type=refresh_token/.test(tok.body) && /refresh_token=R/.test(tok.body), 'Zugangstoken über Erneuerungs-Token');
let err = '';
try {
  await g.runTool(google, 'kalender_termin_anlegen', { beginn: '2026-10-22T14:00' }, tz);
} catch (e) {
  err = e.message;
}
check(/titel/.test(err), 'Fehlende Angabe wird gemeldet', err);
const url = new URL(g.authUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1', challenge: 'X', state: 'S' }));
check(url.searchParams.get('code_challenge_method') === 'S256' && /calendar\.events/.test(url.searchParams.get('scope')) && /tasks/.test(url.searchParams.get('scope')), 'Anmeldeadresse mit PKCE und Rechten');
process.exit(failed ? 1 : 0);
