// Lädt Seitenbilder vom Dienst mit Prioritäten, begrenzter Parallelität und
// einem Speicher-Cache. Seiten, die vor dem Laden wieder aus dem Bild
// gescrollt werden, werden abgebrochen – so bleibt Scrollen flüssig, auch bei
// 150+ Seiten.

import { bildLaden } from "../api";

const MAX_PARALLEL = 4;
const MAX_CACHE = 600; // Anzahl Bilder (Objekt-URLs)

interface Auftrag {
  url: string;
  prioritaet: number; // kleiner = wichtiger
  abbruch: AbortController;
  wartende: Set<(url: string | null) => void>;
  gestartet: boolean;
}

const cache = new Map<string, string>(); // Anfrage-URL → Objekt-URL
const auftraege = new Map<string, Auftrag>();
let laufend = 0;

function cacheSetzen(url: string, objektUrl: string): void {
  cache.set(url, objektUrl);
  if (cache.size > MAX_CACHE) {
    const aeltester = cache.keys().next().value as string;
    URL.revokeObjectURL(cache.get(aeltester)!);
    cache.delete(aeltester);
  }
}

export function ausCache(url: string): string | null {
  const treffer = cache.get(url);
  if (treffer) {
    cache.delete(url); // LRU: ans Ende
    cache.set(url, treffer);
  }
  return treffer ?? null;
}

function pumpen(): void {
  while (laufend < MAX_PARALLEL) {
    let naechster: Auftrag | null = null;
    for (const a of auftraege.values()) {
      if (!a.gestartet && (!naechster || a.prioritaet < naechster.prioritaet)) naechster = a;
    }
    if (!naechster) return;
    const auftrag = naechster;
    auftrag.gestartet = true;
    laufend++;
    bildLaden(auftrag.url, auftrag.abbruch.signal)
      .then((blob) => {
        const objektUrl = URL.createObjectURL(blob);
        cacheSetzen(auftrag.url, objektUrl);
        auftrag.wartende.forEach((w) => w(objektUrl));
      })
      .catch(() => auftrag.wartende.forEach((w) => w(null)))
      .finally(() => {
        laufend--;
        auftraege.delete(auftrag.url);
        pumpen();
      });
  }
}

/**
 * Fordert ein Bild an. Rückgabe: Funktion zum Abbestellen. ``fertig`` wird
 * mit der Objekt-URL (oder null bei Fehler) aufgerufen.
 *
 * ``verzoegerung`` (ms): Der Auftrag wird erst gestellt, wenn er so lange nicht
 * abbestellt wurde. Seiten, die beim schnellen Scrollen nur vorbeihuschen,
 * erzeugen damit gar keine Last.
 */
export function anfordern(url: string, prioritaet: number, fertig: (objektUrl: string | null) => void, verzoegerung = 0): () => void {
  const vorhanden = ausCache(url);
  if (vorhanden) {
    fertig(vorhanden);
    return () => undefined;
  }
  let abbestellen: (() => void) | null = null;
  const stellen = () => {
    let auftrag = auftraege.get(url);
    if (!auftrag) {
      auftrag = { url, prioritaet, abbruch: new AbortController(), wartende: new Set(), gestartet: false };
      auftraege.set(url, auftrag);
    } else {
      auftrag.prioritaet = Math.min(auftrag.prioritaet, prioritaet);
    }
    auftrag.wartende.add(fertig);
    pumpen();
    const a = auftrag;
    abbestellen = () => {
      a.wartende.delete(fertig);
      if (a.wartende.size === 0) {
        a.abbruch.abort();
        if (!a.gestartet) auftraege.delete(a.url);
      }
    };
  };
  if (verzoegerung <= 0) {
    stellen();
    return () => abbestellen?.();
  }
  const timer = window.setTimeout(stellen, verzoegerung);
  return () => {
    window.clearTimeout(timer);
    abbestellen?.();
  };
}

/** Für Tests/Diagnose */
export function statistik() {
  return { cache: cache.size, wartend: auftraege.size, laufend };
}
