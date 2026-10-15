export interface SeitenInfo {
  breite: number; // in PDF-Punkten (1/72 Zoll), inkl. PDF-Seitendrehung
  hoehe: number;
  drehung: number;
}

export interface DokumentInfo {
  id: string;
  titel: string;
  pfad: string | null;
  /** Vorschlag für „Speichern unter“ (Ordner der Quelldateien) */
  ordner: string | null;
  version: number;
  seitenanzahl: number;
  seiten: SeitenInfo[];
  /** je Seite eindeutige Kennung (Seiten-ID + Inhaltsversion) für Bild-URLs */
  kennungen: string[];
  verschluesselt: boolean;
  /** Kennwortschutz, der beim Speichern gilt */
  schutz?: "keiner" | "kennwort" | "rechte";
  geaendert: boolean;
  /** Datei ist gerade bei jemand anderem geöffnet (Sperrdatei auf dem NAS) */
  gesperrt_von?: Sperrinhaber | null;
  rueckgaengig: string | null; // Name des Schritts, der rückgängig gemacht würde
  wiederholen: string | null;
}

export interface Sperrinhaber {
  benutzer: string;
  rechner: string;
  kuerzel?: string;
  seit?: string;
}

/** Sicherung ungespeicherter Änderungen aus einem früheren Programmlauf */
export interface Wiederherstellung {
  schluessel: string;
  titel: string;
  pfad: string | null;
  ordner: string | null;
  seiten: number;
  zeit: string;
  groesse: number;
}

/** Antwort des Dienstes auf Seitenoperationen */
export interface Aenderungsantwort {
  dokumente: DokumentInfo[];
  neu: DokumentInfo[];
  id?: number;
  anzahl?: number;
  seiten?: number[];
  vorher?: number;
  nachher?: number;
  geaendert?: boolean;
  auswahl?: number[];
  dateien?: string[];
  teile?: number;
  pfad?: string;
}

export type AnsichtsModus = "einzelseite" | "fortlaufend" | "doppelseite" | "doppelseite_fortlaufend";
export type ZoomModus = "frei" | "seitenbreite" | "ganzeseite";
export type Werkzeug =
  | "hand"
  | "lassozoom"
  | "lupe"
  | "textbereich"
  | "textauswahl"
  | "hervorheben"
  | "unterstreichen"
  | "durchstreichen"
  | "wellenlinie"
  | "notiz"
  | "textfeld"
  | "schreibmaschine"
  | "rechteck"
  | "ellipse"
  | "linie"
  | "pfeil"
  | "freihand"
  | "stempel"
  | "platzieren"
  | "abdecken"
  | "schwaerzen";

export type Gruppe = "kommentar" | "eintragung" | "stempel" | "schwaerzung";
export type Rechteck = [number, number, number, number];
export type Punkt = [number, number];

/** Anmerkung (Kommentar, Eintragung, Stempel, Schwärzung) – Koordinaten normiert */
export interface Anmerkung {
  id: number;
  /** Kennung der Darstellung (ändert sich bei jeder Änderung) */
  v: string;
  seite: number;
  art: string;
  pdf_art: string;
  gruppe: Gruppe;
  rechteck: Rechteck;
  farbe: string | null;
  fuellung: string | null;
  breite: number;
  deckkraft: number;
  inhalt: string;
  autor: string;
  datum: string;
  ausgeblendet: boolean;
  schriftgroesse?: number;
  textfarbe?: string;
  text?: string;
  punkte?: Punkt[];
  striche?: Punkt[][];
  rechtecke?: Rechteck[];
  text_darunter?: string;
}

/** Wort auf einer Seite: x0, y0, x1, y1, Text, Block, Zeile */
export type Wort = [number, number, number, number, string, number, number];

export interface Stil {
  farbe: string;
  fuellung: string | null;
  breite: number;
  deckkraft: number;
  schriftgroesse: number;
}

export interface StempelVorlage {
  text: string;
  farbe: string;
}

export interface Formularfeld {
  id: number;
  name: string;
  typ: "text" | "ankreuzen" | "auswahlknopf" | "auswahlliste" | "liste";
  rechteck: Rechteck;
  wert: string | boolean;
  nur_lesen: boolean;
  mehrzeilig: boolean;
  schriftgroesse: number;
  max_laenge: number;
  optionen?: string[];
}

export interface Ebene {
  id: number;
  name: string;
  an: boolean;
}

export interface BildDaten {
  id: string;
  original_id?: string;
  breite: number;
  hoehe: number;
  bild: string;
}

export interface Unterschrift {
  id: string;
  name: string;
  breite: number;
  hoehe: number;
  bild: string;
}

export interface RsFehler {
  start: number;
  ende: number;
  wort: string;
}

export interface Ansicht {
  modus: AnsichtsModus;
  zoom: number; // 1 = 100 % (Originalgröße)
  zoomModus: ZoomModus;
  drehung: number; // reine Ansichtsdrehung: 0, 90, 180, 270
  seite: number; // aktuelle Seite (0-basiert)
  scrollX: number;
  scrollY: number;
}

export interface Dokument extends DokumentInfo {
  ansicht: Ansicht;
  /** markierte Seiten in der Miniaturleiste (0-basiert, sortiert) */
  auswahl: number[];
}

export interface Treffer {
  dokId: string;
  seite: number;
  rechteck: [number, number, number, number]; // normiert 0..1
  ausschnitt: string;
}

export interface Lesezeichen {
  ebene: number;
  titel: string;
  seite: number;
}

export interface Einstellungen {
  design: "hell" | "dunkel" | "system";
  akzentfarbe: string;
  kuerzel: string;
  standard_ansicht: AnsichtsModus;
  standard_zoom: ZoomModus;
  miniatur_groesse: number;
  seitenleiste_breite: number;
  ocr_sprachen: string;
  stempel: StempelVorlage[];
  screenshot_aktiv: boolean;
  screenshot_taste: string;
  screenshot_ordner: string;
  screenshot_ocr: boolean;
  screenshot_text_kopieren: boolean;
  screenshot_bild_kopieren: boolean;
  werkzeug_stile: Record<string, Partial<Stil>>;
  /** Ordner für gemeinsame Einstellungen aller Arbeitsplätze (NAS) */
  gemeinsamer_ordner: string;
}

export interface UpdateInfo {
  verfuegbar: boolean;
  grund?: "kein_ordner" | "nicht_erreichbar" | "aktuell";
  version?: string;
  pfad?: string;
  ordner?: string;
  aktuelle_version: string;
  installierbar: boolean;
}

export interface WindowsStatus {
  windows: boolean;
  registriert: boolean;
  standard: boolean;
}

export interface GemeinsamStatus {
  aktiv: boolean;
  ordner: string;
  erreichbar: boolean;
  fehler: string | null;
  schluessel: string[];
}

export interface ZuletztEintrag {
  pfad: string;
  titel: string;
  seiten: number;
  zeit: string;
  vorhanden: boolean;
}

export interface OrdnerInhalt {
  pfad: string;
  eltern: string;
  ordner: { name: string; pfad: string }[];
  dateien: { name: string; pfad: string; groesse: number; geaendert: number }[];
}

export interface Sitzung {
  dokumente: { pfad: string; seite: number; zoom: number; zoomModus: ZoomModus; modus: AnsichtsModus }[];
  aktiv: number | null;
}

export type Seitenleistenpanel = "miniaturen" | "lesezeichen" | "suche" | "kommentare" | "ebenen";

export interface Auftrag {
  id: string;
  titel: string;
  status: "wartet" | "laeuft" | "fertig" | "fehler" | "abgebrochen";
  fortschritt: number;
  schritt: string;
  fehler: string;
  ergebnis: {
    dokumente?: string[];
    dateien?: string[];
    oeffnen?: boolean;
    aktualisieren?: boolean;
    ocr?: OcrStatistik;
    // Stapelverarbeitung
    stapel?: boolean;
    anzahl?: number;
    fehler?: { datei: string; fehler: string }[];
    groesse_vorher?: number;
    groesse?: number;
  };
}

export interface StapelOptionen {
  texterkennung: boolean;
  sprachen: string;
  leerseiten_entfernen: boolean;
  metadaten_entfernen: boolean;
  komprimieren: "" | "gering" | "mittel" | "stark" | "maximal";
  ausgabe: "ordner" | "daneben" | "ersetzen";
  zielordner: string;
  namensmuster: string;
}

export type Ereignis =
  | { art: "auftrag"; auftrag: Auftrag }
  | { art: "zusammenfuehren"; dateien: string[] }
  | { art: "oeffnen"; dokumente: string[] }
  | { art: "meldung"; text: string }
  | { art: "info"; text: string }
  | { art: "screenshot"; png: string; pdf: string | null; text: string }
  | { art: "sperre_frei"; dokId: string; titel: string };

export interface OcrStatistik {
  erkannt: number;
  uebersprungen: number;
  seiten: number;
  woerter: number;
  unsicher: number;
  gedreht: number;
  sicherheit: number;
}

export interface OcrStatus {
  verfuegbar: boolean;
  sprachen: string[];
  beste_modelle: boolean;
  woerterbuch: boolean;
}

export interface OrdnerRegel {
  ordner: string;
  ziel: string;
  original_sichern: boolean;
  leerseiten_entfernen: boolean;
  aktiv: boolean;
}

export interface UeberwachungsProtokoll {
  datei: string;
  ordner: string;
  zeit: number;
  ok: boolean;
  fehler?: string;
  erkannt?: number;
  leerseiten_entfernt?: number;
}

/** Eintrag im Zusammenführen-Dialog: Datei auf dem PC (Pfad) oder hochgeladen */
export interface ZfEintrag {
  schluessel: string;
  name: string;
  pfad?: string;
  upload?: string;
  laedt?: boolean;
}
