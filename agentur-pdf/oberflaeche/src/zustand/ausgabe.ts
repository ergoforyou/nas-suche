// Drucken, Exportieren, Bilder wählen – Hilfsfunktionen für die Dialoge.

import { api, herunterladen } from "../api";
import type { BildDaten, Dokument } from "../typen";
import { anwenden, namensvorschlag } from "./seitenaktionen";
import { holen, melden, setzen, werkzeugWaehlen } from "./store";

export function fehlerMelden(e: unknown): void {
  melden(e instanceof Error ? e.message : String(e), "fehler");
}

/** „1-3, 5, 8-“ → 0-basierte Seiten (null bei ungültiger Eingabe) */
export function seitenbereich(text: string, anzahl: number): number[] | null {
  const seiten = new Set<number>();
  for (const teil of text.split(/[,;]/).map((t) => t.trim()).filter(Boolean)) {
    const m = teil.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const von = m[1] ? parseInt(m[1], 10) : 1;
      const bis = m[2] ? parseInt(m[2], 10) : anzahl;
      if (von < 1 || bis > anzahl || von > bis) return null;
      for (let i = von; i <= bis; i++) seiten.add(i - 1);
    } else if (/^\d+$/.test(teil)) {
      const n = parseInt(teil, 10);
      if (n < 1 || n > anzahl) return null;
      seiten.add(n - 1);
    } else return null;
  }
  return seiten.size ? [...seiten].sort((a, b) => a - b) : null;
}

/** Datei speichern: Desktop → Speichern-Dialog, Browser → Download.
 * ``erzeugen(pfad)`` liefert bei Pfad nichts, sonst eine Download-URL. */
export async function ausgabeSpeichern(
  vorschlag: string,
  erzeugen: (pfad: string | null) => Promise<{ url?: string; pfad?: string }>,
): Promise<boolean> {
  try {
    if (holen().desktop) {
      const wahl = await api.dialogSpeichern(vorschlag);
      if (!wahl.pfad) return false;
      const r = await erzeugen(wahl.pfad);
      melden(`Gespeichert: ${r.pfad ?? wahl.pfad}`);
      return true;
    }
    const r = await erzeugen(null);
    if (r.url) await herunterladen(r.url, vorschlag.split(/[\\/]/).pop() ?? "export.pdf");
    return true;
  } catch (e) {
    fehlerMelden(e);
    return false;
  }
}

export function exportName(d: Dokument, zusatz: string): string {
  return namensvorschlag(d).replace(/\.pdf$/i, `${zusatz}.pdf`);
}

// ------------------------------------------------------------- Bilder wählen
let bildEingabe: HTMLInputElement | null = null;

/** Bilddatei auswählen (Browser-Dateiauswahl, im Desktop-Fenster nativ) */
export function bildWaehlen(): Promise<File | null> {
  return new Promise((fertig) => {
    bildEingabe?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.heic,.heif";
    input.style.display = "none";
    input.onchange = () => {
      fertig(input.files?.[0] ?? null);
      input.remove();
    };
    document.body.appendChild(input);
    bildEingabe = input;
    input.click();
  });
}

/** Bild/Unterschrift zum Platzieren vorbereiten → Werkzeug „platzieren“ */
export function platzierenStarten(art: "bild" | "unterschrift", bild: BildDaten, unterschriftId?: string): void {
  setzen({
    dialog: null,
    platzieren: {
      art,
      bildId: unterschriftId ? undefined : bild.id,
      unterschriftId,
      bild: bild.bild,
      breite: bild.breite,
      hoehe: bild.hoehe,
    },
  });
  werkzeugWaehlen("platzieren");
  melden("Auf die Seite klicken (oder Rechteck aufziehen), um das Bild zu platzieren. Esc bricht ab.");
}

export async function aenderungAnwenden<T extends Parameters<typeof anwenden>[0]>(p: Promise<T>): Promise<T | null> {
  try {
    const r = await p;
    anwenden(r);
    return r;
  } catch (e) {
    fehlerMelden(e);
    return null;
  }
}

export function groesseText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}
