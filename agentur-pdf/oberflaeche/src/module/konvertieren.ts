// Register „Konvertieren“: Zusammenführen, In PDF umwandeln, Als PDF speichern.

import { FileDown, FileInput, Layers } from "lucide-react";
import { registrieren } from "../befehle/register";
import { umwandelnDialog, zusammenfuehrenOeffnen } from "../zustand/konvertieren";
import { speichernUnter } from "../zustand/seitenaktionen";

registrieren(
  {
    id: "konvertieren.zusammenfuehren",
    titel: "Zusammenführen",
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
);
