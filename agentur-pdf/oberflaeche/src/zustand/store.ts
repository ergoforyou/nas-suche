// Zentraler Oberflächen-Zustand (bewusst schlank, ohne Fremdbibliothek).

import { useSyncExternalStore } from "react";
import type {
  Ansicht,
  AnsichtsModus,
  Dokument,
  DokumentInfo,
  Einstellungen,
  Seitenleistenpanel,
  Treffer,
  Werkzeug,
  ZoomModus,
} from "../typen";

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_STUFEN = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export interface Sprungziel {
  dokId: string;
  seite: number;
  rechteck?: [number, number, number, number];
  nonce: number;
}

export interface Meldung {
  text: string;
  art: "info" | "fehler";
  nonce: number;
}

export interface Zustand {
  dokumente: Dokument[];
  aktiv: string | null;
  register: string;
  werkzeug: Werkzeug;
  werkzeugFixiert: boolean;
  lupeFaktor: number;
  seitenleiste: { offen: boolean; panel: Seitenleistenpanel; breite: number; miniGroesse: number };
  befehlssucheOffen: boolean;
  suche: { begriff: string; alleDokumente: boolean; treffer: Treffer[]; aktiv: number; laeuft: boolean };
  sprung: Sprungziel | null;
  einstellungen: Einstellungen | null;
  desktop: boolean;
  meldung: Meldung | null;
  passwortAnfrage: { titel: string; wiederholen: (pw: string) => void } | null;
}

let zustand: Zustand = {
  dokumente: [],
  aktiv: null,
  register: "start",
  werkzeug: "hand",
  werkzeugFixiert: false,
  lupeFaktor: 3,
  seitenleiste: { offen: true, panel: "miniaturen", breite: 220, miniGroesse: 120 },
  befehlssucheOffen: false,
  suche: { begriff: "", alleDokumente: false, treffer: [], aktiv: -1, laeuft: false },
  sprung: null,
  einstellungen: null,
  desktop: false,
  meldung: null,
  passwortAnfrage: null,
};

const hoerer = new Set<() => void>();

export function holen(): Zustand {
  return zustand;
}

export function setzen(aenderung: Partial<Zustand> | ((z: Zustand) => Partial<Zustand>)): void {
  const teil = typeof aenderung === "function" ? aenderung(zustand) : aenderung;
  zustand = { ...zustand, ...teil };
  hoerer.forEach((h) => h());
}

export function abonnieren(h: () => void): () => void {
  hoerer.add(h);
  return () => hoerer.delete(h);
}

export function useZustand<T>(auswahl: (z: Zustand) => T): T {
  return useSyncExternalStore(abonnieren, () => auswahl(zustand));
}

// ------------------------------------------------------------- Dokumente
export function aktivesDokument(z: Zustand = zustand): Dokument | null {
  return z.dokumente.find((d) => d.id === z.aktiv) ?? null;
}

export function dokumentHinzufuegen(info: DokumentInfo, ansicht?: Partial<Ansicht>): void {
  setzen((z) => {
    const vorhanden = z.dokumente.find((d) => d.id === info.id);
    if (vorhanden) return { aktiv: info.id };
    const e = z.einstellungen;
    const dok: Dokument = {
      ...info,
      ansicht: {
        modus: e?.standard_ansicht ?? "fortlaufend",
        zoomModus: e?.standard_zoom ?? "seitenbreite",
        zoom: 1,
        drehung: 0,
        seite: 0,
        scrollX: 0,
        scrollY: 0,
        ...ansicht,
      },
    };
    return { dokumente: [...z.dokumente, dok], aktiv: info.id };
  });
}

export function dokumentEntfernen(id: string): void {
  setzen((z) => {
    const index = z.dokumente.findIndex((d) => d.id === id);
    const dokumente = z.dokumente.filter((d) => d.id !== id);
    let aktiv = z.aktiv;
    if (aktiv === id) aktiv = dokumente[Math.min(index, dokumente.length - 1)]?.id ?? null;
    return {
      dokumente,
      aktiv,
      suche: { ...z.suche, treffer: z.suche.treffer.filter((t) => t.dokId !== id), aktiv: -1 },
    };
  });
}

export function ansichtAendern(id: string, aenderung: Partial<Ansicht>): void {
  setzen((z) => ({
    dokumente: z.dokumente.map((d) => (d.id === id ? { ...d, ansicht: { ...d.ansicht, ...aenderung } } : d)),
  }));
}

export function tabVerschieben(von: number, nach: number): void {
  setzen((z) => {
    const liste = [...z.dokumente];
    const [d] = liste.splice(von, 1);
    liste.splice(nach, 0, d);
    return { dokumente: liste };
  });
}

// ------------------------------------------------------------------ Zoom
export function zoomBegrenzen(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function zoomSetzen(zoom: number, modus: ZoomModus = "frei"): void {
  const d = aktivesDokument();
  if (d) ansichtAendern(d.id, { zoom: zoomBegrenzen(zoom), zoomModus: modus });
}

export function zoomSchritt(richtung: 1 | -1): void {
  const d = aktivesDokument();
  if (!d) return;
  const aktuell = d.ansicht.zoom;
  const ziel =
    richtung > 0
      ? ZOOM_STUFEN.find((s) => s > aktuell + 0.001) ?? ZOOM_MAX
      : [...ZOOM_STUFEN].reverse().find((s) => s < aktuell - 0.001) ?? ZOOM_MIN;
  zoomSetzen(ziel);
}

export function modusSetzen(modus: AnsichtsModus): void {
  const d = aktivesDokument();
  if (d) ansichtAendern(d.id, { modus });
}

export function ansichtDrehen(grad: 90 | -90): void {
  const d = aktivesDokument();
  if (d) ansichtAendern(d.id, { drehung: (d.ansicht.drehung + grad + 360) % 360 });
}

export function springen(dokId: string, seite: number, rechteck?: [number, number, number, number]): void {
  setzen({ aktiv: dokId, sprung: { dokId, seite, rechteck, nonce: Date.now() + Math.random() } });
}

// --------------------------------------------------------------- Meldungen
export function melden(text: string, art: "info" | "fehler" = "info"): void {
  setzen({ meldung: { text, art, nonce: Date.now() } });
}

export function werkzeugWaehlen(werkzeug: Werkzeug): void {
  setzen((z) => ({ werkzeug: z.werkzeug === werkzeug && werkzeug !== "hand" ? "hand" : werkzeug }));
}

/** Nach einmaliger Benutzung zurück zur Hand – außer „Werkzeug fixieren“ ist an. */
export function werkzeugBenutzt(): void {
  if (!zustand.werkzeugFixiert) setzen({ werkzeug: "hand" });
}
