// Verbindung zum lokalen Dienst. Das Zugangs-Token kommt beim Start über den
// URL-Anker (#t=…) und wird danach nur im Speicher dieser Sitzung gehalten.

import type { Anmerkung, BildDaten, Ebene, Formularfeld, RsFehler, Unterschrift, Wiederherstellung, Wort, GemeinsamStatus, UpdateInfo, WindowsStatus, StapelOptionen, VergleichErgebnis, Textzeile } from "./typen";
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
  speichern: (id: string, pfad?: string, erzwingen = false) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/speichern`, { pfad: pfad ?? null, erzwingen }),
  stapelVorschau: (pfade: string[], unterordner: boolean) =>
    anfrage<{ anzahl: number; dateien: { pfad: string; name: string; ordner: string; groesse: number }[] }>("POST", "/api/stapel/vorschau", { pfade, unterordner }),
  stapelStarten: (pfade: string[], unterordner: boolean, optionen: StapelOptionen) =>
    anfrage<Auftrag>("POST", "/api/stapel", { pfade, unterordner, optionen }),
  chromeStatus: () => anfrage<ChromeStatus>("GET", "/api/system/chrome"),
  chromeEinrichten: () => anfrage<ChromeStatus>("POST", "/api/system/chrome"),
  druckerStatus: () => anfrage<{ windows: boolean; eingerichtet: boolean; ordner: string; name: string }>("GET", "/api/system/drucker"),
  druckerEinrichten: (einrichten: boolean) =>
    anfrage<{ windows: boolean; eingerichtet: boolean; ordner: string; name: string }>("POST", "/api/system/drucker", { einrichten }),
  textzeilen: (id: string, seite: number) => anfrage<Textzeile[]>("GET", `/api/dokumente/${id}/seiten/${seite}/textzeilen`),
  textErsetzen: (id: string, seite: number, bbox: number[], neu: string, groesse?: number, farbe?: string) =>
    anfrage<Aenderungsantwort & { zeile: Partial<Textzeile> }>("POST", `/api/dokumente/${id}/seiten/${seite}/text_ersetzen`, { bbox, neu, groesse, farbe }),
  freistellen: (id: string, seite: number, rechteck: number[], modus: string, staerke: number) =>
    anfrage<{ bild_id: string; bild: string; rechteck: [number, number, number, number] }>("POST", `/api/dokumente/${id}/freistellen`, { seite, rechteck, modus, staerke }),
  freistellenEinsetzen: (id: string, seite: number, bild_id: string, rechteck: number[], abdecken: number[] | null) =>
    anfrage<Aenderungsantwort & { id: number }>("POST", `/api/dokumente/${id}/freistellen/einsetzen`, { seite, bild_id, rechteck, abdecken }),
  anmerkungEbene: (id: string, xref: number, seite: number, richtung: string) =>
    anfrage<Aenderungsantwort & { id: number }>("POST", `/api/dokumente/${id}/anmerkungen/${xref}/ebene`, { seite, richtung }),
  anmerkungUmformen: (id: string, xref: number, seite: number, aktion: string) =>
    anfrage<Aenderungsantwort & { id: number }>("POST", `/api/dokumente/${id}/anmerkungen/${xref}/umformen`, { seite, aktion }),
  briefpapierListe: () => anfrage<{ name: string; groesse: number }[]>("GET", "/api/briefpapier"),
  briefpapierHochladen: (datei: Blob, name: string) => anfrage<{ name: string; seiten: number }>("POST", `/api/briefpapier?name=${encodeURIComponent(name)}`, datei),
  briefpapierLoeschen: (name: string) => anfrage("DELETE", `/api/briefpapier/${encodeURIComponent(name)}`),
  briefpapierVorschau: (name: string) => mitToken(`/api/briefpapier/${encodeURIComponent(name)}/vorschau`),
  briefpapierAnwenden: (id: string, name: string, seiten: number[] | null) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/briefpapier`, { name, seiten }),
  deckblatt: (id: string, daten: Record<string, unknown>) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/deckblatt`, daten),
  inhaltsverzeichnis: (id: string, position: number, titel: string, farbe: string) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/inhaltsverzeichnis`, { position, titel, farbe }),
  vergleichen: (a: string, b: string) => anfrage<VergleichErgebnis>("POST", "/api/vergleich", { a, b }),
  ordnerDialog: (start = "") => anfrage<{ verfuegbar: boolean; pfad: string | null }>("POST", "/api/dialog/ordner", { start }),
  updatePruefen: () => anfrage<UpdateInfo>("GET", "/api/update"),
  updateInstallieren: () => anfrage<{ ok: boolean; version: string }>("POST", "/api/update/installieren"),
  windowsStatus: () => anfrage<WindowsStatus>("GET", "/api/system/windows"),
  standardprogramm: () => anfrage("POST", "/api/system/standardprogramm"),
  gemeinsamStatus: () => anfrage<GemeinsamStatus>("GET", "/api/gemeinsam"),
  wiederherstellungListe: () => anfrage<Wiederherstellung[]>("GET", "/api/wiederherstellung"),
  wiederherstellen: (schluessel: string) => anfrage<DokumentInfo>("POST", `/api/wiederherstellung/${encodeURIComponent(schluessel)}`),
  wiederherstellungVerwerfen: (schluessel: string) => anfrage("DELETE", `/api/wiederherstellung/${encodeURIComponent(schluessel)}`),
  sperrePruefen: (id: string) => anfrage<DokumentInfo>("POST", `/api/dokumente/${id}/sperre_pruefen`),
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
  system: () =>
    anfrage<{
      version: string;
      windows: boolean;
      datenordner: string;
      tesseract: string | null;
      beste_modelle: boolean;
      libreoffice: string | null;
      woerterbuch: boolean;
    }>("GET", "/api/system"),
  explorerMenue: (einrichten: boolean) => anfrage<{ ok: boolean; anzahl: number }>("POST", "/api/system/explorer", { einrichten }),
  // Kommentieren & Bearbeiten
  anmerkungen: (id: string) => anfrage<Record<string, Anmerkung[]>>("GET", `/api/dokumente/${id}/anmerkungen`),
  anmerkungNeu: (id: string, daten: Record<string, unknown>) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/anmerkungen`, daten),
  anmerkungAendern: (id: string, anmId: number, daten: Record<string, unknown>) =>
    anfrage<Aenderungsantwort>("PATCH", `/api/dokumente/${id}/anmerkungen/${anmId}`, daten),
  anmerkungenLoeschen: (id: string, eintraege: { seite: number; id: number }[]) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/anmerkungen/loeschen`, { eintraege }),
  woerter: (id: string, seite: number) => anfrage<Wort[]>("GET", `/api/dokumente/${id}/seiten/${seite}/woerter`),
  rechtschreibung: (text: string, signal?: AbortSignal) => anfrage<RsFehler[]>("POST", "/api/rechtschreibung", { text }, signal),
  vorschlaege: (wort: string) => anfrage<string[]>("POST", "/api/rechtschreibung/vorschlaege", { wort }),
  woerterbuchHinzufuegen: (wort: string) => anfrage("POST", "/api/woerterbuch", { wort }),
  // Bilder, Unterschriften, Fotos
  bildHochladen: (datei: Blob, freistellen: boolean, staerke = 50) =>
    anfrage<BildDaten>("POST", `/api/bilder?freistellen=${freistellen}&staerke=${staerke}`, datei),
  bildFreistellen: (id: string, staerke: number) => anfrage<BildDaten>("POST", `/api/bilder/${id}/freistellen`, { staerke }),
  unterschriften: () => anfrage<Unterschrift[]>("GET", "/api/unterschriften"),
  unterschriftSpeichern: (bild_id: string, name: string) => anfrage<{ id: string }>("POST", "/api/unterschriften", { bild_id, name }),
  unterschriftEntfernen: (id: string) => anfrage("DELETE", `/api/unterschriften/${id}`),
  fotoEcken: (bild_id: string) => anfrage<{ ecken: [number, number][]; gefunden: boolean; inhalt: [number, number, number, number] | null }>("POST", "/api/foto/ecken", { bild_id }),
  fotoEntzerren: (bild_id: string, ecken: [number, number][] | null, filter: string, drehung: number, helligkeit = 0, kontrast = 0) =>
    anfrage<BildDaten & { format: string }>("POST", "/api/foto/entzerren", { bild_id, ecken, filter, drehung, helligkeit, kontrast }),
  bildAusDatei: (pfad: string) => anfrage<BildDaten>("POST", "/api/bilder/aus_datei", { pfad }),
  seiteAlsBild: (id: string, seite: number) => anfrage<BildDaten>("POST", `/api/dokumente/${id}/seiten/${seite}/als_bild`),
  bildEinsetzen: (id: string, bild_id: string, position: number, ersetzen: boolean) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/seiten/bild_einsetzen`, { bild_id, position, ersetzen }),
  bildAlsDokument: (bild_id: string, name: string) => anfrage<Aenderungsantwort>("POST", `/api/bilder/${bild_id}/als_dokument`, { name }),
  // Schützen & Ausgabe
  schwaerzenSuchen: (id: string, muster: string, begriff = "") =>
    anfrage<{ seite: number; text: string; rechteck: [number, number, number, number] }[]>("POST", `/api/dokumente/${id}/schwaerzen/suchen`, { muster, begriff }),
  schwaerzenVormerken: (id: string, eintraege: { seite: number; rechteck: number[] }[]) =>
    anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/schwaerzen/vormerken`, { eintraege }),
  schwaerzenAnwenden: (id: string, metadaten: boolean) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/schwaerzen/anwenden`, { metadaten }),
  schutz: (id: string) =>
    anfrage<{ verschluesselt: boolean; kennwort_oeffnen: boolean; rechte_kennwort: boolean; rechte: Record<string, boolean>; ausstehend: boolean }>(
      "GET",
      `/api/dokumente/${id}/schutz`,
    ),
  schutzSetzen: (id: string, daten: Record<string, unknown>) => anfrage<Aenderungsantwort>("PUT", `/api/dokumente/${id}/schutz`, daten),
  eigenschaften: (id: string) => anfrage<Record<string, string | number | null>>("GET", `/api/dokumente/${id}/eigenschaften`),
  eigenschaftenSetzen: (id: string, werte: Record<string, string>) => anfrage<Aenderungsantwort>("PUT", `/api/dokumente/${id}/eigenschaften`, werte),
  metadatenEntfernen: (id: string) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/metadaten_entfernen`),
  komprimieren: (id: string, stufe: string) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/komprimieren`, { stufe }),
  ebenen: (id: string) => anfrage<Ebene[]>("GET", `/api/dokumente/${id}/ebenen`),
  ebeneSchalten: (id: string, ebene: number, an: boolean) => anfrage<Aenderungsantwort>("PUT", `/api/dokumente/${id}/ebenen/${ebene}`, { an }),
  ausgabe: (id: string, o: { seiten?: number[] | null; gruppen_weg: string[]; ebenen_aus: number[]; ebenen_entfernen?: boolean; pfad?: string | null }) =>
    anfrage<{ url?: string; pfad?: string; groesse: number }>("POST", `/api/dokumente/${id}/ausgabe`, o),
  bilderExport: (id: string, seiten: number[], dpi: number, format: string, pfad?: string | null) =>
    anfrage<{ url?: string; name?: string; pfad?: string }>("POST", `/api/dokumente/${id}/bilder_export`, { seiten, dpi, format, pfad }),
  screenshotStatus: () => anfrage<{ verfuegbar: boolean; aktiv: boolean; taste: string; fehler: string | null; ordner: string }>("GET", "/api/screenshot/status"),
  screenshotAufnehmen: () => anfrage<{ png?: string; abgebrochen?: boolean }>("POST", "/api/screenshot/aufnehmen"),
  screenshotAusBild: (bild: Blob) => anfrage<{ png: string; pdf: string | null; text: string }>("POST", "/api/screenshot/verarbeiten", bild),
  ordnerZeigen: (pfad: string) => anfrage("POST", "/api/system/ordner_zeigen", { pfad }),
  textSpeichern: (id: string, pfad: string) => anfrage<{ pfad: string }>("POST", `/api/dokumente/${id}/text`, { pfad }),
  wasserzeichen: (id: string, daten: Record<string, unknown>) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/wasserzeichen`, daten),
  kopfFuss: (id: string, daten: Record<string, unknown>) => anfrage<Aenderungsantwort>("POST", `/api/dokumente/${id}/kopf_fuss`, daten),
  formular: (id: string) => anfrage<Record<string, Formularfeld[]>>("GET", `/api/dokumente/${id}/formular`),
  formularfeldNeu: (id: string, daten: Record<string, unknown>) => anfrage<Aenderungsantwort & { id: number }>("POST", `/api/dokumente/${id}/formular`, daten),
  formularfeldAendern: (id: string, xref: number, daten: Record<string, unknown>) =>
    anfrage<Aenderungsantwort>("PATCH", `/api/dokumente/${id}/formular/${xref}`, daten),
  formularfeldLoeschen: (id: string, xref: number, seite: number) => anfrage<Aenderungsantwort>("DELETE", `/api/dokumente/${id}/formular/${xref}?seite=${seite}`),
  formularSetzen: (id: string, feld: number, seite: number, wert: string | boolean) =>
    anfrage<Aenderungsantwort>("PUT", `/api/dokumente/${id}/formular/${feld}`, { seite, wert }),
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
  /** ausgeblendete Anmerkungsgruppen (kommagetrennt) */
  ausblenden?: string;
  /** gerade bearbeitete Anmerkungen ausblenden (IDs, kommagetrennt) */
  ohne?: string;
}

export interface ChromeStatus {
  windows: boolean;
  ordner: string;
  vorhanden: boolean;
  chrome: string | null;
}

export function bildUrl(p: BildParameter): string {
  let url = `/api/dokumente/${p.dokId}/seiten/${p.seite}/bild?skala=${p.skala}&drehung=${p.drehung}&v=${p.kennung}`;
  if (p.kachel) url += `&x=${p.kachel.x}&y=${p.kachel.y}&b=${p.kachel.b}&h=${p.kachel.h}`;
  if (p.ausblenden) url += `&a=${p.ausblenden}`;
  if (p.ohne) url += `&o=${p.ohne}`;
  return url;
}

/** Datei mit Token herunterladen (Browser-Modus) */
export async function herunterladen(url: string, name: string): Promise<void> {
  const antwort = await fetch(url, { headers: { "X-Agentur-Token": token } });
  if (!antwort.ok) throw new ApiFehler("Datei konnte nicht geladen werden.");
  const blob = await antwort.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/** URL mit Token für iframes (Druckvorschau) */
export function mitToken(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}

export async function bildLaden(url: string, signal: AbortSignal): Promise<Blob> {
  const antwort = await fetch(url, { headers: { "X-Agentur-Token": token }, signal });
  if (!antwort.ok) throw new ApiFehler(`Seite konnte nicht geladen werden (${antwort.status})`);
  return antwort.blob();
}
