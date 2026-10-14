import { useEffect, useRef, useState } from "react";
import { Befehlssuche } from "./befehle/Befehlssuche";
import { ausfuehren } from "./befehle/register";
import { Bereiche } from "./ansicht/Bereiche";
import { Dialoge } from "./ansicht/Dialoge";
import { Menueband } from "./ansicht/Menueband";
import { Eigenschaftsleiste, Meldungen, Passwortdialog, Statusleiste, Tabs } from "./ansicht/Rahmen";
import { Seitenleiste } from "./ansicht/Seitenleiste";
import { Startseite } from "./ansicht/Startseite";
import { api } from "./api";
import { dateienOeffnen, naechsterTreffer, sitzungMerken, starten } from "./zustand/aktionen";
import { dateienEinfuegen } from "./zustand/seitenaktionen";
import { abonnieren, holen, setzen, useZustand } from "./zustand/store";

// Tastenkürzel nach Acrobat-Konvention → Befehls-IDs
const MIT_STRG: Record<string, string> = {
  o: "datei.oeffnen",
  s: "datei.speichern",
  w: "datei.schliessen",
  f: "ansicht.suchen",
  "0": "zoom.ganzeseite",
  "1": "zoom.100",
  "2": "zoom.seitenbreite",
  "+": "zoom.rein",
  "=": "zoom.rein",
  "-": "zoom.raus",
};
const EINZELTASTEN: Record<string, string> = { h: "werkzeug.hand", z: "werkzeug.lassozoom", l: "werkzeug.lupe" };
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
  if (!imFeld && !e.altKey) return EINZELTASTEN[e.key.toLowerCase()];
  return undefined;
}

export function App() {
  const aktiv = useZustand((z) => z.aktiv);
  const seitenleisteOffen = useZustand((z) => z.seitenleiste.offen);
  const seitenleisteBreite = useZustand((z) => z.seitenleiste.breite);
  const design = useZustand((z) => z.einstellungen?.design ?? "hell");
  const akzent = useZustand((z) => z.einstellungen?.akzentfarbe);
  const [ablage, setAblage] = useState(false);
  const ablageZaehler = useRef(0);

  useEffect(() => {
    void starten();
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
      <Tabs />
      <Menueband />
      <Eigenschaftsleiste />
      <main className="hauptbereich">
        {seitenleisteOffen && <Seitenleiste />}
        {seitenleisteOffen && <Trennlinie breite={seitenleisteBreite} />}
        <section className="dokumentbereich">
          {aktiv && <Dialoge />}
          {aktiv ? <Bereiche /> : <Startseite />}
        </section>
      </main>
      <Statusleiste />
      <Befehlssuche />
      <Passwortdialog />
      <Meldungen />
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
