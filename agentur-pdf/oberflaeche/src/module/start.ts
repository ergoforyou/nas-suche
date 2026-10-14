// Register „Start“: Datei, Ansicht, Zoom, Navigation.

import {
  BookOpen,
  Columns2,
  FileText,
  FolderOpen,
  Hand,
  Maximize,
  MoveHorizontal,
  PanelLeft,
  RectangleVertical,
  RotateCcw,
  RotateCw,
  Search,
  SquareDashed,
  Moon,
  X,
  ZoomIn,
  ZoomOut,
  Scan,
  ChevronsDown,
  ChevronsUp,
} from "lucide-react";
import { api } from "../api";
import { registrieren } from "../befehle/register";
import { dokumentSchliessen, oeffnenDialog } from "../zustand/aktionen";
import {
  aktivesDokument,
  ansichtDrehen,
  holen,
  modusSetzen,
  setzen,
  springen,
  werkzeugWaehlen,
  zoomSchritt,
  zoomSetzen,
  type Zustand,
} from "../zustand/store";

const mitDokument = (z: Zustand) => aktivesDokument(z) !== null;

export function sucheOeffnen(): void {
  setzen((z) => ({ seitenleiste: { ...z.seitenleiste, offen: true, panel: "suche" } }));
  // Fokus erst nach dem Rendern setzen
  requestAnimationFrame(() => {
    const feld = document.getElementById("suchfeld") as HTMLInputElement | null;
    feld?.focus();
    feld?.select();
  });
}

export function designUmschalten(): void {
  const e = holen().einstellungen;
  if (!e) return;
  const design = e.design === "dunkel" ? "hell" : "dunkel";
  setzen({ einstellungen: { ...e, design } });
  api.einstellungenSetzen({ design }).catch(() => undefined);
}

registrieren(
  // ---------------------------------------------------------------- Datei
  {
    id: "datei.oeffnen",
    titel: "Öffnen",
    register: "start",
    gruppe: "Datei",
    icon: FolderOpen,
    gross: true,
    kuerzel: "Strg+O",
    stichworte: ["datei", "laden", "pdf öffnen"],
    ausfuehren: () => void oeffnenDialog(),
  },
  {
    id: "datei.schliessen",
    titel: "Dokument schließen",
    register: "start",
    gruppe: "Datei",
    icon: X,
    versteckt: true,
    kuerzel: "Strg+W",
    stichworte: ["tab schließen"],
    ausfuehren: () => void dokumentSchliessen(),
    aktiv: mitDokument,
  },
  // --------------------------------------------------------------- Suchen
  {
    id: "ansicht.suchen",
    titel: "Suchen",
    register: "start",
    gruppe: "Datei",
    icon: Search,
    gross: true,
    kuerzel: "Strg+F",
    stichworte: ["volltextsuche", "finden", "text suchen"],
    ausfuehren: sucheOeffnen,
  },
  // ---------------------------------------------------------- Werkzeuge
  {
    id: "werkzeug.hand",
    titel: "Hand",
    register: "start",
    gruppe: "Werkzeuge",
    icon: Hand,
    gross: true,
    kuerzel: "H",
    stichworte: ["verschieben", "blättern"],
    ausfuehren: () => werkzeugWaehlen("hand"),
    gewaehlt: (z) => z.werkzeug === "hand",
  },
  {
    id: "werkzeug.lassozoom",
    titel: "Bereich zoomen",
    register: "start",
    gruppe: "Werkzeuge",
    icon: SquareDashed,
    gross: true,
    kuerzel: "Z",
    stichworte: ["lasso", "zoom auf bereich", "rechteck zoom"],
    ausfuehren: () => werkzeugWaehlen("lassozoom"),
    aktiv: mitDokument,
    gewaehlt: (z) => z.werkzeug === "lassozoom",
  },
  {
    id: "werkzeug.lupe",
    titel: "Lupe",
    register: "start",
    gruppe: "Werkzeuge",
    icon: Scan,
    gross: true,
    kuerzel: "L",
    stichworte: ["vergrößerungsglas", "lupe"],
    ausfuehren: () => werkzeugWaehlen("lupe"),
    aktiv: mitDokument,
    gewaehlt: (z) => z.werkzeug === "lupe",
  },
  // ---------------------------------------------------------------- Zoom
  {
    id: "zoom.seitenbreite",
    titel: "Seitenbreite",
    register: "start",
    gruppe: "Zoom",
    icon: MoveHorizontal,
    gross: true,
    kuerzel: "Strg+2",
    stichworte: ["breite anpassen", "zoom"],
    ausfuehren: () => zoomSetzen(aktivesDokument()?.ansicht.zoom ?? 1, "seitenbreite"),
    aktiv: mitDokument,
    gewaehlt: (z) => aktivesDokument(z)?.ansicht.zoomModus === "seitenbreite",
  },
  {
    id: "zoom.ganzeseite",
    titel: "Ganze Seite",
    register: "start",
    gruppe: "Zoom",
    icon: Maximize,
    gross: true,
    kuerzel: "Strg+0",
    stichworte: ["seite anpassen", "zoom"],
    ausfuehren: () => zoomSetzen(aktivesDokument()?.ansicht.zoom ?? 1, "ganzeseite"),
    aktiv: mitDokument,
    gewaehlt: (z) => aktivesDokument(z)?.ansicht.zoomModus === "ganzeseite",
  },
  {
    id: "zoom.100",
    titel: "Originalgröße (100 %)",
    register: "start",
    gruppe: "Zoom",
    icon: FileText,
    kuerzel: "Strg+1",
    stichworte: ["100", "tatsächliche größe", "zoom"],
    ausfuehren: () => zoomSetzen(1),
    aktiv: mitDokument,
  },
  {
    id: "zoom.rein",
    titel: "Vergrößern",
    register: "start",
    gruppe: "Zoom",
    icon: ZoomIn,
    kuerzel: "Strg++",
    stichworte: ["zoom", "größer"],
    ausfuehren: () => zoomSchritt(1),
    aktiv: mitDokument,
  },
  {
    id: "zoom.raus",
    titel: "Verkleinern",
    register: "start",
    gruppe: "Zoom",
    icon: ZoomOut,
    kuerzel: "Strg+-",
    stichworte: ["zoom", "kleiner"],
    ausfuehren: () => zoomSchritt(-1),
    aktiv: mitDokument,
  },
  // ------------------------------------------------------------ Ansicht
  {
    id: "ansicht.einzelseite",
    titel: "Einzelseite",
    register: "start",
    gruppe: "Seitenanzeige",
    icon: RectangleVertical,
    stichworte: ["ansicht", "eine seite"],
    ausfuehren: () => modusSetzen("einzelseite"),
    aktiv: mitDokument,
    gewaehlt: (z) => aktivesDokument(z)?.ansicht.modus === "einzelseite",
  },
  {
    id: "ansicht.fortlaufend",
    titel: "Fortlaufend",
    register: "start",
    gruppe: "Seitenanzeige",
    icon: ChevronsDown,
    stichworte: ["ansicht", "scrollen"],
    ausfuehren: () => modusSetzen("fortlaufend"),
    aktiv: mitDokument,
    gewaehlt: (z) => aktivesDokument(z)?.ansicht.modus === "fortlaufend",
  },
  {
    id: "ansicht.doppelseite",
    titel: "Doppelseite",
    register: "start",
    gruppe: "Seitenanzeige",
    icon: BookOpen,
    stichworte: ["ansicht", "zwei seiten", "buch"],
    ausfuehren: () => modusSetzen("doppelseite"),
    aktiv: mitDokument,
    gewaehlt: (z) => aktivesDokument(z)?.ansicht.modus === "doppelseite",
  },
  {
    id: "ansicht.doppelseite_fortlaufend",
    titel: "Doppelseite fortlaufend",
    register: "start",
    gruppe: "Seitenanzeige",
    icon: Columns2,
    stichworte: ["ansicht", "zwei seiten", "scrollen"],
    ausfuehren: () => modusSetzen("doppelseite_fortlaufend"),
    aktiv: mitDokument,
    gewaehlt: (z) => aktivesDokument(z)?.ansicht.modus === "doppelseite_fortlaufend",
  },
  {
    id: "ansicht.links_drehen",
    titel: "Ansicht links drehen",
    register: "start",
    gruppe: "Seitenanzeige",
    icon: RotateCcw,
    kuerzel: "Strg+Umschalt+-",
    stichworte: ["drehen", "rotieren", "gegen uhrzeigersinn"],
    beschreibung: "Dreht nur die Anzeige – die Datei bleibt unverändert.",
    ausfuehren: () => ansichtDrehen(-90),
    aktiv: mitDokument,
  },
  {
    id: "ansicht.rechts_drehen",
    titel: "Ansicht rechts drehen",
    register: "start",
    gruppe: "Seitenanzeige",
    icon: RotateCw,
    kuerzel: "Strg+Umschalt++",
    stichworte: ["drehen", "rotieren", "im uhrzeigersinn"],
    beschreibung: "Dreht nur die Anzeige – die Datei bleibt unverändert.",
    ausfuehren: () => ansichtDrehen(90),
    aktiv: mitDokument,
  },
  // --------------------------------------------------------- Navigation
  {
    id: "navigation.erste",
    titel: "Erste Seite",
    register: "start",
    gruppe: "Navigation",
    icon: ChevronsUp,
    versteckt: true,
    kuerzel: "Pos1",
    stichworte: ["anfang", "seite 1"],
    ausfuehren: () => {
      const d = aktivesDokument();
      if (d) springen(d.id, 0);
    },
    aktiv: mitDokument,
  },
  {
    id: "navigation.letzte",
    titel: "Letzte Seite",
    register: "start",
    gruppe: "Navigation",
    icon: ChevronsDown,
    versteckt: true,
    kuerzel: "Ende",
    stichworte: ["ende", "schluss"],
    ausfuehren: () => {
      const d = aktivesDokument();
      if (d) springen(d.id, d.seitenanzahl - 1);
    },
    aktiv: mitDokument,
  },
  // -------------------------------------------------------- Oberfläche
  {
    id: "oberflaeche.seitenleiste",
    titel: "Seitenleiste ein/aus",
    register: "start",
    gruppe: "Oberfläche",
    icon: PanelLeft,
    versteckt: true,
    kuerzel: "F4",
    stichworte: ["miniaturen", "leiste", "panel"],
    ausfuehren: () => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, offen: !z.seitenleiste.offen } })),
  },
  {
    id: "oberflaeche.design",
    titel: "Hell/Dunkel umschalten",
    register: "start",
    gruppe: "Oberfläche",
    icon: Moon,
    versteckt: true,
    stichworte: ["dunkelmodus", "nachtmodus", "design", "farbe", "theme"],
    ausfuehren: designUmschalten,
  },
);
