// Verbindung zum lokalen Dienst. Das Zugangs-Token kommt beim Start über den
// URL-Anker (#t=…) und wird danach nur im Speicher dieser Sitzung gehalten.

import type { Aenderungsantwort, Auftrag, DokumentInfo, Ereignis, OcrStatus, OrdnerRegel, UeberwachungsProtokoll, Einstellungen, OrdnerInhalt, Sitzung, Treffer, Lesezeichen, ZuletztEintrag } from "./typen";

function tokenErmitteln(): string {
  const anker = new URLSearchParams(window.location.hash.slice(1));
  const ausAnker = anker.get("t");
  if (ausAnker) {
    try {
      sessionStorage.setItem("agentur-pdf-token", ausAnker);
    } catch {
      /* privater Modus – Token bleibt nur im Speicher */
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return ausAnker;
  }
  try {
    return sessionStorage.getItem("agentur-pdf-token") ?? "";
  } catch {
    return "";
  }
}

export const token = tokenErmitteln();

export class ApiFehler extends Error {}

async function anfrage<T>(methode: string, pfad: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "X-Agentur-Token": token };
  let daten: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    daten = body;
    headers["Content-Type"] = "application/octet-stream";
  } else if (body !== undefined) {
    daten = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const antwort = await fetch(pfad, { method: methode, headers, body: daten, signal });
  if (!antwort.ok) {
    let meldung = `Fehler ${antwort.status}`;
    try {
      const j = await antwort.json();
      if (j?.fehler) meldung = j.fehler;
      else if (j?.detail) meldung = typeof j.detail === "string" ? j.detail : "Ungültige Anfrage.";
    } catch {
      /* keine JSON-Antwort */
    }
    throw new ApiFehler(meldung);
  }
  return antwort.json() as Promise<T>;
}

const enc = encodeURIComponent;

export const api = {
  status: () => anfrage<{ version: string; desktop: boolean }>("GET", "/api/status"),
  dokumente: () => anfrage<DokumentInfo[]>("GET", "/api/dokumente"),
  oeffnen: (pfad: string, passwort?: string) => anfrage<DokumentInfo>("POST", "/api/dokumente/oeffnen", { pfad, passwort }),
  hochladen: (datei: File, passwort?: string) =>
    anfrage<DokumentInfo>(
      "POST",
      `/api/dokumente/hochladen?name=${enc(datei.name)}${passwort ? `&passwort=${enc(passwort)}` : ""}`,
      datei,
    ),
  info: (id: string) => anfrage<DokumentInfo>("GET", `/api/dokumente/${id}`),
  schliessen: (id: string) => anfrage<{ ok: boolean }>("DELETE", `/api/dokumente/${id}`),
  suche: (id: string, q: string, signal?: AbortSignal) =>
    anfrage<Omit<Treffer, "dokId">[]>("GET", `/api/dokumente/${id}/suche?q=${enc(q)}`, undefined, signal),
  lesezeichen: (id: string) => anfrage<Lesezeichen[]>("GET", `/api/dokumente/${id}/lesezeichen`),
  einstellungen: () => anfrage<Einstellungen>("GET", "/api/einstellungen"),
  einstellungenSetzen: (e: Partial<Einstellungen>) => anfrage<Einstellungen>("PUT", "/api/einstellungen", e),
  zuletzt: () => anfrage<ZuletztEintrag[]>("GET", "/api/zuletzt"),
  zuletztEntfernen: (pfad: string) => anfrage("DELETE", `/api/zuletzt?pfad=${enc(pfad)}`),
  favoriten: () => anfrage<string[]>("GET", "/api/favoriten"),
  favoritenSetzen: (ordner: string[]) => anfrage<string[]>("PUT", "/api/favoriten", ordner),
  ordner: (pfad: string) => anfrage<OrdnerInhalt>("GET", `/api/ordner?pfad=${enc(pfad)}`),
  sitzung: () => anfrage<Sitzung>("GET", "/api/sitzung"),
  sitzungSetzen: (s: Sitzung) => anfrage("PUT", "/api/sitzung", s),
  dialogOeffnen: () => anfrage<{ verfuegbar: boolean; pfade: string[] }>("POST", "/api/dialog/oeffnen"),
  dialogSpeichern: (vorschlag: string) =>
    anfrage<{ verfuegbar: boolean; pfad: string | null }>("POST", "/api/dialog/speichern", { vorschlag }),

  // Seiten organisieren – alle Antworten enthalten die aktualisierten Dokumente
  drehen: (id: string, seiten: number[], grad: number) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/drehen`, { seiten, grad }),
  loeschen: (id: string, seiten: number[]) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/loeschen`, { seiten }),
  verschieben: (id: string, seiten: number[], ziel: number) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/verschieben`, { seiten, ziel }),
  duplizieren: (id: string, seiten: number[]) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/duplizieren`, { seiten }),
  leereSeite: (id: string, position: number) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/leer`, { position }),
  einfuegenPfade: (id: string, position: number, pfade: string[]) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/einfuegen_pfad`, { position, pfade }),
  einfuegenDatei: (id: string, position: number, datei: Blob, name: string) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/einfuegen_datei?position=${position}&name=${enc(name)}`, datei),
  uebertragen: (quelle: string, seiten: number[], ziel: string, position: number, verschieben: boolean) =>
    anfrage<Aenderungsantwort>("POST", "/api/seiten/uebertragen", { quelle, seiten, ziel, position, verschieben }),
  extrahieren: (id: string, seiten: number[], loeschen = false) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/extrahieren`, { seiten, loeschen }),
  teilen: (id: string, modus: string, wert: number) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/teilen`, { modus, wert }),
  leerseiten: (id: string) => anfrage<number[]>("GET", `/api/dokumente/${id}/leerseiten`),
  rueckgaengig: (id: string) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/rueckgaengig`),
  wiederholen: (id: string) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/wiederholen`),
  speichern: (id: string, pfad?: string) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/speichern`, { pfad: pfad ?? null }),
  // Zusammenführen / Umwandeln (Hintergrundaufträge)
  uploadTemp: (datei: Blob, name: string) => anfrage<{ id: string; name: string }>("POST", `/api/uploads?name=${enc(name)}`, datei),
  zusammenfuehren: (eintraege: { pfad?: string; upload?: string }[], lesezeichen: boolean, anhaenge: boolean) =>
    anfrage<Auftrag>("POST", "/api/zusammenfuehren", { eintraege, lesezeichen, anhaenge }),
  umwandeln: (eintraege: { pfad?: string; upload?: string }[], speichern: boolean) =>
    anfrage<Auftrag>("POST", "/api/umwandeln", { eintraege, speichern }),
  auftragAbbrechen: (id: string) => anfrage("DELETE", `/api/auftraege/${id}`),
  ereignisse: () => anfrage<{ ereignisse: Ereignis[]; auftraege: Auftrag[] }>("GET", "/api/ereignisse"),
  // Texterkennung
  ocrStatus: () => anfrage<OcrStatus>("GET", "/api/ocr/status"),
  ocrStarten: (id: string, o: { seiten?: number[] | null; sprachen?: string; erzwingen: boolean; ausrichten: boolean; entzerren: boolean }) =>
    anfrage<Auftrag>("POST", `/api/dokumente/${id}/ocr`, o),
  ocrBereich: (id: string, seite: number, rechteck: number[]) =>
    anfrage<{ text: string; sicherheit: number }>("POST", `/api/dokumente/${id}/ocr/bereich`, { seite, rechteck }),
  ocrUnsicher: (id: string) => anfrage<Record<string, [number, number, number, number][]>>("GET", `/api/dokumente/${id}/ocr/unsicher`),
  textstatus: (id: string) => anfrage<{ seiten: number; ohne_text: number; erste_ohne_text: number[] }>("GET", `/api/dokumente/${id}/textstatus`),
  ueberwachung: () => anfrage<{ regeln: OrdnerRegel[]; protokoll: UeberwachungsProtokoll[] }>("GET", "/api/ueberwachung"),
  ueberwachungSetzen: (regeln: OrdnerRegel[]) =>
    anfrage<{ regeln: OrdnerRegel[]; protokoll: UeberwachungsProtokoll[] }>("PUT", "/api/ueberwachung", regeln),
  dateiLaden: async (id: string): Promise<Blob> => {
    const antwort = await fetch(`/api/dokumente/${id}/datei`, { headers: { "X-Agentur-Token": token } });
    if (!antwort.ok) throw new ApiFehler("Datei konnte nicht erzeugt werden.");
    return antwort.blob();
  },
};

export interface BildParameter {
  dokId: string;
  seite: number;
  kennung: string;
  skala: number;
  drehung: number;
  kachel?: { x: number; y: number; b: number; h: number };
}

export function bildUrl(p: BildParameter): string {
  let url = `/api/dokumente/${p.dokId}/seiten/${p.seite}/bild?skala=${p.skala}&drehung=${p.drehung}&v=${p.kennung}`;
  if (p.kachel) url += `&x=${p.kachel.x}&y=${p.kachel.y}&b=${p.kachel.b}&h=${p.kachel.h}`;
  return url;
}

export async function bildLaden(url: string, signal: AbortSignal): Promise<Blob> {
  const antwort = await fetch(url, { headers: { "X-Agentur-Token": token }, signal });
  if (!antwort.ok) throw new ApiFehler(`Seite konnte nicht geladen werden (${antwort.status})`);
  return antwort.blob();
}
