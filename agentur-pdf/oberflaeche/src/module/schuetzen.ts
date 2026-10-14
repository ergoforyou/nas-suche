// Register „Schützen“: Schwärzen, Kennwort, Metadaten, Drucken/Exportieren,
// Komprimieren, Ebenen.

import { Eraser, FileArchive, FileImage, FileOutput, FileText, KeyRound, Layers3, Printer, ScanSearch, ShieldCheck, UserX } from "lucide-react";
import { registrieren } from "../befehle/register";
import { api } from "../api";
import { aenderungAnwenden, ausgabeSpeichern } from "../zustand/ausgabe";
import { namensvorschlag } from "../zustand/seitenaktionen";
import { holen, melden, setzen, werkzeugWaehlen, type Dialog, type Zustand } from "../zustand/store";

const mitDokument = (z: Zustand) => z.aktiv !== null;

function oeffnen(dialog: (dokId: string) => Dialog): void {
  const d = holen().aktiv;
  if (!d) {
    melden("Kein Dokument geöffnet.");
    return;
  }
  setzen({ dialog: dialog(d) });
}

registrieren(
  {
    id: "werkzeug.schwaerzen",
    titel: "Bereich schwärzen",
    register: "schuetzen",
    gruppe: "Schwärzen",
    icon: Eraser,
    gross: true,
    stichworte: ["redact", "unkenntlich", "datenschutz", "dsgvo", "schwarz"],
    beschreibung: "Rechteck aufziehen – wird zum Schwärzen vorgemerkt.",
    ausfuehren: () => werkzeugWaehlen("schwaerzen"),
    aktiv: mitDokument,
    gewaehlt: (z) => z.werkzeug === "schwaerzen",
  },
  {
    id: "schwaerzen.suchen",
    titel: "Suchen & schwärzen",
    register: "schuetzen",
    gruppe: "Schwärzen",
    icon: ScanSearch,
    gross: true,
    stichworte: ["iban", "kontonummer", "e-mail", "telefon", "geburtsdatum", "dsgvo", "muster"],
    beschreibung: "IBAN, E-Mail, Telefonnummern, Datumsangaben oder eigene Begriffe finden und schwärzen.",
    ausfuehren: () => oeffnen((dokId) => ({ art: "schwaerzen", dokId })),
    aktiv: mitDokument,
  },
  {
    id: "schwaerzen.anwenden",
    titel: "Schwärzungen anwenden",
    register: "schuetzen",
    gruppe: "Schwärzen",
    icon: ShieldCheck,
    gross: true,
    stichworte: ["endgültig", "redact anwenden"],
    beschreibung: "Vorgemerkte Stellen endgültig entfernen (Text, Bild und OCR-Text darunter).",
    ausfuehren: () => {
      const d = holen().aktiv;
      if (!d) return;
      void aenderungAnwenden(api.schwaerzenAnwenden(d, true)).then(
        (r) => r && melden(`Schwärzungen auf ${r.seiten?.length ?? 0} Seite(n) angewendet – Metadaten entfernt. Bitte speichern.`),
      );
    },
    aktiv: (z) => !!z.aktiv && Object.values(z.anmerkungen[z.aktiv]?.seiten ?? {}).some((l) => l.some((a) => a.art === "schwaerzung")),
  },
  {
    id: "schutz.kennwort",
    titel: "Kennwort",
    register: "schuetzen",
    gruppe: "Schutz",
    icon: KeyRound,
    gross: true,
    stichworte: ["passwort", "verschlüsseln", "aes", "schützen", "rechte", "drucken verbieten"],
    beschreibung: "Dokument mit Kennwort (AES-256) schützen oder Rechte einschränken.",
    ausfuehren: () => oeffnen((dokId) => ({ art: "kennwort", dokId })),
    aktiv: mitDokument,
  },
  {
    id: "schutz.metadaten",
    titel: "Metadaten entfernen",
    register: "schuetzen",
    gruppe: "Schutz",
    icon: UserX,
    stichworte: ["autor", "datenschutz", "dokumentinfo", "bereinigen"],
    ausfuehren: () => {
      const d = holen().aktiv;
      if (d) void aenderungAnwenden(api.metadatenEntfernen(d)).then((r) => r && melden("Metadaten (Titel, Autor, Programme) entfernt."));
    },
    aktiv: mitDokument,
  },
  {
    id: "ausgabe.drucken",
    titel: "Drucken",
    register: "schuetzen",
    gruppe: "Ausgabe",
    icon: Printer,
    gross: true,
    kuerzel: "Strg+P",
    stichworte: ["drucker", "ausdrucken", "ohne kommentare", "print"],
    beschreibung: "Drucken – wahlweise ohne Kommentare, Stempel oder Ebenen.",
    ausfuehren: () => oeffnen((dokId) => ({ art: "druck", dokId, export: false })),
    aktiv: mitDokument,
  },
  {
    id: "ausgabe.exportieren",
    titel: "Exportieren",
    register: "schuetzen",
    gruppe: "Ausgabe",
    icon: FileOutput,
    gross: true,
    stichworte: ["kopie", "ohne kommentare", "ebenen", "ausgeblendet", "versenden"],
    beschreibung: "PDF-Kopie ohne Kommentare oder mit ausgeblendeten Ebenen speichern.",
    ausfuehren: () => oeffnen((dokId) => ({ art: "druck", dokId, export: true })),
    aktiv: mitDokument,
  },
  {
    id: "ausgabe.komprimieren",
    titel: "Komprimieren",
    register: "schuetzen",
    gruppe: "Ausgabe",
    icon: FileArchive,
    gross: true,
    stichworte: ["verkleinern", "dateigröße", "e-mail", "optimieren", "kleiner"],
    ausfuehren: () => oeffnen((dokId) => ({ art: "komprimieren", dokId })),
    aktiv: mitDokument,
  },
  {
    id: "ausgabe.bilder",
    titel: "Seiten als Bilder",
    register: "schuetzen",
    gruppe: "Ausgabe",
    icon: FileImage,
    stichworte: ["png", "jpg", "exportieren", "bild speichern"],
    ausfuehren: () => oeffnen((dokId) => ({ art: "bilderexport", dokId })),
    aktiv: mitDokument,
  },
  {
    id: "ausgabe.text",
    titel: "Text exportieren",
    register: "schuetzen",
    gruppe: "Ausgabe",
    icon: FileText,
    stichworte: ["txt", "nur text", "kopieren"],
    ausfuehren: () => {
      const d = holen().dokumente.find((x) => x.id === holen().aktiv);
      if (!d) return;
      void ausgabeSpeichern(namensvorschlag(d).replace(/\.pdf$/i, ".txt"), async (pfad) =>
        pfad ? api.textSpeichern(d.id, pfad) : { url: `/api/dokumente/${d.id}/text` },
      );
    },
    aktiv: mitDokument,
  },
  {
    id: "ebenen.anzeigen",
    titel: "Ebenen",
    register: "schuetzen",
    gruppe: "Ebenen",
    icon: Layers3,
    gross: true,
    stichworte: ["layer", "ocg", "einblenden", "ausblenden", "ocr-text"],
    beschreibung: "Ebenen und Anmerkungsgruppen ein- und ausblenden.",
    ausfuehren: () => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, offen: true, panel: "ebenen" } })),
    gewaehlt: (z) => z.seitenleiste.offen && z.seitenleiste.panel === "ebenen",
  },
);
