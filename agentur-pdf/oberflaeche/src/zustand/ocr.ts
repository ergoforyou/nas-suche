// Texterkennung: Dialog, Hinweis bei Scans ohne Text, Bereichs-OCR,
// unsichere Wörter, Überwachungsordner.

import { api } from "../api";
import { auftragMerken } from "./konvertieren";
import { abonnieren, aktivesDokument, dokumentAktualisieren, holen, melden, setzen } from "./store";

function fehlerText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ocrDialog(dokId = holen().aktiv): void {
  if (!dokId) {
    melden("Kein Dokument geöffnet.");
    return;
  }
  setzen({ dialog: { art: "ocr", dokId } });
}

export async function ocrStarten(
  dokId: string,
  optionen: { seiten?: number[] | null; sprachen?: string; erzwingen: boolean; ausrichten: boolean; entzerren: boolean },
): Promise<boolean> {
  try {
    auftragMerken(await api.ocrStarten(dokId, optionen));
    setzen((z) => ({ hinweisWeg: { ...z.hinweisWeg, [dokId]: true } }));
    return true;
  } catch (e) {
    melden(fehlerText(e), "fehler");
    return false;
  }
}

/** Nach Abschluss einer Texterkennung: Dokument neu laden, Hinweise aktualisieren. */
export async function nachOcr(dokId: string): Promise<void> {
  try {
    dokumentAktualisieren(await api.info(dokId));
  } catch {
    return; // inzwischen geschlossen
  }
  void textstatusPruefen(dokId);
  if (holen().unsicher[dokId]) await unsicherLaden(dokId);
}

export async function textstatusPruefen(dokId: string): Promise<void> {
  try {
    const status = await api.textstatus(dokId);
    setzen((z) => ({ textlos: { ...z.textlos, [dokId]: status.ohne_text } }));
  } catch {
    /* Dokument schon wieder zu */
  }
}

/** Neu geöffnete Dokumente auf fehlenden Text prüfen (einmal je Dokument). */
export function textstatusBeobachten(): () => void {
  const geprueft = new Set<string>();
  return abonnieren(() => {
    for (const d of holen().dokumente) {
      if (geprueft.has(d.id)) continue;
      geprueft.add(d.id);
      void textstatusPruefen(d.id);
    }
  });
}

export function hinweisAusblenden(dokId: string): void {
  setzen((z) => ({ hinweisWeg: { ...z.hinweisWeg, [dokId]: true } }));
}

// --------------------------------------------------------- Bereichs-OCR
export async function bereichstextErkennen(dokId: string, seite: number, rechteck: [number, number, number, number]): Promise<void> {
  melden("Erkenne Text im Bereich …");
  try {
    const { text, sicherheit } = await api.ocrBereich(dokId, seite, rechteck);
    if (!text.trim()) {
      melden("In diesem Bereich wurde kein Text erkannt.");
      return;
    }
    let kopiert = false;
    try {
      await navigator.clipboard.writeText(text);
      kopiert = true;
    } catch {
      /* Zwischenablage gesperrt – Text steht im Dialog zum Kopieren bereit */
    }
    setzen({ dialog: { art: "bereichstext", text, sicherheit } });
    if (kopiert) melden("Text in die Zwischenablage kopiert.");
  } catch (e) {
    melden(fehlerText(e), "fehler");
  }
}

// ------------------------------------------------------ unsichere Wörter
async function unsicherLaden(dokId: string): Promise<void> {
  try {
    const daten = await api.ocrUnsicher(dokId);
    setzen((z) => ({ unsicher: { ...z.unsicher, [dokId]: daten } }));
    const anzahl = Object.values(daten).reduce((s, l) => s + l.length, 0);
    if (!anzahl) melden("Keine unsicheren Wörter – oder für dieses Dokument wurde noch keine Texterkennung durchgeführt.");
  } catch (e) {
    melden(fehlerText(e), "fehler");
  }
}

export async function unsicherUmschalten(): Promise<void> {
  const d = aktivesDokument();
  if (!d) return;
  if (holen().unsicher[d.id]) {
    setzen((z) => {
      const neu = { ...z.unsicher };
      delete neu[d.id];
      return { unsicher: neu };
    });
    return;
  }
  await unsicherLaden(d.id);
}
