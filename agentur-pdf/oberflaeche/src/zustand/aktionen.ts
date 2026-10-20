// Aktionen mit Dienst-Anbindung (Öffnen, Schließen, Suchen, Sitzung).

import { api, ApiFehler, CHROME_MODUS } from "../api";
import { PRODUKT } from "../marke";
import type { Ansicht, DokumentInfo, Sitzung, UpdateInfo } from "../typen";
import { brauchtUmwandlung, DATEIAUSWAHL, ereignisschleifeStarten, umwandelnStarten, umwandelnUndOeffnen } from "./konvertieren";
import { abonnieren, aktivesDokument, dokumentEntfernen, dokumentHinzufuegen, fragen, holen, melden, setzen, springen } from "./store";

function fehlerText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Führt eine Öffnen-Anfrage aus und fragt bei Bedarf nach dem Passwort. */
async function mitPasswort(titel: string, versuch: (pw?: string) => Promise<DokumentInfo>, ansicht?: Partial<Ansicht>): Promise<void> {
  try {
    dokumentHinzufuegen(await versuch(), ansicht);
  } catch (e) {
    if (e instanceof ApiFehler && e.message === "PASSWORT_ERFORDERLICH") {
      setzen({
        passwortAnfrage: {
          titel,
          wiederholen: (pw) => {
            setzen({ passwortAnfrage: null });
            versuch(pw)
              .then((info) => dokumentHinzufuegen(info, ansicht))
              .catch((f) => melden(f instanceof ApiFehler && f.message === "PASSWORT_ERFORDERLICH" ? "Falsches Passwort." : fehlerText(f), "fehler"));
          },
        },
      });
    } else {
      melden(`${titel}: ${fehlerText(e)}`, "fehler");
    }
  }
}

export async function pfadOeffnen(pfad: string, ansicht?: Partial<Ansicht>): Promise<void> {
  const name = pfad.split(/[\\/]/).pop() ?? pfad;
  if (brauchtUmwandlung(name)) {
    await umwandelnStarten([{ pfad }], false);
    return;
  }
  await mitPasswort(name, (pw) => api.oeffnen(pfad, pw), ansicht);
}

export async function dateienOeffnen(dateien: File[]): Promise<void> {
  // Word, Excel, Mails … werden im Hintergrund umgewandelt
  const umzuwandeln = dateien.filter((d) => brauchtUmwandlung(d.name));
  if (umzuwandeln.length) void umwandelnUndOeffnen(umzuwandeln);
  for (const datei of dateien.filter((d) => !brauchtUmwandlung(d.name))) {
    // pywebview (Windows-App) liefert beim Ablegen den echten Pfad mit.
    const vollerPfad = (datei as File & { pywebviewFullPath?: string }).pywebviewFullPath;
    if (vollerPfad) await pfadOeffnen(vollerPfad);
    else await mitPasswort(datei.name, (pw) => api.hochladen(datei, pw));
  }
}

let dateiAuswahl: HTMLInputElement | null = null;

export async function oeffnenDialog(): Promise<void> {
  if (holen().desktop) {
    try {
      const { pfade } = await api.dialogOeffnen();
      for (const p of pfade) await pfadOeffnen(p);
      return;
    } catch (e) {
      melden(fehlerText(e), "fehler");
      return;
    }
  }
  // Browser: klassische Dateiauswahl, Datei wird zum Dienst hochgeladen.
  if (!dateiAuswahl) {
    dateiAuswahl = document.createElement("input");
    dateiAuswahl.type = "file";
    dateiAuswahl.multiple = true;
    dateiAuswahl.accept = DATEIAUSWAHL;
    dateiAuswahl.onchange = () => {
      const liste = [...(dateiAuswahl?.files ?? [])];
      if (dateiAuswahl) dateiAuswahl.value = "";
      void dateienOeffnen(liste);
    };
  }
  dateiAuswahl.click();
}

export async function dokumentSchliessen(id?: string, ohneNachfrage = false): Promise<void> {
  const ziel = id ?? holen().aktiv;
  if (!ziel) return;
  const dok = holen().dokumente.find((d) => d.id === ziel);
  if (dok?.geaendert && !ohneNachfrage) {
    setzen({ aktiv: ziel, dialog: { art: "ungespeichert", dokId: ziel, weiter: () => void dokumentSchliessen(ziel, true) } });
    return;
  }
  dokumentEntfernen(ziel);
  try {
    await api.schliessen(ziel);
  } catch {
    /* bereits geschlossen */
  }
}

// ------------------------------------------------------------------ Suche
let sucheAbbruch: AbortController | null = null;

export async function suchen(begriff: string, alleDokumente = holen().suche.alleDokumente): Promise<void> {
  sucheAbbruch?.abort();
  const z = holen();
  begriff = begriff.trim();
  if (!begriff) {
    setzen({ suche: { ...z.suche, begriff, treffer: [], aktiv: -1, laeuft: false } });
    return;
  }
  const ziele = alleDokumente ? z.dokumente : z.dokumente.filter((d) => d.id === z.aktiv);
  const abbruch = new AbortController();
  sucheAbbruch = abbruch;
  setzen({ suche: { begriff, alleDokumente, treffer: [], aktiv: -1, laeuft: true } });
  try {
    const ergebnisse = await Promise.all(
      ziele.map(async (d) => (await api.suche(d.id, begriff, abbruch.signal)).map((t) => ({ ...t, dokId: d.id }))),
    );
    const treffer = ergebnisse.flat();
    setzen({ suche: { begriff, alleDokumente, treffer, aktiv: treffer.length ? 0 : -1, laeuft: false } });
    if (treffer.length) springen(treffer[0].dokId, treffer[0].seite, treffer[0].rechteck);
    else melden(`„${begriff}“ wurde nicht gefunden.`);
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      setzen((zz) => ({ suche: { ...zz.suche, laeuft: false } }));
      melden(fehlerText(e), "fehler");
    }
  }
}

export function naechsterTreffer(richtung: 1 | -1 = 1): void {
  const { suche } = holen();
  if (!suche.treffer.length) return;
  const aktiv = (suche.aktiv + richtung + suche.treffer.length) % suche.treffer.length;
  setzen({ suche: { ...suche, aktiv } });
  const t = suche.treffer[aktiv];
  springen(t.dokId, t.seite, t.rechteck);
}

// ---------------------------------------------------------------- Sitzung
let sitzungTimer: number | undefined;

export function sitzungMerken(): void {
  if (CHROME_MODUS.aktiv) return; // Chrome-Tab hat keine eigene Sitzung
  window.clearTimeout(sitzungTimer);
  sitzungTimer = window.setTimeout(() => {
    const z = holen();
    const mitPfad = z.dokumente.filter((d) => d.pfad);
    const sitzung: Sitzung = {
      dokumente: mitPfad.map((d) => ({
        pfad: d.pfad!,
        seite: d.ansicht.seite,
        zoom: d.ansicht.zoom,
        zoomModus: d.ansicht.zoomModus,
        modus: d.ansicht.modus,
      })),
      aktiv: Math.max(0, mitPfad.findIndex((d) => d.id === z.aktiv)),
    };
    api.sitzungSetzen(sitzung).catch(() => undefined);
  }, 800);
}

export async function starten(): Promise<void> {
  try {
    const [status, einstellungen] = await Promise.all([api.status(), api.einstellungen()]);
    setzen((z) => ({
      // im Chrome-Tab wie im Browser: Datei-Auswahl und Speichern über Chrome
      desktop: status.desktop && !CHROME_MODUS.aktiv,
      einstellungen,
      seitenleiste: { ...z.seitenleiste, breite: einstellungen.seitenleiste_breite, miniGroesse: einstellungen.miniatur_groesse },
    }));
  } catch (e) {
    melden(`Verbindung zum Ergo4You-PDF-Dienst fehlgeschlagen: ${fehlerText(e)}`, "fehler");
    return;
  }
  if (CHROME_MODUS.aktiv) {
    await chromeStarten();
    return;
  }
  // Bereits geöffnete Dokumente (z. B. per Doppelklick/Explorer übergeben)
  const offen = await api.dokumente().catch(() => [] as DokumentInfo[]);
  // Letzte Sitzung wiederherstellen (fehlende Dateien still überspringen)
  const sitzung = await api.sitzung().catch(() => ({ dokumente: [], aktiv: null }) as Sitzung);
  const bereitsOffen = new Set(offen.map((d) => d.pfad?.toLowerCase()));
  for (const eintrag of sitzung.dokumente) {
    if (bereitsOffen.has(eintrag.pfad.toLowerCase())) continue;
    try {
      const info = await api.oeffnen(eintrag.pfad);
      dokumentHinzufuegen(info, {
        seite: Math.min(eintrag.seite, info.seitenanzahl - 1),
        zoom: eintrag.zoom,
        zoomModus: eintrag.zoomModus,
        modus: eintrag.modus,
      });
      if (eintrag.seite > 0) springen(info.id, Math.min(eintrag.seite, info.seitenanzahl - 1));
    } catch {
      /* Datei fehlt oder verschoben – überspringen */
    }
  }
  ereignisschleifeStarten();
  const z = holen();
  const sitzAktiv = sitzung.aktiv !== null ? z.dokumente[sitzung.aktiv]?.id : undefined;
  for (const info of offen) dokumentHinzufuegen(info);
  if (!offen.length && sitzAktiv) setzen({ aktiv: sitzAktiv });
  if (aktivesDokument()) sitzungMerken();
  void updatePruefen();
  window.setInterval(() => void updatePruefen(), 2 * 60 * 60 * 1000);
  // Abgestürzter letzter Lauf? Ungespeicherte Änderungen anbieten
  const sicherungen = await api.wiederherstellungListe().catch(() => []);
  if (sicherungen.length && !holen().dialog) setzen({ dialog: { art: "wiederherstellung", eintraege: sicherungen } });
}

// ---------------------------------------------------------------- Updates
export async function updatePruefen(): Promise<UpdateInfo | null> {
  try {
    const info = await api.updatePruefen();
    setzen({ update: info.verfuegbar ? info : null });
    return info;
  } catch {
    return null;
  }
}

export async function updateInstallieren(): Promise<void> {
  const u = holen().update;
  if (!u?.version) return;
  if (!u.installierbar) {
    melden(`Version ${u.version} liegt bereit – sie lässt sich nur im installierten Windows-Programm einspielen.`, "fehler");
    return;
  }
  const ungespeichert = holen().dokumente.filter((d) => d.geaendert).length;
  const wahl = await fragen(
    `Update auf Version ${u.version}`,
    `Ergo4You PDF wird kurz geschlossen, aktualisiert und startet von selbst wieder.${
      ungespeichert ? ` ${ungespeichert} Dokument(e) mit ungespeicherten Änderungen werden gesichert und danach zum Wiederherstellen angeboten.` : ""
    }`,
    [
      { titel: "Später", wert: "spaeter" },
      { titel: "Jetzt aktualisieren", wert: "los", primaer: true },
    ],
  );
  if (wahl !== "los") return;
  try {
    await api.updateInstallieren();
    melden(`Update auf ${u.version} wird installiert – Ergo4You PDF startet gleich neu …`);
  } catch (e) {
    melden(fehlerText(e), "fehler");
  }
}

/** Chrome-Tab: nur das übergebene Dokument zeigen, Titel des Tabs mitführen,
 * vor dem Schließen mit ungespeicherten Änderungen warnen. */
async function chromeStarten(): Promise<void> {
  if (CHROME_MODUS.dok) {
    try {
      dokumentHinzufuegen(await api.info(CHROME_MODUS.dok));
    } catch {
      melden("Das Dokument ist nicht mehr geöffnet – bitte die PDF in Chrome erneut öffnen.", "fehler");
    }
  }
  ereignisschleifeStarten();
  const titel = () => {
    const d = aktivesDokument();
    document.title = d ? `${d.geaendert ? "● " : ""}${d.titel} – ${PRODUKT}` : PRODUKT;
  };
  titel();
  abonnieren(titel);
  window.addEventListener("beforeunload", (e) => {
    if (holen().dokumente.some((d) => d.geaendert)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}
