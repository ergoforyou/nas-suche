// Register „Design“: Objekte freistellen und anordnen, gestaltete
// Textbausteine, Deckblatt/Inhaltsverzeichnis/Briefpapier, Hausfarben.
// KI-Funktionen sind vorbereitet, aber noch nicht freigeschaltet.

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  BadgeEuro,
  BookOpen,
  Copy,
  FileText,
  FlipHorizontal2,
  FlipVertical2,
  Heading,
  Info,
  LayoutTemplate,
  ListOrdered,
  Palette,
  RotateCcw,
  RotateCw,
  Scissors,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { registrieren, type Befehl } from "../befehle/register";
import { freistellenStarten } from "../ansicht/DesignDialoge";
import { api } from "../api";
import { anmerkungFinden } from "../zustand/anmerkungen";
import { ausrichten, bildUmformen, ebeneAendern, textbaustein } from "../zustand/design";
import { anwenden } from "../zustand/seitenaktionen";
import { holen, melden, setzen, type Zustand } from "../zustand/store";

const mitDokument = (z: Zustand) => z.aktiv !== null;
const mitAuswahl = (z: Zustand) => z.anmAuswahl !== null;
const mitBild = (z: Zustand) => {
  const a = z.anmAuswahl;
  const anm = a ? anmerkungFinden(a.dokId, a.seite, a.id) : undefined;
  return anm?.art === "bild" || anm?.art === "unterschrift";
};

const LILA = "#7A3FB5";
const BLAU = "#1F5BAA";

function b(id: string, titel: string, gruppe: string, icon: Befehl["icon"], ausfuehren: () => void, extra: Partial<Befehl> = {}): Befehl {
  return { id: `design.${id}`, titel, register: "design", gruppe, icon, ausfuehren, aktiv: mitDokument, farbe: BLAU, ...extra };
}

function mitDok(art: "briefpapier" | "deckblatt"): void {
  const d = holen().aktiv;
  if (!d) return;
  setzen({ dialog: { art, dokId: d } });
}

async function inhaltsverzeichnis(): Promise<void> {
  const d = holen().aktiv;
  if (!d) return;
  const farbe = holen().einstellungen?.hausfarben?.[0] ?? "#1F5BAA";
  try {
    anwenden(await api.inhaltsverzeichnis(d, 0, "Inhalt", farbe));
    melden("Inhaltsverzeichnis aus den Lesezeichen als Seite 1 eingefügt.");
  } catch (e) {
    melden((e as Error).message, "fehler");
  }
}

registrieren(
  b("freistellen", "Objekt freistellen", "Freistellen", Scissors, freistellenStarten, {
    gross: true,
    farbe: LILA,
    gewaehlt: (z) => z.werkzeug === "freistellen",
    stichworte: ["ausschneiden", "hintergrund entfernen", "logo", "motiv", "freisteller"],
    beschreibung: "Rahmen um ein Motiv oder Logo ziehen – der Hintergrund wird entfernt, das Objekt lässt sich frei verschieben.",
  }),

  b("vorne", "Nach vorne", "Anordnen", ArrowUp, () => void ebeneAendern("vorne"), { aktiv: mitAuswahl, stichworte: ["ebene", "reihenfolge"] }),
  b("hinten", "Nach hinten", "Anordnen", ArrowDown, () => void ebeneAendern("hinten"), { aktiv: mitAuswahl, stichworte: ["ebene", "reihenfolge"] }),
  b("ganz_vorne", "Ganz nach vorne", "Anordnen", ArrowUpToLine, () => void ebeneAendern("ganz_vorne"), { aktiv: mitAuswahl, stichworte: ["vordergrund"] }),
  b("ganz_hinten", "Ganz nach hinten", "Anordnen", ArrowDownToLine, () => void ebeneAendern("ganz_hinten"), { aktiv: mitAuswahl, stichworte: ["hintergrund"] }),
  b("rechts", "Rechts drehen", "Anordnen", RotateCw, () => void bildUmformen("rechts"), { aktiv: mitBild, stichworte: ["bild drehen"] }),
  b("links", "Links drehen", "Anordnen", RotateCcw, () => void bildUmformen("links"), { aktiv: mitBild, stichworte: ["bild drehen"] }),
  b("waagerecht", "Waagerecht spiegeln", "Anordnen", FlipHorizontal2, () => void bildUmformen("waagerecht"), { aktiv: mitBild, stichworte: ["spiegeln"] }),
  b("senkrecht", "Senkrecht spiegeln", "Anordnen", FlipVertical2, () => void bildUmformen("senkrecht"), { aktiv: mitBild, stichworte: ["spiegeln"] }),
  b("duplizieren", "Duplizieren", "Anordnen", Copy, () => void bildUmformen("duplizieren"), { aktiv: mitBild, stichworte: ["kopie", "verdoppeln"] }),

  b("a_links", "Links ausrichten", "Ausrichten", AlignStartVertical, () => ausrichten("links"), { aktiv: mitAuswahl }),
  b("a_zentriert", "Horizontal zentrieren", "Ausrichten", AlignCenterVertical, () => ausrichten("zentriert"), { aktiv: mitAuswahl, stichworte: ["mittig"] }),
  b("a_rechts", "Rechts ausrichten", "Ausrichten", AlignEndVertical, () => ausrichten("rechts"), { aktiv: mitAuswahl }),
  b("a_oben", "Oben ausrichten", "Ausrichten", AlignStartHorizontal, () => ausrichten("oben"), { aktiv: mitAuswahl }),
  b("a_mitte", "Vertikal zentrieren", "Ausrichten", AlignCenterHorizontal, () => ausrichten("mitte"), { aktiv: mitAuswahl, stichworte: ["mittig"] }),
  b("a_unten", "Unten ausrichten", "Ausrichten", AlignEndHorizontal, () => ausrichten("unten"), { aktiv: mitAuswahl }),

  b("ueberschrift", "Überschrift", "Textbausteine", Heading, () => textbaustein("ueberschrift"), { gross: true, farbe: "#B5121B", stichworte: ["titel", "headline"] }),
  b("hinweis", "Hinweisbox", "Textbausteine", TriangleAlert, () => textbaustein("hinweis"), { farbe: "#D9A300", stichworte: ["achtung", "wichtig"] }),
  b("preis", "Preisbox", "Textbausteine", BadgeEuro, () => textbaustein("preis"), { farbe: "#107C41", stichworte: ["beitrag", "angebot", "euro"] }),
  b("info", "Infokasten", "Textbausteine", Info, () => textbaustein("info"), { stichworte: ["kasten"] }),

  b("deckblatt", "Deckblatt", "Seiten gestalten", BookOpen, () => mitDok("deckblatt"), {
    gross: true,
    stichworte: ["titelseite", "angebot", "präsentation", "cover"],
    beschreibung: "Gestaltetes Deckblatt mit Titel, Kunde, Logo und Hausfarben vor das Dokument setzen.",
  }),
  b("inhaltsverzeichnis", "Inhalts­verzeichnis", "Seiten gestalten", ListOrdered, () => void inhaltsverzeichnis(), {
    stichworte: ["toc", "verzeichnis", "lesezeichen"],
    beschreibung: "Verzeichnis mit klickbaren Einträgen aus den Lesezeichen als erste Seite einfügen.",
  }),
  b("briefpapier", "Briefpapier", "Seiten gestalten", FileText, () => mitDok("briefpapier"), {
    gross: true,
    stichworte: ["briefkopf", "hintergrund", "vorlage", "layout"],
    beschreibung: "Briefpapier (PDF) unter die Seiten legen – eigene Vorlage für Seite 1 und Folgeseiten.",
  }),

  b("hausfarben", "Hausfarben", "Farben", Palette, () => setzen({ dialog: { art: "hausfarben" } }), {
    gross: true,
    aktiv: () => true,
    farbe: "#D35400",
    stichworte: ["farben", "corporate design", "palette"],
  }),

  b("ki_bild", "KI-Bild", "KI", Sparkles, () => undefined, {
    aktiv: () => false,
    farbe: LILA,
    stichworte: ["generativ", "künstliche intelligenz"],
    beschreibung: "Bilder per KI erzeugen – kommt in einer späteren Version.",
  }),
  b("ki_text", "KI-Text", "KI", LayoutTemplate, () => undefined, {
    aktiv: () => false,
    farbe: LILA,
    stichworte: ["generativ", "formulieren"],
    beschreibung: "Texte per KI formulieren lassen – kommt in einer späteren Version.",
  }),
);
