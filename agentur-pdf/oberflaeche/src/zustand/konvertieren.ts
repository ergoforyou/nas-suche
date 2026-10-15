// Zusammenführen, Umwandeln, Hintergrundaufträge und Ereignisse vom Dienst
// (z. B. Explorer-Rechtsklick, während das Programm läuft).

import { api } from "../api";
import type { Auftrag, Ereignis, ZfEintrag } from "../typen";
import { dokumentAktualisieren, dokumentHinzufuegen, holen, melden, setzen } from "./store";

// Spiegel der Dateitypen aus dem Dienst (agentur_pdf/kern/konvertierung.py)
const DIREKT = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif"];
const UMWANDELN = ["heic", "heif", "webp", "txt", "csv", "log", "eml", "msg", "doc", "docx", "xls", "xlsx", "odt", "ods", "odp", "ppt", "pptx", "rtf"];
export const ALLE_ENDUNGEN = [...DIREKT, ...UMWANDELN];
export const DATEIAUSWAHL = ALLE_ENDUNGEN.map((e) => "." + e).join(",");

export const endung = (name: string) => (name.split(".").pop() ?? "").toLowerCase();
export const brauchtUmwandlung = (name: string) => UMWANDELN.includes(endung(name));
export const unterstuetzt = (name: string) => ALLE_ENDUNGEN.includes(endung(name));

const vollerPfad = (f: File) => (f as File & { pywebviewFullPath?: string }).pywebviewFullPath;
let zaehler = 0;
const schluessel = () => `e${Date.now().toString(36)}${zaehler++}`;

function fehlerText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------- Zusammenführen-Dialog
export function zusammenfuehrenOeffnen(eintraege: ZfEintrag[] = []): void {
  const d = holen().dialog;
  if (d?.art === "zusammenfuehren") {
    eintraegeAnhaengen(eintraege);
    return;
  }
  setzen({ dialog: { art: "zusammenfuehren", eintraege } });
}

function eintraegeAnhaengen(neu: ZfEintrag[]): void {
  setzen((z) => (z.dialog?.art === "zusammenfuehren" ? { dialog: { ...z.dialog, eintraege: [...z.dialog.eintraege, ...neu] } } : {}));
}

function eintragAktualisieren(schl: string, aenderung: Partial<ZfEintrag> | null): void {
  setzen((z) => {
    if (z.dialog?.art !== "zusammenfuehren") return {};
    const eintraege =
      aenderung === null
        ? z.dialog.eintraege.filter((e) => e.schluessel !== schl)
        : z.dialog.eintraege.map((e) => (e.schluessel === schl ? { ...e, ...aenderung } : e));
    return { dialog: { ...z.dialog, eintraege } };
  });
}

export function pfadeAlsEintraege(pfade: string[]): ZfEintrag[] {
  return pfade.map((p) => ({ schluessel: schluessel(), name: p.split(/[\\/]/).pop() ?? p, pfad: p }));
}

/** Dateien (Explorer-Drag, Outlook-Anhang, Dateiauswahl) zum Dialog hinzufügen.
 * Ohne echten Pfad werden sie im Hintergrund zum Dienst hochgeladen. */
export function dateienZumDialog(dateien: File[]): void {
  const passend = dateien.filter((f) => unterstuetzt(f.name));
  const abgelehnt = dateien.length - passend.length;
  if (abgelehnt) melden(`${abgelehnt} Datei(en) übersprungen – Dateityp wird nicht unterstützt.`, "fehler");
  const eintraege: ZfEintrag[] = passend.map((f) => {
    const pfad = vollerPfad(f);
    return { schluessel: schluessel(), name: f.name, pfad, laedt: !pfad };
  });
  zusammenfuehrenOeffnen(eintraege);
  passend.forEach((f, i) => {
    const e = eintraege[i];
    if (e.pfad) return;
    api
      .uploadTemp(f, f.name)
      .then((r) => eintragAktualisieren(e.schluessel, { upload: r.id, laedt: false }))
      .catch((fehler) => {
        eintragAktualisieren(e.schluessel, null);
        melden(`${f.name}: ${fehlerText(fehler)}`, "fehler");
      });
  });
}

export async function dateiauswahlFuerDialog(): Promise<void> {
  if (holen().desktop) {
    try {
      const { pfade } = await api.dialogOeffnen();
      zusammenfuehrenOeffnen(pfadeAlsEintraege(pfade.filter(unterstuetzt)));
    } catch (e) {
      melden(fehlerText(e), "fehler");
    }
    return;
  }
  const eingabe = document.createElement("input");
  eingabe.type = "file";
  eingabe.multiple = true;
  eingabe.accept = DATEIAUSWAHL;
  eingabe.onchange = () => dateienZumDialog([...(eingabe.files ?? [])]);
  eingabe.click();
}

export async function zusammenfuehrenStarten(eintraege: ZfEintrag[], lesezeichen: boolean, anhaenge: boolean): Promise<Auftrag | null> {
  try {
    const auftrag = await api.zusammenfuehren(
      eintraege.map((e) => (e.pfad ? { pfad: e.pfad } : { upload: e.upload })),
      lesezeichen,
      anhaenge,
    );
    auftragMerken(auftrag);
    return auftrag;
  } catch (e) {
    melden(fehlerText(e), "fehler");
    return null;
  }
}

// ----------------------------------------------------------------- Umwandeln
/** Öffnen von Word/Excel/Mail/… : im Hintergrund umwandeln, dann öffnen. */
export async function umwandelnUndOeffnen(dateien: File[], speichern = false): Promise<void> {
  const eintraege: { pfad?: string; upload?: string }[] = [];
  for (const f of dateien) {
    const pfad = vollerPfad(f);
    if (pfad) eintraege.push({ pfad });
    else {
      try {
        eintraege.push({ upload: (await api.uploadTemp(f, f.name)).id });
      } catch (e) {
        melden(`${f.name}: ${fehlerText(e)}`, "fehler");
      }
    }
  }
  if (eintraege.length) await umwandelnStarten(eintraege, speichern);
}

export async function umwandelnStarten(eintraege: { pfad?: string; upload?: string }[], speichern: boolean): Promise<void> {
  try {
    auftragMerken(await api.umwandeln(eintraege, speichern));
  } catch (e) {
    melden(fehlerText(e), "fehler");
  }
}

export async function umwandelnDialog(): Promise<void> {
  if (holen().desktop) {
    const { pfade } = await api.dialogOeffnen().catch(() => ({ pfade: [] as string[] }));
    const passend = pfade.filter(unterstuetzt);
    // Im Desktop-Modus landet die PDF direkt neben der Quelldatei
    if (passend.length) await umwandelnStarten(passend.map((pfad) => ({ pfad })), true);
    return;
  }
  const eingabe = document.createElement("input");
  eingabe.type = "file";
  eingabe.multiple = true;
  eingabe.accept = DATEIAUSWAHL;
  eingabe.onchange = () => void umwandelnUndOeffnen([...(eingabe.files ?? [])]);
  eingabe.click();
}

// ------------------------------------------------------- Aufträge & Ereignisse
export function auftragMerken(auftrag: Auftrag): void {
  setzen((z) => ({ auftraege: [...z.auftraege.filter((a) => a.id !== auftrag.id), auftrag] }));
  schleifeBeschleunigen();
}

export function auftragAbbrechen(id: string): void {
  api.auftragAbbrechen(id).catch(() => undefined);
}

export function auftragAusblenden(id: string): void {
  setzen((z) => ({ auftraege: z.auftraege.filter((a) => a.id !== id) }));
}

async function dokumenteOeffnen(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      dokumentHinzufuegen(await api.info(id));
    } catch (e) {
      // inzwischen geschlossen (z. B. Fenster neu geladen) – kein Fehler für den Benutzer
      if (!fehlerText(e).includes("nicht (mehr) geöffnet")) melden(fehlerText(e), "fehler");
    }
  }
}

async function ereignisVerarbeiten(e: Ereignis): Promise<void> {
  switch (e.art) {
    case "auftrag": {
      const a = e.auftrag;
      setzen((z) => ({ auftraege: z.auftraege.map((x) => (x.id === a.id ? a : x)) }));
      if (a.status === "fertig") {
        if (a.ergebnis.oeffnen && a.ergebnis.dokumente) await dokumenteOeffnen(a.ergebnis.dokumente);
        if (a.ergebnis.aktualisieren && a.ergebnis.dokumente) {
          const { nachOcr } = await import("./ocr");
          for (const id of a.ergebnis.dokumente) await nachOcr(id);
        }
        const dateien = a.ergebnis.dateien ?? [];
        const o = a.ergebnis.ocr;
        if (a.ergebnis.stapel) {
          const fehler = a.ergebnis.fehler ?? [];
          const mb = (b: number) => `${(b / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
          melden(
            `Stapel fertig: ${dateien.length} von ${a.ergebnis.anzahl} Datei(en) gespeichert` +
              (a.ergebnis.groesse_vorher ? ` (${mb(a.ergebnis.groesse_vorher)} → ${mb(a.ergebnis.groesse ?? 0)})` : "") +
              (fehler.length ? ` – ${fehler.length} übersprungen: ${fehler.slice(0, 3).map((f) => `${f.datei.split(/[\\/]/).pop()} (${f.fehler})`).join("; ")}` : ""),
            fehler.length ? "fehler" : "info",
          );
        } else if (o) {
          melden(
            o.erkannt
              ? `Texterkennung fertig: ${o.erkannt} Seite(n), ${Math.round(o.sicherheit)} % sicher` +
                  (o.unsicher ? `, ${o.unsicher} unsichere(s) Wort/Wörter` : "") +
                  (o.gedreht ? `, ${o.gedreht} Seite(n) gedreht` : "") +
                  (o.uebersprungen ? ` – ${o.uebersprungen} Seite(n) hatten schon Text` : "")
              : "Alle Seiten enthalten bereits Text – nichts zu erkennen. (Option „Vorhandenen Text ersetzen“ erzwingt eine neue Erkennung.)",
          );
        } else {
          melden(dateien.length ? `Gespeichert: ${dateien.map((d) => d.split(/[\\/]/).pop()).join(", ")}` : `Fertig: ${a.titel}`);
        }
        // erfolgreiche Aufträge nach kurzer Zeit ausblenden
        setTimeout(() => auftragAusblenden(a.id), 2500);
      } else if (a.status === "fehler") {
        melden(a.fehler, "fehler");
      } else if (a.status === "abgebrochen") {
        setTimeout(() => auftragAusblenden(a.id), 1500);
      }
      break;
    }
    case "zusammenfuehren":
      zusammenfuehrenOeffnen(pfadeAlsEintraege(e.dateien));
      break;
    case "oeffnen":
      await dokumenteOeffnen(e.dokumente);
      break;
    case "meldung":
      melden(e.text, "fehler");
      break;
    case "info":
      melden(e.text);
      break;
    case "screenshot":
      setzen({ screenshot: { png: e.png, pdf: e.pdf, text: e.text, nonce: Date.now() } });
      break;
    case "sperre_frei":
      try {
        dokumentAktualisieren(await api.info(e.dokId));
        melden(`„${e.titel}“ ist jetzt frei – Sie können wieder normal speichern.`);
      } catch {
        /* Dokument inzwischen geschlossen */
      }
      break;
  }
}

let timer: number | undefined;
let laeuft = false;

async function abfragen(): Promise<void> {
  if (laeuft) return;
  laeuft = true;
  try {
    const { ereignisse, auftraege } = await api.ereignisse();
    if (auftraege.length) {
      // Fortschritt laufender Aufträge übernehmen (nur bekannte – keine fremden einblenden)
      setzen((z) => ({
        auftraege: z.auftraege.map((a) => auftraege.find((n) => n.id === a.id && (a.status === "laeuft" || a.status === "wartet")) ?? a),
      }));
    }
    for (const e of ereignisse) {
      if (e.art === "auftrag" && !holen().auftraege.some((a) => a.id === e.auftrag.id)) {
        // Auftrag von außen gestartet (Explorer „In PDF umwandeln“) → trotzdem anzeigen
        setzen((z) => ({ auftraege: [...z.auftraege, e.auftrag] }));
      }
      await ereignisVerarbeiten(e);
    }
    // Auftrag von außen, der noch läuft → anzeigen
    for (const a of auftraege) {
      if ((a.status === "laeuft" || a.status === "wartet") && !holen().auftraege.some((x) => x.id === a.id)) {
        setzen((z) => ({ auftraege: [...z.auftraege, a] }));
      }
    }
  } catch {
    /* Dienst kurz nicht erreichbar – beim nächsten Mal erneut */
  } finally {
    laeuft = false;
  }
}

function planen(): void {
  window.clearTimeout(timer);
  const aktiv = holen().auftraege.some((a) => a.status === "laeuft" || a.status === "wartet");
  timer = window.setTimeout(async () => {
    await abfragen();
    planen();
  }, aktiv ? 250 : 1000);
}

function schleifeBeschleunigen(): void {
  planen();
}

export function ereignisschleifeStarten(): void {
  void abfragen().then(planen);
}
