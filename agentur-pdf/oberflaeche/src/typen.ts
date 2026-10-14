export interface SeitenInfo {
  breite: number; // in PDF-Punkten (1/72 Zoll), inkl. PDF-Seitendrehung
  hoehe: number;
  drehung: number;
}

export interface DokumentInfo {
  id: string;
  titel: string;
  pfad: string | null;
  version: number;
  seitenanzahl: number;
  seiten: SeitenInfo[];
  seiten_versionen: number[];
  verschluesselt: boolean;
}

export type AnsichtsModus = "einzelseite" | "fortlaufend" | "doppelseite" | "doppelseite_fortlaufend";
export type ZoomModus = "frei" | "seitenbreite" | "ganzeseite";
export type Werkzeug = "hand" | "lassozoom" | "lupe";

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

export type Seitenleistenpanel = "miniaturen" | "lesezeichen" | "suche";
