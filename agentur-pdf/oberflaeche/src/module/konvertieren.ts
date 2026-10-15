// Register „Konvertieren“: Zusammenführen, In PDF umwandeln, Als PDF speichern.

import { Camera, FileDown, FileInput, FolderSync, Layers, ScanText, TextSelect, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { registrieren } from "../befehle/register";
import { umwandelnDialog, zusammenfuehrenOeffnen } from "../zustand/konvertieren";
import { speichernUnter } from "../zustand/seitenaktionen";
import { ocrDialog, unsicherUmschalten } from "../zustand/ocr";
import { melden, setzen, werkzeugWaehlen } from "../zustand/store";

registrieren(
  {
    id: "konvertieren.zusammenfuehren",
    titel: "Zusammen\u00ADführen",
    register: "konvertieren",
    gruppe: "PDF erstellen",
    icon: Layers,
    gross: true,
    stichworte: ["zusammenfügen", "kombinieren", "mehrere dateien", "eine pdf", "merge", "word", "bilder", "mail"],
    beschreibung: "Mehrere Dateien (PDF, Bilder, Word, Excel, E-Mails …) zu einer PDF zusammenführen.",
    ausfuehren: () => zusammenfuehrenOeffnen([]),
  },
  {
    id: "konvertieren.umwandeln",
    titel: "In PDF umwandeln",
    register: "konvertieren",
    gruppe: "PDF erstellen",
    icon: FileInput,
    gross: true,
    stichworte: ["konvertieren", "word in pdf", "excel in pdf", "bild in pdf", "mail in pdf", "msg", "eml"],
    beschreibung: "Word, Excel, Bilder oder E-Mails in PDF umwandeln – die PDF wird neben die Originaldatei gelegt.",
    ausfuehren: () => void umwandelnDialog(),
  },
  {
    id: "konvertieren.als_pdf_speichern",
    titel: "Als PDF speichern",
    register: "konvertieren",
    gruppe: "Ausgabe",
    icon: FileDown,
    gross: true,
    stichworte: ["exportieren", "speichern unter", "kopie"],
    beschreibung: "Das aktuelle Dokument als PDF-Datei speichern.",
    ausfuehren: () => void speichernUnter(),
    aktiv: (z) => z.aktiv !== null,
  },
  // -------------------------------------------------------- Texterkennung
  {
    id: "ocr.dokument",
    titel: "Text\u00ADerkennung",
    register: "konvertieren",
    gruppe: "Texterkennung (OCR)",
    icon: ScanText,
    gross: true,
    stichworte: ["ocr", "durchsuchbar", "scan", "text erkennen", "texterkennung"],
    beschreibung: "Gescannte Seiten durchsuchbar machen – das Seitenbild bleibt unverändert.",
    ausfuehren: () => ocrDialog(),
    aktiv: (z) => z.aktiv !== null,
  },
  {
    id: "ocr.bereich",
    titel: "Text aus Bereich",
    register: "konvertieren",
    gruppe: "Texterkennung (OCR)",
    icon: TextSelect,
    gross: true,
    kuerzel: "T",
    stichworte: ["ocr", "kopieren", "ausschnitt", "rechteck", "text kopieren", "screenshot"],
    beschreibung: "Rechteck aufziehen – der Text darin wird erkannt und in die Zwischenablage kopiert.",
    ausfuehren: () => werkzeugWaehlen("textbereich"),
    aktiv: (z) => z.aktiv !== null,
    gewaehlt: (z) => z.werkzeug === "textbereich",
  },
  {
    id: "ocr.unsicher",
    titel: "Unsichere Wörter zeigen",
    register: "konvertieren",
    gruppe: "Texterkennung (OCR)",
    icon: TriangleAlert,
    stichworte: ["ocr", "prüfen", "qualität", "fehler"],
    beschreibung: "Markiert Wörter, bei denen die Texterkennung unsicher war.",
    ausfuehren: () => void unsicherUmschalten(),
    aktiv: (z) => z.aktiv !== null,
    gewaehlt: (z) => !!(z.aktiv && z.unsicher[z.aktiv]),
  },
  {
    id: "ocr.ueberwachung",
    titel: "Überwachungsordner",
    register: "konvertieren",
    gruppe: "Texterkennung (OCR)",
    icon: FolderSync,
    stichworte: ["scansnap", "scanner", "automatisch", "ordner", "eingang", "watch"],
    beschreibung: "Neue Scans in einem Ordner automatisch durchsuchbar machen.",
    ausfuehren: () => setzen({ dialog: { art: "ueberwachung" } }),
  },
  {
    id: "screenshot.aufnehmen",
    titel: "Screenshot",
    register: "konvertieren",
    gruppe: "Bildschirm",
    icon: Camera,
    gross: true,
    stichworte: ["bildschirmfoto", "screenshot", "sharex", "ausschnitt", "druck", "whatsapp"],
    beschreibung: "Bereich des Bildschirms aufnehmen – wird mit Texterkennung im Screenshot-Ordner abgelegt. Überall: Strg+Umschalt+Druck.",
    ausfuehren: () => {
      api.screenshotAufnehmen().catch((e: Error) => melden(e.message, "fehler"));
    },
  },
  {
    id: "screenshot.einstellungen",
    titel: "Screenshot-Einstellungen",
    register: "konvertieren",
    gruppe: "Bildschirm",
    icon: Camera,
    versteckt: true,
    stichworte: ["tastenkürzel", "screenshot ordner", "hotkey"],
    ausfuehren: () => setzen({ dialog: { art: "info" } }),
  },
);
