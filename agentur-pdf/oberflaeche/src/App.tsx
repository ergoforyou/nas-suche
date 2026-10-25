import { useEffect, useRef, useState } from "react";
import { Befehlssuche } from "./befehle/Befehlssuche";
import { ausfuehren } from "./befehle/register";
import { Bereiche } from "./ansicht/Bereiche";
import { Auftraege } from "./ansicht/Auftraege";
import { SperrHinweis } from "./ansicht/SperrHinweis";
import { Dialoge } from "./ansicht/Dialoge";
import { Fehlergrenze } from "./ansicht/Fehlergrenze";
import { SignaturStartKarte } from "./ansicht/Unterschrift";
import { OcrHinweis } from "./ansicht/OcrDialoge";
import { textstatusBeobachten } from "./zustand/ocr";
import { signaturenBeobachten } from "./zustand/signaturen";
import { Menueband } from "./ansicht/Menueband";
import { Eigenschaftsleiste, Meldungen, Passwortdialog, Statusleiste, Tabs } from "./ansicht/Rahmen";
import { Panelleiste, Seitenleiste } from "./ansicht/Seitenleiste";
import { Titelleiste } from "./ansicht/Titelleiste";
import { EigenschaftenBereich } from "./ansicht/Eigenschaften";
import { DateiMenue } from "./ansicht/DateiMenue";
import { Startseite } from "./ansicht/Startseite";
import { ScreenshotKarte } from "./ansicht/ScreenshotKarte";
import { api } from "./api";
import { dateienOeffnen, naechsterTreffer, sitzungMerken, starten } from "./zustand/aktionen";
import { dateienEinfuegen } from "./zustand/seitenaktionen";
import { auswahlLoeschen, formularfeldLoeschen, textAuswahlKopieren } from "./zustand/anmerkungen";
import { abonnieren, holen, melden, setzen, useZustand } from "./zustand/store";

// Tastenkürzel nach Acrobat-Konvention → Befehls-IDs
const MIT_STRG: Record<string, string> = {
  o: "datei.oeffnen",
  s: "datei.speichern",
  w: "datei.schliessen",
  f: "ansicht.suchen",
  p: "ausgabe.drucken",
  "0": "zoom.ganzeseite",
  "1": "zoom.100",
  "2": "zoom.seitenbreite",
  "+": "zoom.rein",
  "=": "zoom.rein",
  "-": "zoom.raus",
};
const EINZELTASTEN: Record<string, string> = {
  h: "werkzeug.hand",
  z: "werkzeug.lassozoom",
  l: "werkzeug.lupe",
  t: "ocr.bereich",
  m: "werkzeug.hervorheben",
  v: "werkzeug.textauswahl",
  s: "werkzeug.schreibmaschine",
};
// Tastencodes statt Zeichen, da Umschalt das Zeichen je nach Tastaturlayout ändert
const PLUS_CODES = ["BracketRight", "Equal", "NumpadAdd"];
const MINUS_CODES = ["Slash", "Minus", "NumpadSubtract"];

function kuerzelBefehl(e: KeyboardEvent, imFeld: boolean): string | undefined {
  const strg = e.ctrlKey || e.metaKey;
  if (strg && e.shiftKey) {
    if (PLUS_CODES.includes(e.code)) return "ansicht.rechts_drehen";
    if (MINUS_CODES.includes(e.code)) return "ansicht.links_drehen";
    if (e.code === "KeyS") return "datei.speichern_unter";
    if (e.code === "KeyZ" && !imFeld) return "bearbeiten.wiederholen";
    return undefined;
  }
  // In Textfeldern bleibt Strg+Z/Y beim Feld
  if (strg && !imFeld && e.code === "KeyZ") return "bearbeiten.rueckgaengig";
  if (strg && !imFeld && e.code === "KeyY") return "bearbeiten.wiederholen";
  if (strg && !e.altKey) {
    if (e.code === "NumpadAdd") return "zoom.rein";
    if (e.code === "NumpadSubtract") return "zoom.raus";
    return MIT_STRG[e.key.toLowerCase()];
  }
  if (e.key === "F4") return "oberflaeche.seitenleiste";
  if (e.key === "F11") return "oberflaeche.eigenschaften";
  if (!imFeld && !e.altKey) return EINZELTASTEN[e.key.toLowerCase()];
  return undefined;
}

export function App() {
  const aktiv = useZustand((z) => z.aktiv);
  const seitenleisteOffen = useZustand((z) => z.seitenleiste.offen);
  const seitenleisteBreite = useZustand((z) => z.seitenleiste.breite);
  const design = useZustand((z) => z.einstellungen?.design ?? "hell");
  const akzent = useZustand((z) => z.einstellungen?.akzentfarbe);
  const rechtsOffen = useZustand((z) => z.rechtsOffen);
  const hatDokumente = useZustand((z) => z.dokumente.length > 0);
  const [ablage, setAblage] = useState(false);
  const ablageZaehler = useRef(0);

  useEffect(() => {
    void starten();
    const ende = [textstatusBeobachten(), signaturenBeobachten()];
    return () => ende.forEach((f) => f());
  }, []);

  // Sitzung bei jeder Änderung an Tabs/Ansicht (verzögert) sichern
  useEffect(() => {
    let vorher = holen().dokumente;
    return abonnieren(() => {
      const jetzt = holen().dokumente;
      if (jetzt !== vorher) {
        vorher = jetzt;
        sitzungMerken();
      }
    });
  }, []);

  // Design / Akzentfarbe
  useEffect(() => {
    const dunkel = design === "dunkel" || (design === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dunkel ? "dunkel" : "hell";
    if (akzent) document.documentElement.style.setProperty("--akzent", akzent);
  }, [design, akzent]);

  // Globale Tastenkürzel
  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      const imFeld = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setzen((z) => ({ befehlssucheOffen: !z.befehlssucheOffen }));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setzen({ befehlssucheOffen: true });
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        naechsterTreffer(e.shiftKey ? -1 : 1);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Tab") {
        e.preventDefault();
        const { dokumente, aktiv } = holen();
        if (dokumente.length < 2) return;
        const i = dokumente.findIndex((d) => d.id === aktiv);
        setzen({ aktiv: dokumente[(i + (e.shiftKey ? -1 : 1) + dokumente.length) % dokumente.length].id });
        return;
      }
      if (holen().befehlssucheOffen || holen().passwortAnfrage) return;
      // Anmerkung löschen / Textauswahl kopieren / Auswahl aufheben
      if (!imFeld && !holen().dialog) {
        if ((e.key === "Delete" || e.key === "Backspace") && holen().anmAuswahl) {
          e.preventDefault();
          auswahlLoeschen();
          return;
        }
        const fa = holen().formularAuswahl;
        if ((e.key === "Delete" || e.key === "Backspace") && fa && holen().werkzeug === "formular") {
          e.preventDefault();
          void formularfeldLoeschen(fa.dokId, fa.seite, fa.id);
          return;
        }
        if (e.key === "Escape" && fa) {
          setzen({ formularAuswahl: null });
          return;
        }
        if (e.key === "Escape" && holen().werkzeug === "formular") {
          setzen({ werkzeug: "hand" });
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.code === "KeyC" && holen().textAuswahl) {
          e.preventDefault();
          void textAuswahlKopieren();
          return;
        }
        if (e.key === "Escape" && (holen().anmAuswahl || holen().textAuswahl || holen().platzieren)) {
          setzen({ anmAuswahl: null, textAuswahl: null, platzieren: null, ...(holen().werkzeug === "platzieren" ? { werkzeug: "hand" } : {}) });
          return;
        }
      }
      const id = kuerzelBefehl(e, Boolean(imFeld));
      if (!id) return;
      e.preventDefault();
      ausfuehren(id);
    };
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, []);

  // Strg+V: Bild oder Datei aus der Zwischenablage nach der aktuellen Seite einfügen
  useEffect(() => {
    const einfuegen = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const d = holen().dokumente.find((x) => x.id === holen().aktiv);
      const dateien = [...(e.clipboardData?.files ?? [])];
      if (!d || !dateien.length) return;
      e.preventDefault();
      const nach = d.auswahl.length ? d.auswahl[d.auswahl.length - 1] : d.ansicht.seite;
      void dateienEinfuegen(d.id, nach + 1, dateien);
    };
    window.addEventListener("paste", einfuegen);
    return () => window.removeEventListener("paste", einfuegen);
  }, []);

  // Browser-Zoom per Strg+Mausrad außerhalb der Dokumentansicht verhindern
  useEffect(() => {
    const rad = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener("wheel", rad, { passive: false });
    return () => window.removeEventListener("wheel", rad);
  }, []);

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        ablageZaehler.current++;
        setAblage(true);
      }}
      onDragLeave={() => {
        ablageZaehler.current = Math.max(0, ablageZaehler.current - 1);
        if (!ablageZaehler.current) setAblage(false);
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        ablageZaehler.current = 0;
        setAblage(false);
        void dateienOeffnen([...e.dataTransfer.files]);
      }}
    >
      <Titelleiste />
      <Menueband />
      <Eigenschaftsleiste />
      <main className="hauptbereich">
        <Panelleiste />
        {seitenleisteOffen && (
          <Fehlergrenze bereich="Seitenleiste">
            <Seitenleiste />
          </Fehlergrenze>
        )}
        {seitenleisteOffen && <Trennlinie breite={seitenleisteBreite} />}
        <section className="dokumentbereich">
          {hatDokumente && <Tabs />}
          <div className="dokument-flaeche">
            <Fehlergrenze
              bereich="Dialog"
              stillZuruecksetzen={() => {
                setzen({ dialog: null });
                melden("Der Dialog wurde wegen eines Fehlers geschlossen.", "fehler");
              }}
            >
              <Dialoge />
            </Fehlergrenze>
            <OcrHinweis />
            <SperrHinweis />
            {!aktiv && <SignaturStartKarte />}
            {aktiv ? <Bereiche /> : <Startseite />}
          </div>
        </section>
        {rechtsOffen && aktiv && (
          <Fehlergrenze bereich="Eigenschaften">
            <EigenschaftenBereich />
          </Fehlergrenze>
        )}
      </main>
      <Statusleiste />
      <DateiMenue />
      <Befehlssuche />
      <Passwortdialog />
      <Auftraege />
      <Meldungen />
      <ScreenshotKarte />
      {ablage && <div className="ablage-hinweis">Dateien hier ablegen zum Öffnen</div>}
    </div>
  );
}

/** Verschiebbare Trennlinie zwischen Seitenleiste und Dokument. */
function Trennlinie({ breite }: { breite: number }) {
  return (
    <div
      className="trennlinie"
      role="separator"
      aria-orientation="vertical"
      aria-label="Seitenleiste verbreitern oder verschmälern"
      onMouseDown={(e) => {
        e.preventDefault();
        const start = e.clientX;
        let neu = breite;
        const bewegen = (m: MouseEvent) => {
          neu = Math.max(140, Math.min(window.innerWidth * 0.6, breite + m.clientX - start));
          setzen((z) => ({ seitenleiste: { ...z.seitenleiste, breite: neu } }));
        };
        const ende = () => {
          window.removeEventListener("mousemove", bewegen);
          window.removeEventListener("mouseup", ende);
          api.einstellungenSetzen({ seitenleiste_breite: Math.round(neu) }).catch(() => undefined);
        };
        window.addEventListener("mousemove", bewegen);
        window.addEventListener("mouseup", ende);
      }}
    />
  );
}
