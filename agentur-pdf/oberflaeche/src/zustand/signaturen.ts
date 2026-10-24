// Meldet in Ergoforyou PDF, wenn jemand online unterschrieben hat – ohne dass
// jemand in die Übersicht schauen muss. Fragt Ergoforyou Sign auf dem NAS alle
// 90 Sekunden ab; der letzte Stand liegt im Browser-Speicher dieses PCs.

import { api, CHROME_MODUS } from "../api";
import type { SignaturAuftrag } from "../typen";
import { holen, melden } from "./store";

const SCHLUESSEL = "agentur-pdf-signaturen";
const ABSTAND_MS = 90_000;

type Stand = Record<string, { status: string; fertig: number }>;

function lesen(): Stand | null {
  try {
    return JSON.parse(localStorage.getItem(SCHLUESSEL) ?? "null") as Stand | null;
  } catch {
    return null;
  }
}

function schreiben(stand: Stand): void {
  try {
    localStorage.setItem(SCHLUESSEL, JSON.stringify(stand));
  } catch {
    /* privat – dann eben ohne Gedächtnis */
  }
}

/** Neuigkeiten zwischen altem und neuem Stand als Meldungstexte. */
export function neuigkeiten(alt: Stand, liste: SignaturAuftrag[]): string[] {
  const texte: string[] = [];
  for (const a of liste) {
    const vorher = alt[a.id];
    if (!vorher) continue;
    const fertig = a.personen.filter((p) => p.status === "unterschrieben");
    if (a.status === "unterschrieben" && vorher.status !== "unterschrieben") {
      texte.push(`✔ „${a.titel}“ ist vollständig unterschrieben.`);
    } else if (fertig.length > vorher.fertig) {
      const neu = fertig[fertig.length - 1];
      texte.push(`${neu.unterschrieben_als || neu.name || neu.rolle} hat „${a.titel}“ unterschrieben (${fertig.length} von ${a.personen.length}).`);
    }
  }
  return texte;
}

async function pruefen(): Promise<void> {
  if (!holen().einstellungen?.signatur_verbindung?.url) return;
  let liste: SignaturAuftrag[];
  try {
    liste = (await api.signaturAuftraege()).auftraege;
  } catch {
    return; // NAS gerade nicht erreichbar – beim nächsten Mal
  }
  const alt = lesen();
  const neu: Stand = Object.fromEntries(liste.map((a) => [a.id, { status: a.status, fertig: a.personen.filter((p) => p.status === "unterschrieben").length }]));
  if (alt) for (const text of neuigkeiten(alt, liste)) melden(text);
  schreiben(neu);
}

/** Startet die Beobachtung; liefert eine Aufräumfunktion. */
export function signaturenBeobachten(): () => void {
  if (CHROME_MODUS.aktiv) return () => undefined;
  const erst = window.setTimeout(() => void pruefen(), 8000);
  const timer = window.setInterval(() => void pruefen(), ABSTAND_MS);
  return () => {
    window.clearTimeout(erst);
    window.clearInterval(timer);
  };
}
