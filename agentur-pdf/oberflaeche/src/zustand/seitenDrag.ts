// Gemeinsamer Zustand für das Ziehen von Seiten zwischen Miniaturleisten,
// Dokument-Tabs und der Dokumentansicht.

export const DND_TYP = "application/x-agentur-pdf-seiten";

export interface SeitenDrag {
  dokId: string;
  seiten: number[];
}

/** Während dragover ist dataTransfer nicht lesbar – deshalb hier gemerkt. */
let laufend: SeitenDrag | null = null;

export function seitenDragStarten(d: SeitenDrag, e: React.DragEvent): void {
  laufend = d;
  e.dataTransfer.setData(DND_TYP, JSON.stringify(d));
  e.dataTransfer.effectAllowed = "copyMove";
}

export function laufenderSeitenDrag(): SeitenDrag | null {
  return laufend;
}

export function istSeitenDrag(e: React.DragEvent): boolean {
  return [...e.dataTransfer.types].includes(DND_TYP);
}

/** Daten beim Ablegen (aus dataTransfer, sonst gemerkt) – beendet den Drag. */
export function seitenDragDaten(e: React.DragEvent): SeitenDrag | null {
  let d: SeitenDrag | null = laufend;
  try {
    const roh = e.dataTransfer.getData(DND_TYP);
    if (roh) d = JSON.parse(roh) as SeitenDrag;
  } catch {
    /* gemerkte Daten nehmen */
  }
  laufend = null;
  return d;
}

/** dragleave kommt auch beim Wechsel auf ein Kindelement (relatedTarget ist
 * dabei nicht zuverlässig gesetzt) – also nachsehen, was unter dem Zeiger liegt. */
export function zeigerInnerhalb(e: React.DragEvent): boolean {
  const unter = document.elementFromPoint(e.clientX, e.clientY);
  return !!unter && e.currentTarget.contains(unter);
}

// Die Quell-Miniatur kann während des Ziehens verschwinden (Tab-Wechsel) –
// dann kommt kein dragend an ihr an. Daher global aufräumen.
if (typeof window !== "undefined") {
  const aufraeumen = () => window.setTimeout(() => (laufend = null), 0);
  window.addEventListener("dragend", aufraeumen, true);
  window.addEventListener("drop", aufraeumen, true);
}
