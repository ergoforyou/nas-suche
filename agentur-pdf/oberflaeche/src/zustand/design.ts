// Design: Anordnen von Bildern/Elementen, Textbausteine.

import { api } from "../api";
import type { Rechteck } from "../typen";
import { anmerkungAendern, anmerkungFinden, stilSetzen } from "./anmerkungen";
import { anwenden } from "./seitenaktionen";
import { holen, melden, setzen, werkzeugWaehlen } from "./store";

function auswahl() {
  const a = holen().anmAuswahl;
  if (!a) {
    melden("Bitte zuerst ein Bild oder Element auf der Seite anklicken.", "fehler");
    return null;
  }
  const anm = anmerkungFinden(a.dokId, a.seite, a.id);
  return anm ? { ...a, anm } : null;
}

export async function ebeneAendern(richtung: "vorne" | "hinten" | "ganz_vorne" | "ganz_hinten"): Promise<void> {
  const a = auswahl();
  if (!a) return;
  try {
    anwenden(await api.anmerkungEbene(a.dokId, a.id, a.seite, richtung));
  } catch (e) {
    melden((e as Error).message, "fehler");
  }
}

export async function bildUmformen(aktion: "rechts" | "links" | "waagerecht" | "senkrecht" | "duplizieren"): Promise<void> {
  const a = auswahl();
  if (!a) return;
  try {
    const r = await api.anmerkungUmformen(a.dokId, a.id, a.seite, aktion);
    anwenden(r);
    setzen({ anmAuswahl: { dokId: a.dokId, seite: a.seite, id: r.id } });
  } catch (e) {
    melden((e as Error).message, "fehler");
  }
}

/** Ausrichten am Satzspiegel (20 mm Rand) der Seite */
export function ausrichten(wie: "links" | "zentriert" | "rechts" | "oben" | "mitte" | "unten"): void {
  const a = auswahl();
  if (!a) return;
  const s = holen().dokumente.find((d) => d.id === a.dokId)?.seiten[a.seite];
  if (!s) return;
  const randX = (20 / 25.4) * 72 / s.breite;
  const randY = (20 / 25.4) * 72 / s.hoehe;
  const [x0, y0, x1, y1] = a.anm.rechteck;
  const b = x1 - x0;
  const h = y1 - y0;
  let nx = x0;
  let ny = y0;
  if (wie === "links") nx = randX;
  if (wie === "zentriert") nx = (1 - b) / 2;
  if (wie === "rechts") nx = 1 - randX - b;
  if (wie === "oben") ny = randY;
  if (wie === "mitte") ny = (1 - h) / 2;
  if (wie === "unten") ny = 1 - randY - h;
  const r: Rechteck = [nx, ny, nx + b, ny + h];
  void anmerkungAendern(a.dokId, a.seite, a.id, { rechteck: r }, { rechteck: r });
}

/** Gestaltete Textbausteine = Textfeld-Werkzeug mit passendem Stil */
export const TEXTBAUSTEINE = {
  ueberschrift: { titel: "Überschrift", stil: { farbe: "", fuellung: null, breite: 0, schriftgroesse: 20, deckkraft: 1 } },
  hinweis: { titel: "Hinweisbox", stil: { farbe: "#1A1A1A", fuellung: "#FFF4D6", breite: 1, schriftgroesse: 11, deckkraft: 1 } },
  preis: { titel: "Preisbox", stil: { farbe: "#FFFFFF", fuellung: "", breite: 0, schriftgroesse: 16, deckkraft: 1 } },
  info: { titel: "Infokasten", stil: { farbe: "#1E3A8A", fuellung: "#E8F0FE", breite: 1, schriftgroesse: 11, deckkraft: 1 } },
} as const;

export function textbaustein(art: keyof typeof TEXTBAUSTEINE): void {
  const haus = holen().einstellungen?.hausfarben ?? [];
  const akzent = haus[0] ?? "#B5121B";
  const stil = { ...TEXTBAUSTEINE[art].stil } as { farbe: string; fuellung: string | null; breite: number; schriftgroesse: number; deckkraft: number };
  if (art === "ueberschrift") stil.farbe = akzent;
  if (art === "preis") stil.fuellung = akzent;
  if (art === "hinweis") stil.farbe = haus[1] ?? stil.farbe;
  stilSetzen("textfeld", stil);
  if (holen().werkzeug !== "textfeld") werkzeugWaehlen("textfeld");
  melden(`${TEXTBAUSTEINE[art].titel}: Rahmen auf der Seite aufziehen und Text eingeben.`);
}
