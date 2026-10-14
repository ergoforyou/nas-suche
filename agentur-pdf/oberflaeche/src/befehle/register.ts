// Befehlsregister: jede Funktion wird genau einmal registriert. Menüband,
// Rechtsklick-Menüs, Tastenkürzel und die Befehlssuche (Strg+K) speisen sich
// alle daraus – so kann keine Funktion „irgendwo versteckt“ verloren gehen.

import type { LucideIcon } from "lucide-react";
import type { Zustand } from "../zustand/store";

export interface Befehl {
  id: string;
  titel: string;
  register: RegisterId;
  gruppe: string;
  icon: LucideIcon;
  /** große Schaltfläche im Menüband (sonst klein bzw. nur in „Mehr“/Suche) */
  gross?: boolean;
  /** nur über Befehlssuche/„Mehr“ erreichbar */
  versteckt?: boolean;
  kuerzel?: string; // Anzeige, z. B. "Strg+O"
  stichworte?: string[];
  beschreibung?: string;
  ausfuehren: () => void;
  aktiv?: (z: Zustand) => boolean; // ausgegraut, wenn false (z. B. kein Dokument)
  gewaehlt?: (z: Zustand) => boolean; // als „eingedrückt“ darstellen
}

export type RegisterId = "start" | "seiten" | "kommentieren" | "bearbeiten" | "konvertieren" | "schuetzen";

export const REGISTER: { id: RegisterId; titel: string; geplant?: string }[] = [
  { id: "start", titel: "Start" },
  { id: "seiten", titel: "Seiten" },
  { id: "kommentieren", titel: "Kommentieren" },
  { id: "bearbeiten", titel: "Bearbeiten" },
  { id: "konvertieren", titel: "Konvertieren" },
  { id: "schuetzen", titel: "Schützen" },
];

const befehle = new Map<string, Befehl>();

export function registrieren(...neu: Befehl[]): void {
  for (const b of neu) befehle.set(b.id, b);
}

export function alleBefehle(): Befehl[] {
  return [...befehle.values()];
}

export function befehl(id: string): Befehl | undefined {
  return befehle.get(id);
}

export function ausfuehren(id: string): void {
  befehle.get(id)?.ausfuehren();
}

/** Unscharfe Suche: alle Wörter müssen in Titel/Stichworten/Register vorkommen. */
export function befehleSuchen(eingabe: string): Befehl[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss");
  const woerter = norm(eingabe).split(/\s+/).filter(Boolean);
  const liste = alleBefehle();
  if (!woerter.length) return liste;
  const bewertet: { b: Befehl; punkte: number }[] = [];
  for (const b of liste) {
    const titel = norm(b.titel);
    const heuhaufen = norm([b.titel, ...(b.stichworte ?? []), b.gruppe, REGISTER.find((r) => r.id === b.register)?.titel ?? ""].join(" "));
    if (!woerter.every((w) => heuhaufen.includes(w))) continue;
    let punkte = 0;
    if (titel.startsWith(woerter[0])) punkte += 10;
    if (titel.includes(woerter[0])) punkte += 5;
    bewertet.push({ b, punkte });
  }
  return bewertet.sort((a, b) => b.punkte - a.punkte).map((x) => x.b);
}
