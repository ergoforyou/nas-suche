// Miniaturleiste: Seiten markieren (Klick, Strg, Umschalt), per Drag & Drop
// verschieben – auch in andere Dokumente (Strg = kopieren) –, Dateien aus dem
// Explorer zwischen zwei Seiten ablegen, Rechtsklick-Menü, Entf zum Löschen.

import {
  Copy,
  Crop,
  FileOutput,
  FilePlus2,
  FileUp,
  RotateCcw,
  RotateCw,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bildUrl } from "../api";
import { anfordern, ausCache } from "../render/bildlader";
import { anzeigeGroesse, renderStufe } from "../render/layout";
import {
  dateiEinfuegenDialog,
  dateienEinfuegen,
  leereSeiteEinfuegen,
  seiteAufbereiten,
  seitenDrehen,
  seitenDuplizieren,
  seitenExtrahieren,
  seitenLoeschen,
  seitenUebertragen,
  seitenVerschieben,
} from "../zustand/seitenaktionen";
import { auswahlSetzen, holen, springen } from "../zustand/store";
import type { Dokument } from "../typen";
import { Kontextmenue, type MenuePunkt } from "./Kontextmenue";

const MINI_ABSTAND = 34; // Platz für Seitenzahl + Rand
const DND_TYP = "application/x-agentur-pdf-seiten";

interface Position {
  x: number;
  y: number;
  b: number;
  h: number;
}

/** Zieldaten, solange ein Drag aus einer Miniaturleiste läuft (dataTransfer ist
 * während dragover nicht lesbar). */
let laufenderDrag: { dokId: string; seiten: number[] } | null = null;

export function Miniaturen({ dok, groesse }: { dok: Dokument; groesse: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ y: 0, h: 600, b: 200 });
  const [ablage, setAblage] = useState<{ index: number; kopieren: boolean } | null>(null);
  const [menue, setMenue] = useState<{ x: number; y: number } | null>(null);
  const anker = useRef<number | null>(null);
  const drehung = dok.ansicht.drehung;

  // Positionen aller Miniaturen (eine Spalte; bei breiter Leiste mehrere)
  const { positionen, gesamtHoehe, spalten } = useMemo(() => {
    const spalten = Math.max(1, Math.floor((vp.b - 8) / (groesse + 16)));
    const positionen: Position[] = [];
    let y = 8;
    for (let i = 0; i < dok.seiten.length; i += spalten) {
      let zeilenHoehe = 0;
      const spaltenBreite = (vp.b - 8) / spalten;
      for (let k = 0; k < spalten && i + k < dok.seiten.length; k++) {
        const [bPt, hPt] = anzeigeGroesse(dok.seiten[i + k], drehung);
        const skala = groesse / Math.max(bPt, hPt * 0.75);
        const b = Math.round(bPt * skala);
        const h = Math.round(hPt * skala);
        positionen.push({ x: Math.round(4 + k * spaltenBreite + (spaltenBreite - b) / 2), y, b, h });
        zeilenHoehe = Math.max(zeilenHoehe, h);
      }
      for (let k = 0; k < spalten && i + k < dok.seiten.length; k++) {
        const p = positionen[i + k];
        p.y = y + (zeilenHoehe - p.h);
      }
      y += zeilenHoehe + MINI_ABSTAND;
    }
    return { positionen, gesamtHoehe: y, spalten };
  }, [dok.seiten, groesse, drehung, vp.b]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const messen = () => setVp({ y: el.scrollTop, h: el.clientHeight, b: el.clientWidth });
    messen();
    const ro = new ResizeObserver(messen);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Aktuelle Seite in der Miniaturleiste sichtbar halten
  useEffect(() => {
    const el = scrollRef.current;
    const p = positionen[dok.ansicht.seite];
    if (!el || !p) return;
    if (p.y < el.scrollTop || p.y + p.h + MINI_ABSTAND > el.scrollTop + el.clientHeight) {
      el.scrollTop = p.y - el.clientHeight / 3;
    }
  }, [dok.ansicht.seite, positionen]);

  // ---------------------------------------------------------- Auswahl
  const klick = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anker.current !== null) {
      const [a, b] = [Math.min(anker.current, i), Math.max(anker.current, i)];
      const bereich = Array.from({ length: b - a + 1 }, (_, k) => a + k);
      auswahlSetzen(dok.id, e.ctrlKey || e.metaKey ? [...dok.auswahl, ...bereich] : bereich);
    } else if (e.ctrlKey || e.metaKey) {
      auswahlSetzen(dok.id, dok.auswahl.includes(i) ? dok.auswahl.filter((s) => s !== i) : [...dok.auswahl, i]);
      anker.current = i;
    } else {
      auswahlSetzen(dok.id, [i]);
      anker.current = i;
    }
    springen(dok.id, i);
  };

  const taste = (e: React.KeyboardEvent) => {
    const aktuell = dok.ansicht.seite;
    if (e.key === "Delete") {
      e.preventDefault();
      void seitenLoeschen(dok);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      auswahlSetzen(dok.id, Array.from({ length: dok.seitenanzahl }, (_, k) => k));
    } else if (e.key === "Escape") {
      auswahlSetzen(dok.id, []);
    } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const schritt = e.key === "ArrowDown" ? spalten : e.key === "ArrowUp" ? -spalten : e.key === "ArrowRight" ? 1 : -1;
      const ziel = Math.max(0, Math.min(dok.seitenanzahl - 1, aktuell + schritt));
      if (e.shiftKey) {
        const a = anker.current ?? aktuell;
        const [von, bis] = [Math.min(a, ziel), Math.max(a, ziel)];
        auswahlSetzen(dok.id, Array.from({ length: bis - von + 1 }, (_, k) => von + k));
      } else {
        auswahlSetzen(dok.id, [ziel]);
        anker.current = ziel;
      }
      springen(dok.id, ziel);
    }
  };

  // ------------------------------------------------------- Drag & Drop
  const ablageIndex = (e: React.DragEvent): number => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top + el.scrollTop;
    for (let i = 0; i < positionen.length; i++) {
      const p = positionen[i];
      const zeilenEnde = p.y + p.h + MINI_ABSTAND / 2;
      if (my > zeilenEnde) continue; // Zeile liegt weiter oben
      if (spalten === 1) return my < p.y + p.h / 2 ? i : i + 1;
      // Gitter: innerhalb der Zeile nach x
      if (mx < p.x + p.b / 2) return i;
      const naechste = positionen[i + 1];
      if (!naechste || naechste.y > p.y + p.h) return i + 1; // letzte Spalte der Zeile
    }
    return positionen.length;
  };

  const istDateiDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  const istSeitenDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes(DND_TYP);

  const dragOver = (e: React.DragEvent) => {
    if (!istSeitenDrag(e) && !istDateiDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const fremd = laufenderDrag !== null && laufenderDrag.dokId !== dok.id;
    const kopieren = istDateiDrag(e) || (fremd && (e.ctrlKey || e.metaKey));
    e.dataTransfer.dropEffect = kopieren ? "copy" : "move";
    const index = ablageIndex(e);
    setAblage((a) => (a?.index === index && a.kopieren === kopieren ? a : { index, kopieren }));
    // Automatisch scrollen am Rand
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    if (e.clientY < r.top + 40) el.scrollTop -= 18;
    else if (e.clientY > r.bottom - 40) el.scrollTop += 18;
  };

  const drop = (e: React.DragEvent) => {
    if (!istSeitenDrag(e) && !istDateiDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const index = ablageIndex(e);
    setAblage(null);
    if (istSeitenDrag(e)) {
      const daten = JSON.parse(e.dataTransfer.getData(DND_TYP)) as { dokId: string; seiten: number[] };
      laufenderDrag = null;
      if (daten.dokId === dok.id) void seitenVerschieben(dok.id, daten.seiten, index);
      else void seitenUebertragen(daten.dokId, daten.seiten, dok.id, index, !(e.ctrlKey || e.metaKey));
    } else if (e.dataTransfer.files.length) {
      void dateienEinfuegen(dok.id, index, [...e.dataTransfer.files]);
    }
  };

  const dragStart = (i: number, e: React.DragEvent) => {
    const seiten = dok.auswahl.includes(i) ? dok.auswahl : [i];
    if (!dok.auswahl.includes(i)) auswahlSetzen(dok.id, [i]);
    laufenderDrag = { dokId: dok.id, seiten };
    e.dataTransfer.setData(DND_TYP, JSON.stringify(laufenderDrag));
    e.dataTransfer.effectAllowed = "copyMove";
    if (seiten.length > 1) {
      const zettel = document.createElement("div");
      zettel.className = "drag-zettel";
      zettel.textContent = `${seiten.length} Seiten`;
      document.body.appendChild(zettel);
      e.dataTransfer.setDragImage(zettel, 20, 20);
      setTimeout(() => zettel.remove(), 0);
    }
  };

  // ---------------------------------------------------------- Kontextmenü
  const kontext = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!dok.auswahl.includes(i)) {
      auswahlSetzen(dok.id, [i]);
      anker.current = i;
    }
    setMenue({ x: e.clientX, y: e.clientY });
  };
  const d = () => holen().dokumente.find((x) => x.id === dok.id) ?? dok;
  const anzahl = dok.auswahl.length || 1;
  const menuePunkte: MenuePunkt[] = [
    { titel: "Links drehen", icon: RotateCcw, aktion: () => void seitenDrehen(-90, d()) },
    { titel: "Rechts drehen", icon: RotateCw, aktion: () => void seitenDrehen(90, d()) },
    { titel: "180° drehen", icon: RefreshCw, aktion: () => void seitenDrehen(180, d()) },
    {
      titel: "Zuschneiden & aufhellen …",
      icon: Crop,
      deaktiviert: anzahl > 1,
      aktion: () => seiteAufbereiten(d()),
    },
    "trenner",
    { titel: "Leere Seite davor", icon: FilePlus2, aktion: () => void leereSeiteEinfuegen(false, d()) },
    { titel: "Leere Seite danach", icon: FilePlus2, aktion: () => void leereSeiteEinfuegen(true, d()) },
    { titel: "Datei einfügen davor …", icon: FileUp, aktion: () => void dateiEinfuegenDialog(false, d()) },
    { titel: "Datei einfügen danach …", icon: FileUp, aktion: () => void dateiEinfuegenDialog(true, d()) },
    "trenner",
    { titel: anzahl > 1 ? `${anzahl} Seiten duplizieren` : "Duplizieren", icon: Copy, aktion: () => void seitenDuplizieren(d()) },
    { titel: "Als neue PDF extrahieren", icon: FileOutput, aktion: () => void seitenExtrahieren(false, d()) },
    "trenner",
    {
      titel: anzahl > 1 ? `${anzahl} Seiten löschen` : "Seite löschen",
      icon: Trash2,
      kuerzel: "Entf",
      gefahr: true,
      deaktiviert: anzahl >= dok.seitenanzahl,
      aktion: () => void seitenLoeschen(d()),
    },
  ];

  // ------------------------------------------------------------ Rendern
  const sichtbar: number[] = [];
  for (let i = 0; i < positionen.length; i++) {
    const p = positionen[i];
    if (p.y + p.h + MINI_ABSTAND < vp.y - vp.h / 2) continue;
    if (p.y > vp.y + vp.h * 1.5) break;
    sichtbar.push(i);
  }
  const markiert = new Set(dok.auswahl);

  return (
    <div
      ref={scrollRef}
      className="miniaturen"
      tabIndex={0}
      onScroll={(e) => setVp((v) => ({ ...v, y: (e.target as HTMLDivElement).scrollTop }))}
      onKeyDown={taste}
      onDragOver={dragOver}
      onDragLeave={(e) => {
        if (!scrollRef.current?.contains(e.relatedTarget as Node)) setAblage(null);
      }}
      onDrop={drop}
      data-testid="miniaturen"
      data-dok={dok.id}
      data-spalten={spalten}
      aria-label={`Seiten von ${dok.titel}`}
    >
      <div style={{ height: gesamtHoehe, position: "relative" }}>
        {sichtbar.map((i) => (
          <Miniatur
            key={dok.kennungen[i] ?? i}
            dok={dok}
            seite={i}
            pos={positionen[i]}
            aktiv={i === dok.ansicht.seite}
            markiert={markiert.has(i)}
            onKlick={klick}
            onKontext={kontext}
            onDragStart={dragStart}
          />
        ))}
        {ablage && <Ablagemarke index={ablage.index} positionen={positionen} spalten={spalten} kopieren={ablage.kopieren} breite={vp.b} />}
      </div>
      {menue && <Kontextmenue x={menue.x} y={menue.y} punkte={menuePunkte} schliessen={() => setMenue(null)} />}
    </div>
  );
}

function Ablagemarke(props: { index: number; positionen: Position[]; spalten: number; kopieren: boolean; breite: number }) {
  const { index, positionen, spalten } = props;
  const klasse = `ablagemarke${props.kopieren ? " kopieren" : ""}`;
  if (!positionen.length) return null;
  if (spalten === 1) {
    const y = index < positionen.length ? positionen[index].y - MINI_ABSTAND / 2 + 6 : positionen[index - 1].y + positionen[index - 1].h + MINI_ABSTAND / 2 - 2;
    return <div className={klasse} style={{ left: 10, width: props.breite - 20, top: y - 2, height: 4 }} />;
  }
  const bezug = positionen[Math.min(index, positionen.length - 1)];
  const x = index < positionen.length ? bezug.x - 8 : bezug.x + bezug.b + 6;
  return <div className={klasse} style={{ left: x, top: bezug.y - 4, width: 4, height: bezug.h + 8 }} />;
}

const Miniatur = memo(function Miniatur(props: {
  dok: Dokument;
  seite: number;
  pos: Position;
  aktiv: boolean;
  markiert: boolean;
  onKlick: (i: number, e: React.MouseEvent) => void;
  onKontext: (i: number, e: React.MouseEvent) => void;
  onDragStart: (i: number, e: React.DragEvent) => void;
}) {
  const { dok, seite, pos } = props;
  const dpr = window.devicePixelRatio || 1;
  const [bPt] = anzeigeGroesse(dok.seiten[seite], dok.ansicht.drehung);
  const url = bildUrl({
    dokId: dok.id,
    seite,
    kennung: dok.kennungen[seite] ?? "",
    skala: renderStufe((pos.b / bPt) * dpr),
    drehung: dok.ansicht.drehung,
  });
  const [bild, setBild] = useState<string | null>(() => ausCache(url));
  useEffect(() => anfordern(url, 5, (u) => u && setBild(u), 120), [url]);
  return (
    <button
      className={`miniatur${props.aktiv ? " aktiv" : ""}${props.markiert ? " markiert" : ""}`}
      style={{ left: pos.x - 4, top: pos.y - 4, width: pos.b + 8 }}
      onClick={(e) => props.onKlick(seite, e)}
      onContextMenu={(e) => props.onKontext(seite, e)}
      draggable
      onDragStart={(e) => props.onDragStart(seite, e)}
      onDragEnd={() => (laufenderDrag = null)}
      title={`Seite ${seite + 1}`}
      aria-pressed={props.markiert}
      data-seite={seite}
    >
      <span className="miniatur-bild" style={{ width: pos.b, height: pos.h }}>
        {bild && <img src={bild} alt="" draggable={false} />}
      </span>
      <span className="miniatur-nr">{seite + 1}</span>
    </button>
  );
});
