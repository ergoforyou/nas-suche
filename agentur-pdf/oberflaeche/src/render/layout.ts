// Seitenlayout: berechnet aus Seitengrößen, Zoom, Ansichtsmodus und Drehung
// die Position jeder Seite in der scrollbaren Fläche.

import type { AnsichtsModus, SeitenInfo } from "../typen";

/** 100 % = Originalgröße: 1 pt = 1/72 Zoll, Bildschirm = 96 px/Zoll */
export const PT_ZU_PX = 96 / 72;
export const RAND = 16; // Außenabstand in px
export const ABSTAND = 12; // Abstand zwischen Seiten in px

export interface SeitenBox {
  seite: number;
  x: number;
  y: number;
  b: number;
  h: number;
}

export interface Layout {
  boxen: SeitenBox[]; // nur Seiten, die im Modus überhaupt dargestellt werden
  zeilen: { y: number; h: number; seiten: number[] }[];
  breite: number;
  hoehe: number;
}

export function anzeigeGroesse(s: SeitenInfo, drehung: number): [number, number] {
  return drehung % 180 === 0 ? [s.breite, s.hoehe] : [s.hoehe, s.breite];
}

export function zeilenBilden(anzahl: number, modus: AnsichtsModus): number[][] {
  const zeilen: number[][] = [];
  const doppelt = modus === "doppelseite" || modus === "doppelseite_fortlaufend";
  for (let i = 0; i < anzahl; i += doppelt ? 2 : 1) {
    zeilen.push(doppelt && i + 1 < anzahl ? [i, i + 1] : [i]);
  }
  return zeilen;
}

export function istFortlaufend(modus: AnsichtsModus): boolean {
  return modus === "fortlaufend" || modus === "doppelseite_fortlaufend";
}

export function layoutBerechnen(
  seiten: SeitenInfo[],
  zoom: number,
  modus: AnsichtsModus,
  drehung: number,
  aktuelleSeite: number,
  viewportBreite: number,
): Layout {
  const skala = zoom * PT_ZU_PX;
  let alleZeilen = zeilenBilden(seiten.length, modus);
  if (!istFortlaufend(modus)) {
    alleZeilen = alleZeilen.filter((z) => z.includes(aktuelleSeite));
  }
  const zeilenMasse = alleZeilen.map((zeile) => {
    const groessen = zeile.map((i) => anzeigeGroesse(seiten[i], drehung).map((v) => Math.round(v * skala)) as [number, number]);
    const breite = groessen.reduce((s, g) => s + g[0], 0) + ABSTAND * (zeile.length - 1);
    const hoehe = Math.max(...groessen.map((g) => g[1]));
    return { zeile, groessen, breite, hoehe };
  });
  const maxBreite = Math.max(0, ...zeilenMasse.map((z) => z.breite));
  const gesamtBreite = Math.max(viewportBreite, maxBreite + 2 * RAND);
  const boxen: SeitenBox[] = [];
  const zeilen: Layout["zeilen"] = [];
  let y = RAND;
  for (const z of zeilenMasse) {
    let x = Math.round((gesamtBreite - z.breite) / 2);
    z.zeile.forEach((seite, k) => {
      const [b, h] = z.groessen[k];
      boxen.push({ seite, x, y: y + Math.round((z.hoehe - h) / 2), b, h });
      x += b + ABSTAND;
    });
    zeilen.push({ y, h: z.hoehe, seiten: z.zeile });
    y += z.hoehe + ABSTAND;
  }
  return { boxen, zeilen, breite: gesamtBreite, hoehe: y - ABSTAND + RAND };
}

/** Zoom, bei dem die (breiteste) Seite die Viewportbreite ausfüllt. */
export function zoomSeitenbreite(seiten: SeitenInfo[], modus: AnsichtsModus, drehung: number, vpBreite: number, referenz = 0): number {
  const zeile = zeilenBilden(seiten.length, modus).find((z) => z.includes(referenz)) ?? [0];
  const breitePt = zeile.reduce((s, i) => s + anzeigeGroesse(seiten[i], drehung)[0], 0);
  const verfuegbar = vpBreite - 2 * RAND - ABSTAND * (zeile.length - 1) - 4;
  return verfuegbar / (breitePt * PT_ZU_PX);
}

export function zoomGanzeSeite(seiten: SeitenInfo[], modus: AnsichtsModus, drehung: number, vpBreite: number, vpHoehe: number, referenz = 0): number {
  const zeile = zeilenBilden(seiten.length, modus).find((z) => z.includes(referenz)) ?? [0];
  const hoehePt = Math.max(...zeile.map((i) => anzeigeGroesse(seiten[i], drehung)[1]));
  const ausHoehe = (vpHoehe - 2 * RAND) / (hoehePt * PT_ZU_PX);
  return Math.min(ausHoehe, zoomSeitenbreite(seiten, modus, drehung, vpBreite, referenz));
}

/** Rechteck (normiert, angezeigte Seite) um die Ansichtsdrehung drehen. */
export function rechteckDrehen(r: [number, number, number, number], drehung: number): [number, number, number, number] {
  const [x0, y0, x1, y1] = r;
  switch (((drehung % 360) + 360) % 360) {
    case 90:
      return [1 - y1, x0, 1 - y0, x1];
    case 180:
      return [1 - x1, 1 - y1, 1 - x0, 1 - y0];
    case 270:
      return [y0, 1 - x1, y1, 1 - x0];
    default:
      return r;
  }
}

/** Index der ersten Box, deren Unterkante unter ``y`` liegt (Binärsuche). */
export function ersteSichtbare(boxen: SeitenBox[], y: number): number {
  let lo = 0;
  let hi = boxen.length - 1;
  while (lo < hi) {
    const mitte = (lo + hi) >> 1;
    if (boxen[mitte].y + boxen[mitte].h < y) lo = mitte + 1;
    else hi = mitte;
  }
  return lo;
}

// Render-Stufen identisch zum Dienst (agentur_pdf/kern/dokumente.py)
export const RENDER_STUFEN = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16];

export function renderStufe(skala: number): number {
  return RENDER_STUFEN.find((s) => s >= skala - 1e-6) ?? RENDER_STUFEN[RENDER_STUFEN.length - 1];
}
