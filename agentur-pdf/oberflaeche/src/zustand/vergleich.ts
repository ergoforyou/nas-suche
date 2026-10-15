// Dokumentvergleich: starten, durch die Unterschiede springen, beenden.

import { api } from "../api";
import { holen, melden, setzen, springen } from "./store";

export async function vergleichStarten(a: string, b: string): Promise<boolean> {
  try {
    const ergebnis = await api.vergleichen(a, b);
    setzen((z) => ({
      vergleich: { a, b, ergebnis, aktiv: -1 },
      bereiche: [a, b],
      aktiv: a,
      dialog: null,
      seitenleiste: { ...z.seitenleiste, offen: true, panel: "vergleich" },
    }));
    if (!ergebnis.anzahl) melden(ergebnis.ohne_text ? "Kein Unterschied gefunden (Bildvergleich – keine Textebene)." : "Die Dokumente sind inhaltlich gleich.");
    else {
      melden(`${ergebnis.anzahl} Unterschied${ergebnis.anzahl === 1 ? "" : "e"} gefunden.`);
      vergleichSpringen(0);
    }
    return true;
  } catch (e) {
    melden((e as Error).message, "fehler");
    return false;
  }
}

/** Zum Unterschied ``index`` springen – in beiden Dokumenten. */
export function vergleichSpringen(index: number): void {
  const v = holen().vergleich;
  if (!v || !v.ergebnis.aenderungen.length) return;
  const i = (index + v.ergebnis.aenderungen.length) % v.ergebnis.aenderungen.length;
  const x = v.ergebnis.aenderungen[i];
  setzen({ vergleich: { ...v, aktiv: i } });
  const zielB = x.b[0];
  const zielA = x.a[0];
  if (zielB) springen(v.b, zielB.seite, zielB.rechteck);
  // zweiter Sprung nach dem ersten Bildaufbau (es gibt nur ein Sprungziel zur Zeit)
  window.setTimeout(() => {
    if (zielA) springen(v.a, zielA.seite, zielA.rechteck);
  }, 90);
}

export function vergleichBeenden(): void {
  setzen((z) => ({
    vergleich: null,
    bereiche: z.aktiv ? [z.aktiv] : [],
    seitenleiste: { ...z.seitenleiste, panel: z.seitenleiste.panel === "vergleich" ? "miniaturen" : z.seitenleiste.panel },
  }));
}
