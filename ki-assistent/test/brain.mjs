// Second Brain (src/brain.js): Notizen anlegen, offene Punkte, Markdown/Obsidian hin und zurück, Zusammenführen.
import { makeNote, openLoops, noteToMarkdown, markdownToNote, exportVault, importVault, mergeNotes, parseInbox, findNote, fileName, parsePick, brainPickInput, isoWeek, weekFacts, weekMarkdown } from '../src/brain.js';

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};

const a = makeNote({ titel: 'Garten', text: 'Ich muss noch die Hecke schneiden.', tags: ['#Haus', 'garten'] }, 1000);
const b = makeNote({ titel: 'Urlaub Ostsee', text: 'Ideen: Rügen, Usedom', ordner: 'projekte', projekt: 'Urlaub 2027', faellig: '2027-03-01', offen: true }, 2000);
const c = makeNote({ titel: 'Anna', text: 'Mag Tee, Geburtstag im Mai', ordner: 'personen' }, 3000);
check(a.offen && a.ordner === 'eingang' && a.tags.join() === 'haus,garten', 'Neue Notiz: Eingang, offener Punkt erkannt, Stichworte bereinigt', JSON.stringify(a));
check(!c.offen && c.ordner === 'personen', 'Notiz ohne Aufgabe bleibt geschlossen');
const loops = openLoops([a, b, c]);
check(loops.length === 2 && loops[0].id === b.id, 'Offene Punkte: Fälliges zuerst', JSON.stringify(loops.map((n) => n.titel)));
check(findNote([a, b, c], 'ostsee')?.id === b.id && findNote([a, b, c], c.id) === c, 'Notiz per Titelteil oder Kennung finden');

const md = noteToMarkdown(b);
const back = markdownToNote(md, 'Projekte/Urlaub Ostsee.md');
check(/^---\nid: /.test(md) && /# Urlaub Ostsee/.test(md) && /- \[ \] Urlaub Ostsee/.test(md), 'Markdown mit Kopfdaten und Aufgaben-Kästchen (Obsidian)', md);
check(back.id === b.id && back.titel === b.titel && back.text === b.text && back.ordner === 'projekte' && back.projekt === 'Urlaub 2027' && back.offen && back.faellig === '2027-03-01' && back.changed === b.changed, 'Markdown → Notiz: alles wieder da', JSON.stringify(back));
const plain = markdownToNote('# Einkauf\n\n- Milch\n- Brot', 'Themen/Einkauf.md');
check(plain.titel === 'Einkauf' && plain.ordner === 'themen' && /Milch/.test(plain.text), 'Fremde Markdown-Datei ohne Kopfdaten: Titel und Ordner aus Pfad', JSON.stringify(plain));

const files = exportVault([a, b, c, makeNote({ titel: 'Garten', text: 'zweite' })]);
const paths = Object.keys(files);
check(paths.includes('Start.md') && paths.includes('Eingang/Garten.md') && paths.includes('Eingang/Garten 2.md') && paths.includes('Projekte/Urlaub Ostsee.md') && paths.includes('Personen/Anna.md'), 'Export: Ordner je Bereich, gleiche Titel nummeriert, Start-Übersicht', JSON.stringify(paths));
check(/Offene Punkte/.test(files['Start.md']) && /\[\[Projekte\/Urlaub Ostsee\|Urlaub Ostsee\]\]/.test(files['Start.md']), 'Start.md verlinkt offene Punkte');
const imported = importVault(files);
check(imported.length === 4 && imported.some((n) => n.id === b.id), 'Import des exportierten Ordners: alle Notizen (Start.md übergangen)', String(imported.length));
check(fileName('a/b:c*?"<>|#d') === 'a b c d', 'Dateinamen ohne verbotene Zeichen', fileName('a/b:c*?"<>|#d'));

const newer = { ...b, text: 'Rügen gebucht', changed: 9999 };
const merged = mergeNotes([a, b], [newer, c]);
check(merged.length === 3 && merged.find((n) => n.id === b.id).text === 'Rügen gebucht', 'Zusammenführen: neuere Fassung gewinnt, Neues kommt dazu');
const dead = mergeNotes([a, b], [c], { dead: (id) => id === a.id });
check(!dead.some((n) => n.id === a.id), 'Zusammenführen: Gelöschtes kommt nicht zurück');

const inbox = parseInbox('Hier: [{"id":"x1","ordner":"projekte","projekt":"Haus","tags":["garten"],"titel":"Hecke"},{"id":"x2","ordner":"quatsch"}]');
check(inbox.length === 1 && inbox[0].ordner === 'projekte', 'Antwort des Sortierers lesen, unbekannte Ordner verwerfen', JSON.stringify(inbox));

check(parsePick('ok {"ids":["a","b"]}').join() === 'a,b' && parsePick('kaputt').length === 0, 'Auswahl des Hilfsmodells lesen');
check(/Frage: Drucker/.test(brainPickInput('Drucker', [a, b])) && !brainPickInput('x', [a]).includes('Hecke schneiden'), 'Hilfsmodell bekommt nur Titel/Projekt/Stichworte, nicht den Text');
check(isoWeek(Date.parse('2026-10-24T12:00')) === 'KW 43/2026' && isoWeek(Date.parse('2027-01-01T12:00')) === 'KW 53/2026', 'Kalenderwoche', isoWeek(Date.parse('2027-01-01T12:00')));
const done = { ...c, erledigt: 5000 };
const wf = weekFacts([a, b, done], 1500, 6000);
check(wf.neu.length === 2 && wf.erledigt.length === 1 && wf.offen.length === 2 && /## Erledigt \(1\)/.test(weekMarkdown(wf)), 'Wochenrückblick: neu, erledigt, offen', JSON.stringify({ neu: wf.neu.length, erl: wf.erledigt.length, off: wf.offen.length }));
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'Second Brain: alles in Ordnung');
process.exit(failed ? 1 : 0);
