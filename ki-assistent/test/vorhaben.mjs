// Selbstständige Figur (src/vorhaben.js): Notizbuch aufräumen, Vorhaben Schritt für Schritt, Tagesbegleiter.
import { applyTidy, tidyInput, pickVorhaben, nextStep, parseVorhaben, applyVorhaben, stepsFrom, parseTop3, vorhabenInput } from '../src/vorhaben.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const now = 100 * 86400e3;
const mk = (id, f = {}) => ({ id, titel: `Notiz ${id}`, text: `Text ${id}`, ordner: 'themen', tags: [], created: 0, changed: now - 5 * 86400e3, ...f });

const notes = [mk('a'), mk('b', { tags: ['x'] }), mk('c'), mk('d', { offen: true }), mk('v', { ordner: 'projekte', offen: true, schritte: [{ text: 'suchen' }] })];
check(/a \| themen \| 5 T/.test(tidyInput(notes, now)), 'Aufräumen: Notizen kompakt fürs Hilfsmodell');
const t = applyTidy(structuredClone(notes), { erledigt: ['d', 'v'], archiv: ['c'], zusammen: [{ ids: ['a', 'b'], titel: 'A+B', text: 'zusammen' }], aendern: [{ id: 'c', titel: 'Neu C' }], ansprechen: 'Ich hab noch eine Idee für dich.' }, now);
const by = Object.fromEntries(t.notes.map((n) => [n.id, n]));
check(t.notes.length === 4 && !by.b && by.a.titel === 'A+B' && by.a.tags.includes('x'), 'Zusammenführen: eine Notiz bleibt, Stichworte vereint', JSON.stringify(t.notes.map((n) => n.id)));
check(by.d.erledigt === now && !by.v.erledigt && by.c.ordner === 'archiv' && by.c.titel === 'Neu C', 'Erledigt/Archiv/Ändern – Vorhaben mit offenen Schritten bleiben offen');
check(t.topic === 'Ich hab noch eine Idee für dich.' && t.changed >= 4, 'Etwas fürs Gegenüber wird ein offenes Thema', JSON.stringify(t));
check(applyTidy(notes, null).changed === 0, 'Kaputte Antwort ändert nichts');

const v = mk('p', { ordner: 'projekte', offen: true, text: '', schritte: stepsFrom('1. Ferienwohnungen auf Rügen suchen\n2. Preise vergleichen\n- Favoriten vorschlagen') });
check(v.schritte.length === 3 && v.schritte[0].text === 'Ferienwohnungen auf Rügen suchen', 'Schritte aus Text (Nummern/Striche entfernt)', JSON.stringify(v.schritte));
check(pickVorhaben([v, mk('q')], now)?.id === 'p' && !pickVorhaben([{ ...v, gearbeitet: now - 3600e3 }], now), 'Vorhaben auswählen: offen, mit Schritt, nicht gerade erst bearbeitet');
check(/Jetzt dran: Ferienwohnungen/.test(vorhabenInput(v)), 'Auftrag nennt den nächsten Schritt');
const r = parseVorhaben('Ich habe gesucht.\n{"ergebnis":"- FeWo Binz, 95 €/Nacht","schritt_erledigt":true,"neue_schritte":["Verfügbarkeit Mai prüfen"],"fertig":false,"frage":null,"nachricht":"Ich hab schon zwei Wohnungen gefunden."}');
check(r?.erledigt && r.neue[0] === 'Verfügbarkeit Mai prüfen' && /Binz/.test(r.ergebnis), 'Arbeitsergebnis lesen (JSON hinter Text)', JSON.stringify(r));
applyVorhaben(v, r, now);
check(v.schritte[0].erledigt === now && v.schritte.length === 4 && /### .*Ferienwohnungen auf Rügen suchen\n- FeWo Binz/.test(v.text) && v.gearbeitet === now && !v.erledigt, 'Ergebnis angefügt, Schritt abgehakt, neuer Schritt dazu', v.text);
applyVorhaben(v, { ergebnis: '', erledigt: false, neue: [], fertig: false, frage: 'Welches Budget?', nachricht: null }, now + 1);
check(v.schritte[1].wartet === 'Welches Budget?' && nextStep(v)?.text === 'Favoriten vorschlagen', 'Rückfrage: Schritt wartet auf das Gegenüber, es geht mit dem nächsten weiter');
applyVorhaben(v, { ergebnis: 'fertig', erledigt: true, neue: [], fertig: true, frage: null, nachricht: null }, now + 2);
check(!!v.erledigt, 'Vorhaben fertig');

check(parseTop3('{"heute":["Angebot Müller schicken","Zahnarzt anrufen","Joggen"]}').length === 3 && parseTop3('nix').length === 0, 'Tagesbegleiter: drei wichtigste Dinge lesen');
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Vorhaben: alles in Ordnung');
process.exit(failed ? 1 : 0);
