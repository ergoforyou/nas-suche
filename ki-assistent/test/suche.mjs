// Bedeutungssuche (src/suche.js) mit einem nachgebildeten Suchmodell: Wörter mit gleicher Bedeutung zeigen in dieselbe
// Richtung. Prüft Erfassen im Hintergrund, Ändern/Löschen, Schwellen, Zusammenführen mit der Wortsuche und Speichern.
import { createSemantik, combine, fuse, hashText, quantize, dot, docText, sourcesLine } from '../src/suche.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};

// Begriffsgruppen = Achsen; jeder Text wird zur Summe seiner Begriffe (plus kleiner Grundanteil wie bei e5)
const GROUPS = [
  ['urlaub', 'ferien', 'reise', 'gardasee', 'verreisen'],
  ['auto', 'wallbox', 'laden', 'elektroauto', 'strom'],
  ['geburtstag', 'geschenk', 'feier', 'party'],
  ['garten', 'tomaten', 'beet', 'pflanzen'],
  ['steuer', 'finanzamt', 'erklärung', 'belege'],
];
const DIM = GROUPS.length + 1;
let calls = 0;
const embed = async (texts) => {
  calls++;
  return texts.map((t) => {
    const v = new Float32Array(DIM);
    v[DIM - 1] = 1.6; // gemeinsamer Grundanteil: auch Unpassendes ist nicht 0
    for (const w of t.toLowerCase().match(/[a-zäöüß]+/g) ?? []) GROUPS.forEach((g, i) => g.includes(w) && (v[i] += 1));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
};
let saved = null;
const store = { load: async () => saved, save: async (d) => void (saved = structuredClone(d)) };
const sem = createSemantik({ embed, store });

check(hashText('abc') === hashText('abc') && hashText('abc') !== hashText('abd'), 'Prüfwert erkennt Änderungen');
const q = quantize(new Float32Array([0.5, -0.25, 0.1]));
check(Math.abs(dot(q, new Float32Array([0.5, -0.25, 0.1])) - 0.315) < 0.01, '8-Bit-Vektoren rechnen genau genug', dot(q, [0.5, -0.25, 0.1]));
check(docText('Titel', '', null, 'x'.repeat(5000)).length === 1500 && docText('A', 'B') === 'A\nB', 'Text für den Vektor: Titel zuerst, gekürzt');

const docs = [
  { key: 'b:1', text: 'Ferien am Gardasee planen' },
  { key: 'b:2', text: 'Wallbox für das Elektroauto' },
  { key: 'b:3', text: 'Geschenk zum Geburtstag von Anna' },
  { key: 'e:p:9', text: 'Gespräch über Tomaten im Beet' },
  { key: 's:5', text: 'Belege für die Steuer sammeln' },
];
await sem.load();
check(sem.sync(docs) === 5 && !sem.ready(), 'neuer Bestand wartet auf Berechnung');
check((await sem.search('Urlaub')).length === 0, 'vor dem Erfassen: keine Treffer (Wortsuche übernimmt)');
let n = 0;
while (await sem.pump(2)) n++;
check(n === 3 && sem.pending() === 0 && sem.stats().done === 5, 'Erfassen in Schwüngen', JSON.stringify(sem.stats()));
const hits = await sem.search('Wann wollten wir verreisen?');
check(hits[0]?.key === 'b:1', 'Umschreibung gefunden („verreisen“ → Ferien am Gardasee)', JSON.stringify(hits));
check(!hits.some((h) => h.key === 'b:2'), 'Unpassendes fällt unter die Schwelle', JSON.stringify(hits));
const onlyE = await sem.search('Pflanzen im Garten', { prefixes: ['e:'] });
check(onlyE.length === 1 && onlyE[0].key === 'e:p:9', 'Suche nur in einer Quelle', JSON.stringify(onlyE));
check((await sem.search('Quantenphysik')).length === 0, 'nichts Passendes → keine Treffer');

// Ändern und Löschen
const before = calls;
sem.sync([...docs.slice(1), { key: 'b:2', text: 'Wallbox für das Elektroauto – Förderung beantragt' }].filter((d, i, a) => a.findIndex((x) => x.key === d.key) === i));
check(sem.pending() === 0, 'unveränderte Einträge werden nicht neu berechnet');
sem.sync([{ key: 'b:2', text: 'Wallbox Strom laden – Angebot da' }, ...docs.slice(2)]);
check(sem.pending() === 1, 'geänderter Text wird neu berechnet', String(sem.pending()));
await sem.pump();
check(calls === before + 1, 'nur ein neuer Aufruf des Modells');
check(!(await sem.search('Ferien Gardasee')).some((h) => h.key === 'b:1'), 'gelöschte Notiz wird nicht mehr gefunden');

// Speichern und Laden
await new Promise((r) => setTimeout(r, 1700));
check(saved?.items?.length === 4 && saved.items[0].v instanceof Int8Array, 'Vektoren werden gespeichert (8 Bit)', JSON.stringify(saved?.items?.length));
const sem2 = createSemantik({ embed, store });
await sem2.load();
check(sem2.sync([{ key: 'b:2', text: 'Wallbox Strom laden – Angebot da' }, ...docs.slice(2)]) === 0, 'nach Neustart: nichts neu zu berechnen');
const sem3 = createSemantik({ embed, store, model: 'anderes-modell' });
await sem3.load();
check(sem3.sync(docs) === 5, 'anderes Suchmodell: alles neu berechnen');

// Zusammenführen
check(fuse([['a', 'b'], ['b', 'c']])[0] === 'b', 'in beiden Listen vorn = ganz vorn');
const c = combine(['w1', 'w2'], [{ key: 'v1', score: 0.9 }, { key: 'w2', score: 0.81 }, { key: 'v2', score: 0.81 }], 3);
check(c[0] === 'w2' && c.includes('v1') && !c.includes('v2'), 'nur Bedeutung: braucht eine höhere Schwelle', JSON.stringify(c));
// Fehler im Modell
const bad = createSemantik({ embed: async () => { throw new Error('kein Netz'); } });
bad.sync(docs);
let err = '';
try {
  await bad.pump();
} catch (e) {
  err = e.message;
}
check(err === 'kein Netz' && bad.failed === 'kein Netz', 'Modell nicht ladbar: Fehler wird gemeldet');
check(/Notiz „A“/.test(sourcesLine(['Notiz „A“', 'Notiz „A“'])) && sourcesLine([]) === '', 'Quellenzeile ohne Doppelte');

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Bedeutungssuche: alles in Ordnung');
process.exit(failed ? 1 : 0);
