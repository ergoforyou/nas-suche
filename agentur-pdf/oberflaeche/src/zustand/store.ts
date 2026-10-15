// Zentraler Oberflächen-Zustand (bewusst schlank, ohne Fremdbibliothek).

import { useSyncExternalStore } from "react";
import type {
  Anmerkung,
  Formularfeld,
  Gruppe,
  Punkt,
  Rechteck,
  Stil,
  Ansicht,
  AnsichtsModus,
  Dokument,
  DokumentInfo,
  Einstellungen,
  Seitenleistenpanel,
  Treffer,
  Werkzeug,
  ZfEintrag,
  ZoomModus,
  Auftrag,
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

/** Inline-Texteditor (Schreibmaschine, Textfeld, Notiz) */
export interface Editor {
  dokId: string;
  seite: number;
  /** bestehende Anmerkung oder null = neu */
  id: number | null;
  art: "schreibmaschine" | "textfeld" | "notiz";
  punkt: Punkt;
  rechteck?: Rechteck;
  text: string;
  stil: Stil;
}

/** Sofort sichtbare Änderung an einer Anmerkung, bis der Dienst die neue
 * Darstellung geliefert hat (kein Springen, kein Flackern). */
export interface AnmVorschau {
  seite: number;
  rechteck?: Rechteck;
  /** Bild verstecken (z. B. während der Text bearbeitet wird) */
  versteckt?: boolean;
  /** Text so anzeigen, wie er gerade eingegeben wurde */
  text?: { inhalt: string; art: "schreibmaschine" | "textfeld"; punkt: Punkt; rechteck?: Rechteck; stil: Stil };
  /** Darstellungskennung vor der Änderung – sobald eine andere geladen ist, entfällt die Vorschau */
  alteV: string;
}

/** Bild, Unterschrift oder Stempel, der gerade platziert wird */
export interface Platzierung {
  art: "bild" | "unterschrift";
  bildId?: string;
  unterschriftId?: string;
  bild: string; // Daten-URL für die Vorschau
  breite: number; // Pixel des Bildes (Seitenverhältnis)
  hoehe: number;
}

export type Dialog =
  | { art: "teilen"; dokId: string }
  | { art: "druck"; dokId: string; export: boolean }
  | { art: "kennwort"; dokId: string }
  | { art: "schwaerzen"; dokId: string }
  | { art: "komprimieren"; dokId: string }
  | { art: "eigenschaften"; dokId: string }
  | { art: "bild"; dokId: string; unterschrift: boolean }
  | { art: "foto"; dokId: string | null; seite: number | null }
  | { art: "stempel" }
  | { art: "bilderexport"; dokId: string }
  | { art: "leerseiten"; dokId: string; seiten: number[] }
  | { art: "ungespeichert"; dokId: string; weiter: () => void }
  | { art: "zusammenfuehren"; eintraege: ZfEintrag[] }
  | { art: "ocr"; dokId: string }
  | { art: "ueberwachung" }
  | { art: "info" }
  | { art: "bereichstext"; text: string; sicherheit: number };

export interface Zustand {
  dokumente: Dokument[];
  aktiv: string | null;
  /** nebeneinander angezeigte Dokumente (1 = normale Ansicht); ``aktiv`` ist der fokussierte Bereich */
  bereiche: string[];
  /** zuletzt aktive Dokumente, neuestes zuerst (für „Nebeneinander“) */
  verlauf: string[];
  dialog: Dialog | null;
  /** laufende und gerade beendete Hintergrundaufträge */
  auftraege: Auftrag[];
  /** Seiten ohne Text je Dokument (für den Hinweis „Texterkennung starten“) */
  textlos: Record<string, number>;
  /** ausgeblendete Hinweise je Dokument */
  hinweisWeg: Record<string, boolean>;
  /** Anmerkungen je Dokument (mit Dokumentversion, für die sie gelten) */
  anmerkungen: Record<string, { version: number; seiten: Record<string, Anmerkung[]> }>;
  /** Formularfelder je Dokument */
  formulare: Record<string, { version: number; seiten: Record<string, Formularfeld[]> }>;
  /** ausgewählte Anmerkung */
  anmAuswahl: { dokId: string; seite: number; id: number } | null;
  editor: Editor | null;
  /** in der Ansicht ausgeblendete Anmerkungsgruppen */
  ausblenden: Gruppe[];
  /** Stil je Werkzeug (Farbe, Linienbreite …) */
  stile: Record<string, Stil>;
  platzieren: Platzierung | null;
  /** gewählte Stempelvorlage (Index in den Einstellungen) */
  stempelVorlage: number;
  /** Vorschau geänderter Anmerkungen, Schlüssel „dokId:id“ (neu: „dokId:neu:seite“) */
  anmVorschau: Record<string, AnmVorschau>;
  /** zuletzt aufgenommener Screenshot (Hinweiskarte) */
  screenshot: { png: string; pdf: string | null; text: string; nonce: number } | null;
  /** markierter Text (Wortindizes) für Kopieren/Hervorheben */
  textAuswahl: { dokId: string; seite: number; von: number; bis: number } | null;
  /** unsichere Wörter je Dokument und Seite (nur wenn eingeblendet) */
  unsicher: Record<string, Record<string, [number, number, number, number][]>>;
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
  bereiche: [],
  verlauf: [],
  dialog: null,
  auftraege: [],
  textlos: {},
  hinweisWeg: {},
  unsicher: {},
  anmerkungen: {},
  formulare: {},
  anmAuswahl: null,
  editor: null,
  ausblenden: [],
  stile: {},
  platzieren: null,
  stempelVorlage: 0,
  textAuswahl: null,
  screenshot: null,
  anmVorschau: {},
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
  zustand = bereicheAbgleichen(zustand, { ...zustand, ...teil });
  hoerer.forEach((h) => h());
}

/**
 * Hält die Nebeneinander-Bereiche stimmig: Wird ein Dokument aktiv, das in
 * keinem Bereich steht, ersetzt es das Dokument im fokussierten Bereich
 * (wie ein Tab-Wechsel in diesem Bereich). Geschlossene Dokumente fallen raus.
 */
function bereicheAbgleichen(alt: Zustand, neu: Zustand): Zustand {
  const offen = new Set(neu.dokumente.map((d) => d.id));
  let bereiche = neu.bereiche;
  if (neu.aktiv && !bereiche.includes(neu.aktiv)) {
    // im Bereich des bisher fokussierten Dokuments anzeigen (auch wenn es gerade geschlossen wurde)
    const slot = alt.aktiv ? bereiche.indexOf(alt.aktiv) : -1;
    if (slot >= 0) bereiche = bereiche.map((id, i) => (i === slot ? neu.aktiv! : id));
  }
  bereiche = bereiche.filter((id, i) => offen.has(id) && bereiche.indexOf(id) === i);
  if (neu.aktiv && !bereiche.includes(neu.aktiv)) {
    bereiche = bereiche.length ? [...bereiche.slice(0, -1), neu.aktiv] : [neu.aktiv];
  }
  if (!neu.aktiv) bereiche = [];
  let verlauf = neu.verlauf.filter((id) => offen.has(id));
  if (neu.aktiv && verlauf[0] !== neu.aktiv) verlauf = [neu.aktiv, ...verlauf.filter((id) => id !== neu.aktiv)];
  const gleich = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (gleich(bereiche, neu.bereiche) && gleich(verlauf, neu.verlauf)) return neu;
  return { ...neu, bereiche, verlauf };
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
      auswahl: [],
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

/** Neue Fassung eines Dokuments vom Dienst übernehmen (nach Seitenoperationen). */
export function dokumentAktualisieren(info: DokumentInfo, auswahl?: number[]): void {
  setzen((z) => ({
    dokumente: z.dokumente.map((d) => {
      if (d.id !== info.id) return d;
      const letzte = info.seitenanzahl - 1;
      return {
        ...d,
        ...info,
        auswahl: (auswahl ?? d.auswahl).filter((s) => s <= letzte),
        ansicht: { ...d.ansicht, seite: Math.min(d.ansicht.seite, letzte) },
      };
    }),
    // Suchtreffer passen nach Seitenänderungen nicht mehr
    suche: z.suche.treffer.some((t) => t.dokId === info.id)
      ? { ...z.suche, treffer: z.suche.treffer.filter((t) => t.dokId !== info.id), aktiv: -1 }
      : z.suche,
  }));
}

export function auswahlSetzen(id: string, auswahl: number[]): void {
  const sortiert = [...new Set(auswahl)].sort((a, b) => a - b);
  setzen((z) => ({ dokumente: z.dokumente.map((d) => (d.id === id ? { ...d, auswahl: sortiert } : d)) }));
}

/** Markierte Seiten – oder die aktuelle Seite, wenn nichts markiert ist. */
export function zielseiten(d: Dokument): number[] {
  return d.auswahl.length ? d.auswahl : [d.ansicht.seite];
}

// ---------------------------------------------------------- Nebeneinander
export function nebeneinanderOeffnen(id?: string): void {
  setzen((z) => {
    // Standard: das zuletzt benutzte Dokument, das noch nicht angezeigt wird
    const kandidat =
      id ?? z.verlauf.find((v) => !z.bereiche.includes(v)) ?? z.dokumente.find((d) => !z.bereiche.includes(d.id))?.id;
    if (!kandidat) return {};
    if (z.bereiche.includes(kandidat)) return { aktiv: kandidat };
    const fokus = Math.max(0, z.bereiche.indexOf(z.aktiv ?? ""));
    const bereiche = [...z.bereiche];
    bereiche.splice(fokus + 1, 0, kandidat);
    return { bereiche, aktiv: kandidat };
  });
}

export function bereichSchliessen(id: string): void {
  setzen((z) => {
    if (z.bereiche.length <= 1) return {};
    const index = z.bereiche.indexOf(id);
    const bereiche = z.bereiche.filter((b) => b !== id);
    return { bereiche, aktiv: z.aktiv === id ? bereiche[Math.max(0, index - 1)] : z.aktiv };
  });
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
  setzen((z) => ({
    werkzeug: z.werkzeug === werkzeug && werkzeug !== "hand" ? "hand" : werkzeug,
    anmAuswahl: null,
    textAuswahl: werkzeug === "textauswahl" ? z.textAuswahl : null,
    platzieren: werkzeug === "platzieren" ? z.platzieren : null,
  }));
}

/** Nach einmaliger Benutzung zurück zur Hand – außer „Werkzeug fixieren“ ist an. */
export function werkzeugBenutzt(): void {
  if (!zustand.werkzeugFixiert) setzen({ werkzeug: "hand" });
}
