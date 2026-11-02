// RunPod steuern (runpod.js): Zustand, Starten (REST, ersatzweise GraphQL), Fehlermeldungen.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runpodCtl } = require('../runpod.js');

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const res = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj ?? {}), json: async () => obj ?? {} });
const calls = [];
const fetchFn = async (url, o = {}) => {
  calls.push(`${o.method ?? 'GET'} ${url}`);
  if (url.endsWith('/pods/abc123xyz') && (o.method ?? 'GET') === 'GET') return res(200, { desiredStatus: 'EXITED', name: 'qwen', costPerHr: 0.39 });
  if (url.endsWith('/start')) return res(500, {});
  if (url.includes('graphql')) return res(200, { data: { podResume: { id: 'abc123xyz' } } });
  if (url.endsWith('/stop')) return res(200, {});
  return res(404, {});
};
const st = await runpodCtl({ action: 'status', podId: 'abc123xyz', key: 'k', fetchFn });
check(st.status === 'EXITED' && st.kostenProStunde === 0.39, 'Zustand des Pods', JSON.stringify(st));
const start = await runpodCtl({ action: 'start', podId: 'abc123xyz', key: 'k', fetchFn });
check(start.ok && calls.some((c) => c.includes('graphql')), 'Starten: REST scheitert → GraphQL', calls.join(' | '));
check((await runpodCtl({ action: 'stop', podId: 'abc123xyz', key: 'k', fetchFn })).ok, 'Stoppen');
const e1 = await runpodCtl({ action: 'status', podId: 'abc123xyz', key: '', fetchFn }).catch((e) => e.message);
const e2 = await runpodCtl({ action: 'status', podId: 'x', key: 'k', fetchFn }).catch((e) => e.message);
const e3 = await runpodCtl({ action: 'status', podId: 'unbekannt99', key: 'k', fetchFn }).catch((e) => e.message);
check(/Schlüssel/.test(e1) && /Pod-ID/.test(e2) && /nicht gefunden/.test(e3), 'Fehler verständlich', [e1, e2, e3].join(' | '));
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'RunPod: alles in Ordnung');
process.exit(failed ? 1 : 0);
