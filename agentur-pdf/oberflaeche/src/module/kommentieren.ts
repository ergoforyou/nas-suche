// Register „Kommentieren“ und „Bearbeiten“: Werkzeuge für Anmerkungen,
// Schreibmaschine, Bilder/Unterschriften, Stempel, Fotos, Formulare.

import {
  ArrowUpRight,
  Droplet,
  PanelTop,
  Camera,
  CheckSquare,
  ChevronDownSquare,
  Circle,
  EyeOff,
  FilePenLine,
  Highlighter,
  ImagePlus,
  Info,
  List,
  ListTodo,
  Minus,
  MousePointer2,
  PenLine,
  RectangleHorizontal,
  Signature,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
  Waves,
} from "lucide-react";
import { registrieren, type Befehl } from "../befehle/register";
import type { Werkzeug } from "../typen";
import { gruppeUmschalten } from "../zustand/anmerkungen";
import { holen, melden, setzen, werkzeugWaehlen, type Zustand } from "../zustand/store";

const mitDokument = (z: Zustand) => z.aktiv !== null;

function werkzeug(id: Werkzeug, titel: string, register: Befehl["register"], gruppe: string, icon: Befehl["icon"], extra: Partial<Befehl> = {}): Befehl {
  return {
    id: `werkzeug.${id}`,
    titel,
    register,
    gruppe,
    icon,
    ausfuehren: () => werkzeugWaehlen(id),
    aktiv: mitDokument,
    gewaehlt: (z) => z.werkzeug === id,
    ...extra,
  };
}

function dialog(art: "bild" | "foto" | "eigenschaften", extra: Record<string, unknown> = {}): void {
  const d = holen().aktiv;
  if (!d) {
    melden("Kein Dokument geöffnet.");
    return;
  }
  if (art === "foto") setzen({ dialog: { art: "foto", dokId: d, seite: null } });
  else if (art === "bild") setzen({ dialog: { art: "bild", dokId: d, unterschrift: Boolean(extra.unterschrift) } });
  else setzen({ dialog: { art: "eigenschaften", dokId: d } });
}

registrieren(
  // ------------------------------------------------------------ Kommentieren
  werkzeug("hervorheben", "Hervorheben", "kommentieren", "Text markieren", Highlighter, {
    gross: true,
    kuerzel: "M",
    stichworte: ["markieren", "textmarker", "gelb", "highlight"],
    beschreibung: "Text mit der Maus überstreichen – wird farbig hervorgehoben.",
  }),
  werkzeug("unterstreichen", "Unterstreichen", "kommentieren", "Text markieren", Underline, { stichworte: ["linie unter text"] }),
  werkzeug("durchstreichen", "Durchstreichen", "kommentieren", "Text markieren", Strikethrough, { stichworte: ["streichen", "löschen markieren"] }),
  werkzeug("wellenlinie", "Wellenlinie", "kommentieren", "Text markieren", Waves, { stichworte: ["schlangenlinie", "fehler"] }),
  werkzeug("textauswahl", "Text auswählen", "kommentieren", "Text markieren", MousePointer2, {
    kuerzel: "V",
    stichworte: ["kopieren", "markieren", "auswahl", "text kopieren"],
    beschreibung: "Text markieren, um ihn zu kopieren, hervorzuheben oder zu schwärzen.",
  }),
  werkzeug("notiz", "Notiz", "kommentieren", "Kommentar", StickyNote, {
    gross: true,
    stichworte: ["kommentar", "haftnotiz", "anmerkung", "sticky"],
    beschreibung: "Klick auf die Seite setzt eine Notiz mit Text.",
  }),
  werkzeug("textfeld", "Textfeld", "kommentieren", "Kommentar", RectangleHorizontal, {
    gross: true,
    stichworte: ["textbox", "kasten", "kommentar mit rahmen"],
    beschreibung: "Rechteck aufziehen und Text mit Rahmen eintragen.",
  }),
  werkzeug("rechteck", "Rechteck", "kommentieren", "Zeichnen", Square, { stichworte: ["form", "kasten", "umranden"] }),
  werkzeug("ellipse", "Ellipse", "kommentieren", "Zeichnen", Circle, { stichworte: ["kreis", "einkreisen", "form"] }),
  werkzeug("linie", "Linie", "kommentieren", "Zeichnen", Minus, { stichworte: ["strich", "gerade"], beschreibung: "Umschalt = 45°-Schritte" }),
  werkzeug("pfeil", "Pfeil", "kommentieren", "Zeichnen", ArrowUpRight, { stichworte: ["hinweis", "zeigen"], beschreibung: "Umschalt = 45°-Schritte" }),
  werkzeug("freihand", "Freihand", "kommentieren", "Zeichnen", PenLine, { stichworte: ["zeichnen", "stift", "malen", "kritzeln", "ink"] }),
  werkzeug("stempel", "Stempel", "kommentieren", "Stempel", Stamp, {
    gross: true,
    stichworte: ["eingegangen", "erledigt", "gebucht", "datum", "kürzel", "kopie"],
    beschreibung: "Stempel mit Datum und Kürzel – Vorlage in der Leiste darunter wählen.",
  }),
  {
    id: "stempel.verwalten",
    titel: "Stempel verwalten",
    register: "kommentieren",
    gruppe: "Stempel",
    icon: ListTodo,
    stichworte: ["stempel bearbeiten", "eigener stempel", "vorlagen"],
    ausfuehren: () => setzen({ dialog: { art: "stempel" } }),
  },
  {
    id: "kommentare.liste",
    titel: "Kommentarliste",
    register: "kommentieren",
    gruppe: "Anzeigen",
    icon: ListTodo,
    gross: true,
    stichworte: ["alle kommentare", "übersicht", "anmerkungen"],
    beschreibung: "Alle Kommentare und Eintragungen des Dokuments in der Seitenleiste.",
    ausfuehren: () => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, offen: true, panel: "kommentare" } })),
    gewaehlt: (z) => z.seitenleiste.offen && z.seitenleiste.panel === "kommentare",
  },
  {
    id: "kommentare.ausblenden",
    titel: "Kommentare ausblenden",
    register: "kommentieren",
    gruppe: "Anzeigen",
    icon: EyeOff,
    stichworte: ["verstecken", "anzeigen", "einblenden"],
    ausfuehren: () => gruppeUmschalten("kommentar"),
    gewaehlt: (z) => z.ausblenden.includes("kommentar"),
  },
  // -------------------------------------------------------------- Bearbeiten
  werkzeug("textbearbeiten", "Text bearbeiten", "bearbeiten", "Text", FilePenLine, {
    gross: true,
    farbe: "#1F5BAA",
    stichworte: ["text ändern", "korrigieren", "tippfehler", "betrag ändern", "pdf text bearbeiten", "edit", "überschreiben"],
    beschreibung: "Vorhandenen Text im PDF ändern: Zeile anklicken, tippen, Enter. Schrift, Größe und Farbe bleiben erhalten.",
  }),
  werkzeug("schreibmaschine", "Text eintragen", "bearbeiten", "Text", Type, {
    gross: true,
    kuerzel: "S",
    stichworte: ["schreibmaschine", "typewriter", "ausfüllen", "text hinzufügen", "schreiben"],
    beschreibung: "Auf die Seite klicken und lostippen – mit Rechtschreibprüfung.",
  }),
  {
    id: "formular.hinweis",
    titel: "Formular ausfüllen",
    register: "bearbeiten",
    gruppe: "Formular",
    icon: TextCursorInput,
    gross: true,
    stichworte: ["formularfelder", "felder", "ankreuzen", "antrag"],
    beschreibung: "Formularfelder sind hellblau hinterlegt und direkt ausfüllbar. Ohne Felder: „Text eintragen“ nutzen.",
    ausfuehren: () => {
      const z = holen();
      const d = z.aktiv;
      const anzahl = d ? Object.values(z.formulare[d]?.seiten ?? {}).reduce((n, l) => n + l.length, 0) : 0;
      setzen({ werkzeug: "hand" });
      melden(anzahl ? `${anzahl} Formularfelder – einfach hineinklicken und ausfüllen.` : "Dieses Dokument hat keine Formularfelder – „Text eintragen“ verwenden.");
      if (!anzahl) werkzeugWaehlen("schreibmaschine");
    },
    aktiv: mitDokument,
  },
  ...(
    [
      ["text", "Textfeld", TextCursorInput, ["eingabefeld", "formularfeld", "feld anlegen", "formular erstellen"]],
      ["ankreuzen", "Kontrollkästchen", CheckSquare, ["checkbox", "ankreuzfeld", "häkchen", "ja nein"]],
      ["auswahlliste", "Auswahlliste", ChevronDownSquare, ["dropdown", "combobox", "auswahl"]],
      ["liste", "Listenfeld", List, ["listbox", "liste"]],
      ["unterschrift", "Unterschriftsfeld", PenLine, ["signaturfeld", "online unterschreiben", "hier unterschreiben"]],
    ] as const
  ).map(
    ([typ, titel, icon, stichworte]): Befehl => ({
      id: `formular.feld_${typ}`,
      titel,
      register: "bearbeiten",
      gruppe: "Formular",
      icon,
      stichworte: [...stichworte, "formular gestalten"],
      beschreibung: `${titel} aufziehen (oder klicken). Felder lassen sich danach verschieben, in der Größe ändern und rechts einstellen.`,
      ausfuehren: () => {
        const z = holen();
        if (z.werkzeug === "formular" && z.formularTyp === typ) {
          setzen({ werkzeug: "hand", formularAuswahl: null });
          return;
        }
        setzen({ werkzeug: "formular", formularTyp: typ, anmAuswahl: null, rechtsOffen: true });
      },
      aktiv: mitDokument,
      gewaehlt: (z) => z.werkzeug === "formular" && z.formularTyp === typ,
    }),
  ),
  {
    id: "bild.einfuegen",
    titel: "Bild einfügen",
    register: "bearbeiten",
    gruppe: "Bilder",
    icon: ImagePlus,
    gross: true,
    stichworte: ["foto", "logo", "png", "freistellen", "grafik"],
    beschreibung: "Bild auf der Seite platzieren – auf Wunsch mit entferntem Hintergrund.",
    ausfuehren: () => dialog("bild"),
    aktiv: mitDokument,
  },
  {
    id: "bild.unterschrift",
    titel: "Unterschrift",
    register: "bearbeiten",
    gruppe: "Bilder",
    icon: Signature,
    gross: true,
    stichworte: ["signatur", "unterschreiben", "freistellen", "transparent"],
    beschreibung: "Gespeicherte Unterschrift einfügen oder neue aus einem Bild freistellen.",
    ausfuehren: () => dialog("bild", { unterschrift: true }),
    aktiv: mitDokument,
  },
  {
    id: "foto.aufbereiten",
    titel: "Foto aufbereiten",
    register: "bearbeiten",
    gruppe: "Bilder",
    icon: Camera,
    gross: true,
    stichworte: ["handyfoto", "entzerren", "zuschneiden", "whatsapp", "schatten", "gerade"],
    beschreibung: "Abfotografiertes Dokument entzerren, zuschneiden und Schatten entfernen.",
    ausfuehren: () => {
      const d = holen().aktiv;
      setzen({ dialog: { art: "foto", dokId: d, seite: null } });
    },
  },
  werkzeug("abdecken", "Abdecken", "bearbeiten", "Abdecken", Square, {
    gross: true,
    stichworte: ["weißen", "überdecken", "korrektur", "tipp-ex", "whiteout"],
    beschreibung: "Bereich weiß überdecken (z. B. um danach neu zu beschriften). Zum sicheren Entfernen: Schwärzen.",
  }),
  {
    id: "seitengestaltung.wasserzeichen",
    titel: "Wasserzeichen",
    register: "bearbeiten",
    gruppe: "Seitengestaltung",
    icon: Droplet,
    gross: true,
    farbe: "#C0262D",
    stichworte: ["kopie", "entwurf", "vertraulich", "muster", "hintergrundtext"],
    beschreibung: "Großen, halbtransparenten Text (z. B. KOPIE) über die Seiten legen – auf eigener Ebene.",
    ausfuehren: () => {
      const d = holen().aktiv;
      if (d) setzen({ dialog: { art: "wasserzeichen", dokId: d } });
    },
    aktiv: mitDokument,
  },
  {
    id: "seitengestaltung.kopffuss",
    titel: "Kopf-/Fußzeile",
    register: "bearbeiten",
    gruppe: "Seitengestaltung",
    icon: PanelTop,
    gross: true,
    farbe: "#1F5BAA",
    stichworte: ["seitenzahlen", "nummerieren", "paginieren", "seite von", "fußzeile", "kopfzeile", "datum"],
    beschreibung: "Seitenzahlen, Datum oder Dateiname oben/unten auf die Seiten setzen.",
    ausfuehren: () => {
      const d = holen().aktiv;
      if (d) setzen({ dialog: { art: "kopffuss", dokId: d } });
    },
    aktiv: mitDokument,
  },
  {
    id: "dokument.eigenschaften",
    titel: "Eigenschaften",
    register: "bearbeiten",
    gruppe: "Dokument",
    icon: Info,
    gross: true,
    stichworte: ["titel", "autor", "metadaten", "dokumentinfo"],
    ausfuehren: () => dialog("eigenschaften"),
    aktiv: mitDokument,
  },
);
