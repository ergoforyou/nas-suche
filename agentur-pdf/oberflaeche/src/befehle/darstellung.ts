// Darstellung der Befehle: Symbolfarben (wie in klassischen PDF-Programmen
// farbig nach Bereich) und die Zusammenstellung des Registers „Start“.

import { alleBefehle, befehl, type Befehl } from "./register";

const FARBEN: [RegExp, string][] = [
  [/^werkzeug\.hervorheben/, "#D9A300"],
  [/^werkzeug\.unterstreichen/, "#1E6FD9"],
  [/^werkzeug\.(durchstreichen|wellenlinie)/, "#D13438"],
  [/^werkzeug\.notiz/, "#E09A00"],
  [/^werkzeug\.(schreibmaschine|textfeld)|^formular/, "#1F5BAA"],
  [/^werkzeug\.(rechteck|ellipse|linie|pfeil|freihand)/, "#D13438"],
  [/^werkzeug\.stempel|^stempel/, "#C0262D"],
  [/^werkzeug\.abdecken/, "#6B6B6B"],
  [/^werkzeug\.schwaerzen|^schwaerzen/, "#1B1B1B"],
  [/^werkzeug\.(textauswahl)/, "#3B4A5A"],
  [/^bild\.unterschrift/, "#1E3A8A"],
  [/^bild\.|^foto/, "#107C41"],
  [/^schutz/, "#B88A00"],
  [/^ausgabe\.drucken/, "#3B4A5A"],
  [/^ausgabe/, "#107C41"],
  [/^ocr|^screenshot/, "#7A3FB5"],
  [/^konvertieren/, "#D35400"],
  [/^seiten\.loeschen|^seiten\.leerseiten/, "#D13438"],
  [/^seiten/, "#1F5BAA"],
  [/^ebenen|^kommentare/, "#0F7B8A"],
  [/^datei|^bearbeiten\./, "#1F5BAA"],
  [/^dokument/, "#0F7B8A"],
];

export function befehlsfarbe(b: Befehl): string {
  if (b.farbe) return b.farbe;
  return FARBEN.find(([muster]) => muster.test(b.id))?.[1] ?? "#3B4A5A";
}

/** Register „Start“: die meistgenutzten Werkzeuge aus allen Bereichen */
const START: [id: string, gruppe: string, gross?: boolean][] = [
  ["werkzeug.hand", "Werkzeuge", true],
  ["werkzeug.textauswahl", "Werkzeuge", true],
  ["werkzeug.lassozoom", "Werkzeuge"],
  ["werkzeug.lupe", "Werkzeuge"],
  ["ocr.bereich", "Werkzeuge"],
  ["zoom.seitenbreite", "Zoom"],
  ["zoom.ganzeseite", "Zoom"],
  ["zoom.100", "Zoom"],
  ["werkzeug.hervorheben", "Kommentieren", true],
  ["werkzeug.notiz", "Kommentieren"],
  ["werkzeug.stempel", "Kommentieren"],
  ["werkzeug.rechteck", "Kommentieren"],
  ["werkzeug.schreibmaschine", "Bearbeiten", true],
  ["bild.unterschrift", "Bearbeiten", true],
  ["bild.einfuegen", "Bearbeiten"],
  ["seiten.aufbereiten", "Bearbeiten"],
  ["werkzeug.abdecken", "Bearbeiten"],
  ["seiten.rechts_drehen", "Seiten"],
  ["seiten.datei_einfuegen", "Seiten"],
  ["seiten.loeschen", "Seiten"],
  ["konvertieren.zusammenfuehren", "PDF erstellen", true],
  ["ocr.dokument", "PDF erstellen", true],
  ["werkzeug.schwaerzen", "Schützen"],
  ["schutz.kennwort", "Schützen"],
  ["ausgabe.drucken", "Schützen"],
  ["ansicht.suchen", "Suchen", true],
];

export function startEinrichten(): void {
  for (const [id, gruppe, gross] of START) {
    const b = befehl(id);
    if (b) {
      b.start = gruppe;
      b.startGross = gross ?? false;
    }
  }
}

/** Befehle eines Registers in Anzeige-Reihenfolge (Start: gesammelt) */
export function befehleFuer(register: string): { b: Befehl; gruppe: string; gross: boolean }[] {
  if (register !== "start") {
    return alleBefehle()
      .filter((b) => b.register === register)
      .map((b) => ({ b, gruppe: b.gruppe, gross: Boolean(b.gross) }));
  }
  return START.map(([id]) => befehl(id))
    .filter((b): b is Befehl => Boolean(b))
    .map((b) => ({ b, gruppe: b.start!, gross: Boolean(b.startGross) }));
}
