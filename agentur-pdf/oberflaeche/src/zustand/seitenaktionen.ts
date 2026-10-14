// Seiten organisieren, Rückgängig, Speichern – Oberflächenseite.

import { api } from "../api";
import type { Aenderungsantwort, Dokument } from "../typen";
import {
  aktivesDokument,
  dokumentAktualisieren,
  dokumentHinzufuegen,
  holen,
  melden,
  setzen,
  springen,
  zielseiten,
} from "./store";

function fehlerText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Antwort des Dienstes übernehmen. ``auswahlFuer``: Dokument, dessen Auswahl
 * auf die zurückgegebenen Positionen gesetzt wird (z. B. eingefügte Seiten). */
export function anwenden(antwort: Aenderungsantwort, auswahlFuer?: string): void {
  for (const info of antwort.dokumente) {
    dokumentAktualisieren(info, info.id === auswahlFuer ? antwort.auswahl ?? [] : undefined);
  }
  for (const info of antwort.neu) dokumentHinzufuegen(info);
}

async function sicher<T>(aktion: () => Promise<T>): Promise<T | undefined> {
  try {
    return await aktion();
  } catch (e) {
    melden(fehlerText(e), "fehler");
    return undefined;
  }
}

function aktiv(): Dokument | null {
  const d = aktivesDokument();
  if (!d) melden("Kein Dokument geöffnet.");
  return d;
}

const seitenText = (n: number) => (n === 1 ? "1 Seite" : `${n} Seiten`);

// ------------------------------------------------------------- Operationen
export async function seitenDrehen(grad: 90 | -90 | 180, d = aktiv()): Promise<void> {
  if (!d) return;
  // Drehen ändert keine Positionen – Auswahl bleibt erhalten
  await sicher(async () => anwenden(await api.drehen(d.id, zielseiten(d), grad)));
}

export async function seitenLoeschen(d = aktiv()): Promise<void> {
  if (!d) return;
  const seiten = zielseiten(d);
  if (seiten.length >= d.seitenanzahl) {
    melden("Mindestens eine Seite muss im Dokument bleiben.", "fehler");
    return;
  }
  const ok = await sicher(async () => {
    anwenden(await api.loeschen(d.id, seiten), d.id);
    return true;
  });
  if (ok) melden(`${seitenText(seiten.length)} gelöscht – Strg+Z macht es rückgängig.`);
}

export async function seitenDuplizieren(d = aktiv()): Promise<void> {
  if (!d) return;
  await sicher(async () => anwenden(await api.duplizieren(d.id, zielseiten(d)), d.id));
}

export async function leereSeiteEinfuegen(danach = true, d = aktiv()): Promise<void> {
  if (!d) return;
  const seiten = zielseiten(d);
  const position = danach ? seiten[seiten.length - 1] + 1 : seiten[0];
  const antwort = await sicher(() => api.leereSeite(d.id, position));
  if (antwort) {
    anwenden(antwort, d.id);
    springen(d.id, position);
  }
}

export async function seitenVerschieben(dokId: string, seiten: number[], ziel: number): Promise<void> {
  const antwort = await sicher(() => api.verschieben(dokId, seiten, ziel));
  if (antwort) anwenden(antwort, dokId);
}

export async function seitenUebertragen(quelle: string, seiten: number[], ziel: string, position: number, verschieben: boolean): Promise<void> {
  const antwort = await sicher(() => api.uebertragen(quelle, seiten, ziel, position, verschieben));
  if (!antwort) return;
  anwenden(antwort, ziel);
  // Auswahl in der Quelle aufheben (Positionen haben sich ggf. verschoben);
  // Fokus aufs Ziel, damit Strg+Z dort sofort wirkt
  setzen((z) => ({ aktiv: ziel, dokumente: z.dokumente.map((x) => (x.id === quelle ? { ...x, auswahl: [] } : x)) }));
  melden(`${seitenText(seiten.length)} ${verschieben ? "verschoben" : "kopiert"}.`);
}

/** Dateien (aus Explorer/Outlook oder Dateiauswahl) an ``position`` einfügen. */
export async function dateienEinfuegen(dokId: string, position: number, dateien: File[]): Promise<void> {
  let pos = position;
  const eingefuegt: number[] = [];
  for (const datei of dateien) {
    const pfad = (datei as File & { pywebviewFullPath?: string }).pywebviewFullPath;
    const antwort = await sicher(() => (pfad ? api.einfuegenPfade(dokId, pos, [pfad]) : api.einfuegenDatei(dokId, pos, datei, datei.name)));
    if (!antwort) break;
    anwenden(antwort);
    eingefuegt.push(...(antwort.auswahl ?? []));
    pos += antwort.auswahl?.length ?? 0;
  }
  if (eingefuegt.length) {
    setzen((z) => ({ dokumente: z.dokumente.map((x) => (x.id === dokId ? { ...x, auswahl: eingefuegt } : x)) }));
    springen(dokId, eingefuegt[0]);
  }
}

let dateiAuswahl: HTMLInputElement | null = null;

export async function dateiEinfuegenDialog(danach = true, d = aktiv()): Promise<void> {
  if (!d) return;
  const seiten = zielseiten(d);
  const position = danach ? seiten[seiten.length - 1] + 1 : seiten[0];
  if (holen().desktop) {
    const { pfade } = (await sicher(() => api.dialogOeffnen())) ?? { pfade: [] };
    if (!pfade.length) return;
    const antwort = await sicher(() => api.einfuegenPfade(d.id, position, pfade));
    if (antwort) {
      anwenden(antwort, d.id);
      springen(d.id, position);
    }
    return;
  }
  dateiAuswahl ??= document.createElement("input");
  dateiAuswahl.type = "file";
  dateiAuswahl.multiple = true;
  dateiAuswahl.accept = ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.gif";
  dateiAuswahl.onchange = () => {
    const liste = [...(dateiAuswahl?.files ?? [])];
    if (dateiAuswahl) dateiAuswahl.value = "";
    void dateienEinfuegen(d.id, position, liste);
  };
  dateiAuswahl.click();
}

export async function ausZwischenablageEinfuegen(d = aktiv()): Promise<void> {
  if (!d) return;
  const seiten = zielseiten(d);
  const position = seiten[seiten.length - 1] + 1;
  try {
    const eintraege = await navigator.clipboard.read();
    for (const eintrag of eintraege) {
      const typ = eintrag.types.find((t) => t.startsWith("image/"));
      if (!typ) continue;
      const bild = await eintrag.getType(typ);
      const endung = typ.split("/")[1].replace("jpeg", "jpg");
      await dateienEinfuegen(d.id, position, [new File([bild], `Zwischenablage.${endung}`, { type: typ })]);
      return;
    }
    melden("Die Zwischenablage enthält kein Bild.");
  } catch {
    melden("Kein Zugriff auf die Zwischenablage – bitte Strg+V im Dokument verwenden.", "fehler");
  }
}

export async function seitenExtrahieren(loeschen = false, d = aktiv()): Promise<void> {
  if (!d) return;
  const antwort = await sicher(() => api.extrahieren(d.id, zielseiten(d), loeschen));
  if (antwort) {
    anwenden(antwort);
    melden("Seiten als neues Dokument geöffnet – mit Strg+S speichern.");
  }
}

export async function teilen(dokId: string, modus: string, wert: number): Promise<boolean> {
  const antwort = await sicher(() => api.teilen(dokId, modus, wert));
  if (!antwort) return false;
  anwenden(antwort);
  if (antwort.dateien?.length) {
    const ordner = antwort.dateien[0].replace(/[\\/][^\\/]+$/, "");
    melden(`${antwort.teile} Teile gespeichert in ${ordner}`);
  } else {
    melden(`${antwort.teile} Teile als neue Dokumente geöffnet.`);
  }
  return true;
}

export async function leerseitenSuchen(d = aktiv()): Promise<void> {
  if (!d) return;
  const seiten = await sicher(() => api.leerseiten(d.id));
  if (!seiten) return;
  if (!seiten.length) {
    melden("Keine Leerseiten gefunden.");
    return;
  }
  setzen((z) => ({
    dialog: { art: "leerseiten", dokId: d.id, seiten },
    dokumente: z.dokumente.map((x) => (x.id === d.id ? { ...x, auswahl: seiten } : x)),
  }));
}

export async function seitenEntfernen(dokId: string, seiten: number[]): Promise<void> {
  const d = holen().dokumente.find((x) => x.id === dokId);
  if (!d || !seiten.length) return;
  if (seiten.length >= d.seitenanzahl) {
    melden("Alle Seiten sind leer – es muss mindestens eine bleiben.", "fehler");
    return;
  }
  const antwort = await sicher(() => api.loeschen(dokId, seiten));
  if (antwort) {
    anwenden(antwort, dokId);
    melden(`${seitenText(seiten.length)} entfernt – Strg+Z macht es rückgängig.`);
  }
}

// ---------------------------------------------------------- Verlauf
export async function rueckgaengig(d = aktivesDokument()): Promise<void> {
  if (!d?.rueckgaengig) return;
  const titel = d.rueckgaengig;
  const antwort = await sicher(() => api.rueckgaengig(d.id));
  if (antwort) {
    anwenden(antwort);
    melden(`Rückgängig: ${titel}`);
  }
}

export async function wiederholen(d = aktivesDokument()): Promise<void> {
  if (!d?.wiederholen) return;
  const titel = d.wiederholen;
  const antwort = await sicher(() => api.wiederholen(d.id));
  if (antwort) {
    anwenden(antwort);
    melden(`Wiederholt: ${titel}`);
  }
}

// ---------------------------------------------------------- Speichern
function namensvorschlag(d: Dokument): string {
  const name = d.titel.toLowerCase().endsWith(".pdf") ? d.titel : d.titel.replace(/\.[^.]+$/, "") + ".pdf";
  return d.pfad ? d.pfad.replace(/[^\\/]+$/, name) : name;
}

export async function speichernUnter(d = aktiv()): Promise<boolean> {
  if (!d) return false;
  if (holen().desktop) {
    const auswahl = await sicher(() => api.dialogSpeichern(namensvorschlag(d)));
    if (!auswahl?.pfad) return false;
    const antwort = await sicher(() => api.speichern(d.id, auswahl.pfad!));
    if (!antwort) return false;
    anwenden(antwort);
    melden(`Gespeichert: ${antwort.pfad}`);
    return true;
  }
  // Browser: als Download speichern
  const blob = await sicher(() => api.dateiLaden(d.id));
  if (!blob) return false;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = namensvorschlag(d).split(/[\\/]/).pop()!;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return true;
}

export async function speichern(d = aktiv()): Promise<boolean> {
  if (!d) return false;
  if (!d.pfad) return speichernUnter(d);
  const antwort = await sicher(() => api.speichern(d.id));
  if (!antwort) return false;
  anwenden(antwort);
  melden(`Gespeichert: ${d.titel}`);
  return true;
}
