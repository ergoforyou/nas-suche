// Kommentieren & Bearbeiten – Oberflächenseite: Anmerkungen laden, anlegen,
// ändern, löschen; Werkzeugstile; Textauswahl; Formularfelder.

import { api } from "../api";
import type { Anmerkung, FormularTyp, Formularfeld, Gruppe, Rechteck, Stil, Werkzeug, Wort } from "../typen";
import { anwenden } from "./seitenaktionen";
import { holen, melden, setzen, werkzeugBenutzt, type AnmVorschau } from "./store";

export const STANDARD_STILE: Record<string, Stil> = {
  hervorheben: { farbe: "#FFE14D", fuellung: null, breite: 1, deckkraft: 1, schriftgroesse: 11 },
  unterstreichen: { farbe: "#1E6FD9", fuellung: null, breite: 1, deckkraft: 1, schriftgroesse: 11 },
  durchstreichen: { farbe: "#D92C2C", fuellung: null, breite: 1, deckkraft: 1, schriftgroesse: 11 },
  wellenlinie: { farbe: "#D92C2C", fuellung: null, breite: 1, deckkraft: 1, schriftgroesse: 11 },
  notiz: { farbe: "#F5C400", fuellung: null, breite: 1, deckkraft: 1, schriftgroesse: 11 },
  textfeld: { farbe: "#1A1A1A", fuellung: "#FFFFFF", breite: 1, deckkraft: 1, schriftgroesse: 11 },
  schreibmaschine: { farbe: "#1A1A1A", fuellung: null, breite: 0, deckkraft: 1, schriftgroesse: 11 },
  rechteck: { farbe: "#D92C2C", fuellung: null, breite: 2, deckkraft: 1, schriftgroesse: 11 },
  ellipse: { farbe: "#D92C2C", fuellung: null, breite: 2, deckkraft: 1, schriftgroesse: 11 },
  linie: { farbe: "#D92C2C", fuellung: null, breite: 2, deckkraft: 1, schriftgroesse: 11 },
  pfeil: { farbe: "#D92C2C", fuellung: null, breite: 2, deckkraft: 1, schriftgroesse: 11 },
  freihand: { farbe: "#1E3A8A", fuellung: null, breite: 1.5, deckkraft: 1, schriftgroesse: 11 },
  abdecken: { farbe: "#FFFFFF", fuellung: "#FFFFFF", breite: 0, deckkraft: 1, schriftgroesse: 11 },
  stempel: { farbe: "#C0262D", fuellung: null, breite: 2, deckkraft: 1, schriftgroesse: 16 },
};

export const FARBEN = ["#1A1A1A", "#D92C2C", "#E8730C", "#FFE14D", "#3FA34D", "#1E6FD9", "#1E3A8A", "#8E3FB5", "#FFFFFF"];

/** Werkzeuge, die auf der Seite etwas zeichnen/platzieren */
export const ZEICHENWERKZEUGE: Werkzeug[] = [
  "notiz",
  "textfeld",
  "schreibmaschine",
  "rechteck",
  "ellipse",
  "linie",
  "pfeil",
  "freihand",
  "stempel",
  "platzieren",
  "abdecken",
  "schwaerzen",
];
export const TEXTWERKZEUGE: Werkzeug[] = ["textauswahl", "hervorheben", "unterstreichen", "durchstreichen", "wellenlinie"];

export const ART_NAMEN: Record<string, string> = {
  hervorheben: "Hervorhebung",
  unterstreichen: "Unterstreichung",
  durchstreichen: "Durchstreichung",
  wellenlinie: "Wellenlinie",
  notiz: "Notiz",
  textfeld: "Textfeld",
  schreibmaschine: "Text",
  rechteck: "Rechteck",
  ellipse: "Ellipse",
  linie: "Linie",
  pfeil: "Pfeil",
  polylinie: "Linienzug",
  polygon: "Vieleck",
  freihand: "Freihand",
  stempel: "Stempel",
  bild: "Bild",
  unterschrift: "Unterschrift",
  abdecken: "Abdeckung",
  schwaerzung: "Schwärzung",
};

export const GRUPPEN_NAMEN: Record<Gruppe, string> = {
  kommentar: "Kommentare",
  eintragung: "Eintragungen",
  stempel: "Stempel",
  schwaerzung: "Schwärzungen",
};

function fehler(e: unknown): void {
  melden(e instanceof Error ? e.message : String(e), "fehler");
}

// ------------------------------------------------------------------- Laden
const laedt = new Map<string, number>();

export async function anmerkungenLaden(dokId: string, version: number): Promise<void> {
  if (laedt.get(dokId) === version) return;
  laedt.set(dokId, version);
  try {
    const [seiten, formular] = await Promise.all([api.anmerkungen(dokId), api.formular(dokId)]);
    setzen((z) => ({
      anmerkungen: { ...z.anmerkungen, [dokId]: { version, seiten } },
      formulare: { ...z.formulare, [dokId]: { version, seiten: formular } },
    }));
  } catch {
    laedt.delete(dokId); // Dokument evtl. geschlossen – beim nächsten Mal erneut
  }
}

export function anmerkungFinden(dokId: string, seite: number, id: number): Anmerkung | undefined {
  return holen().anmerkungen[dokId]?.seiten[String(seite)]?.find((a) => a.id === id);
}

export function alleAnmerkungen(dokId: string): Anmerkung[] {
  const seiten = holen().anmerkungen[dokId]?.seiten ?? {};
  return Object.keys(seiten)
    .sort((a, b) => Number(a) - Number(b))
    .flatMap((s) => seiten[s]);
}

// ------------------------------------------------------------------- Stile
export function stilFuer(werkzeug: string): Stil {
  const z = holen();
  const gespeichert = z.einstellungen?.werkzeug_stile?.[werkzeug] ?? {};
  return { ...(STANDARD_STILE[werkzeug] ?? STANDARD_STILE.rechteck), ...gespeichert, ...(z.stile[werkzeug] ?? {}) };
}

let stilTimer = 0;
export function stilSetzen(werkzeug: string, teil: Partial<Stil>): void {
  const neu = { ...stilFuer(werkzeug), ...teil };
  setzen((z) => ({ stile: { ...z.stile, [werkzeug]: neu } }));
  window.clearTimeout(stilTimer);
  stilTimer = window.setTimeout(() => {
    const stile = { ...(holen().einstellungen?.werkzeug_stile ?? {}), ...holen().stile };
    api
      .einstellungenSetzen({ werkzeug_stile: stile })
      .then((e) => setzen({ einstellungen: e }))
      .catch(() => undefined);
  }, 800);
}

// --------------------------------------------------- Anlegen/Ändern/Löschen
// ------------------------------------------------------------- Vorschau
export function vorschauSchluessel(dokId: string, id: number | string): string {
  return `${dokId}:${id}`;
}

export function vorschauSetzen(schluessel: string, v: AnmVorschau | null): void {
  setzen((z) => {
    const neu = { ...z.anmVorschau };
    if (v) neu[schluessel] = v;
    else delete neu[schluessel];
    return { anmVorschau: neu };
  });
}

/** Ein neues Einzelbild wurde geladen: Vorschau entfällt, wenn es die neue Fassung zeigt. */
export function einzelbildGeladen(dokId: string, id: number, v: string): void {
  const s = vorschauSchluessel(dokId, id);
  const vorschau = holen().anmVorschau[s];
  // während der Bearbeitung bleibt die Anmerkung ausgeblendet
  if (vorschau && vorschau.alteV !== v && vorschau.alteV !== "__bearbeitung__") vorschauSetzen(s, null);
}

export async function anmerkungAnlegen(
  dokId: string,
  seite: number,
  daten: Record<string, unknown>,
  auswaehlen = true,
  optionen: { werkzeugBleibt?: boolean; vorschau?: AnmVorschau } = {},
): Promise<number | null> {
  const neuSchluessel = vorschauSchluessel(dokId, `neu:${seite}`);
  if (optionen.vorschau) vorschauSetzen(neuSchluessel, optionen.vorschau);
  try {
    const antwort = await api.anmerkungNeu(dokId, { seite, ...daten });
    if (optionen.vorschau && antwort.id) {
      // Vorschau bleibt sichtbar, bis das Bild der neuen Anmerkung geladen ist
      setzen((z) => {
        const neu = { ...z.anmVorschau, [vorschauSchluessel(dokId, antwort.id!)]: { ...optionen.vorschau!, alteV: "" } };
        delete neu[neuSchluessel];
        return { anmVorschau: neu };
      });
    }
    anwenden(antwort);
    if (auswaehlen && antwort.id && daten.art !== "schwaerzung") setzen({ anmAuswahl: { dokId, seite, id: antwort.id } });
    if (!optionen.werkzeugBleibt) werkzeugBenutzt();
    return antwort.id ?? null;
  } catch (e) {
    vorschauSetzen(neuSchluessel, null);
    fehler(e);
    return null;
  }
}

export async function anmerkungAendern(
  dokId: string,
  seite: number,
  id: number,
  daten: Record<string, unknown>,
  vorschau?: Omit<AnmVorschau, "alteV" | "seite">,
): Promise<number | null> {
  const s = vorschauSchluessel(dokId, id);
  if (vorschau) {
    const alt = anmerkungFinden(dokId, seite, id);
    vorschauSetzen(s, { ...vorschau, seite, alteV: alt?.v ?? "" });
  }
  try {
    const antwort = await api.anmerkungAendern(dokId, id, { seite, ...daten });
    anwenden(antwort);
    return antwort.id ?? null;
  } catch (e) {
    vorschauSetzen(s, null);
    fehler(e);
    return null;
  }
}

/** Ausgewählte Anmerkung mit den Pfeiltasten verschieben (gesammelt, verzögert gespeichert) */
let schubser: { dokId: string; seite: number; id: number; dx: number; dy: number; timer: number } | null = null;

export function auswahlSchubsen(dxPt: number, dyPt: number): boolean {
  const z = holen();
  const a = z.anmAuswahl;
  if (!a) return false;
  const anm = anmerkungFinden(a.dokId, a.seite, a.id);
  const d = z.dokumente.find((x) => x.id === a.dokId);
  if (!anm || !d || TEXTMARKIERUNG.has(anm.art)) return false;
  const s = d.seiten[a.seite];
  const dx = dxPt / s.breite;
  const dy = dyPt / s.hoehe;
  if (!schubser || schubser.id !== a.id || schubser.dokId !== a.dokId) {
    if (schubser) window.clearTimeout(schubser.timer);
    schubser = { dokId: a.dokId, seite: a.seite, id: a.id, dx: 0, dy: 0, timer: 0 };
  }
  schubser.dx += dx;
  schubser.dy += dy;
  const vorschau = holen().anmVorschau[vorschauSchluessel(a.dokId, a.id)];
  const basis = vorschau?.rechteck ?? anm.rechteck;
  vorschauSetzen(vorschauSchluessel(a.dokId, a.id), {
    seite: a.seite,
    rechteck: [basis[0] + dx, basis[1] + dy, basis[2] + dx, basis[3] + dy],
    alteV: vorschau?.alteV ?? anm.v,
  });
  window.clearTimeout(schubser.timer);
  schubser.timer = window.setTimeout(() => {
    const sch = schubser;
    schubser = null;
    if (sch) void anmerkungAendern(sch.dokId, sch.seite, sch.id, { verschieben: [sch.dx, sch.dy] });
  }, 450);
  return true;
}

const TEXTMARKIERUNG = new Set(["hervorheben", "unterstreichen", "durchstreichen", "wellenlinie"]);

export async function anmerkungenLoeschen(dokId: string, eintraege: { seite: number; id: number }[]): Promise<void> {
  if (!eintraege.length) return;
  try {
    anwenden(await api.anmerkungenLoeschen(dokId, eintraege));
    setzen({ anmAuswahl: null });
  } catch (e) {
    fehler(e);
  }
}

export function auswahlLoeschen(): void {
  const a = holen().anmAuswahl;
  if (a) void anmerkungenLoeschen(a.dokId, [{ seite: a.seite, id: a.id }]);
}

/** Stiländerung im Eigenschaftsfeld: für das Werkzeug merken und auf die
 * ausgewählte Anmerkung anwenden. */
export function stilAendern(teil: Partial<Stil>): void {
  const z = holen();
  const a = z.anmAuswahl;
  if (a) {
    const anm = anmerkungFinden(a.dokId, a.seite, a.id);
    if (anm) {
      stilSetzen(anm.art, teil);
      const daten: Record<string, unknown> = {};
      if (teil.farbe !== undefined) daten.farbe = teil.farbe;
      if (teil.fuellung !== undefined) daten.fuellung = teil.fuellung;
      if (teil.breite !== undefined) daten.breite = teil.breite;
      if (teil.deckkraft !== undefined) daten.deckkraft = teil.deckkraft;
      if (teil.schriftgroesse !== undefined) daten.schriftgroesse = teil.schriftgroesse;
      void anmerkungAendern(a.dokId, a.seite, a.id, daten);
      return;
    }
  }
  if (z.editor) {
    setzen({ editor: { ...z.editor, stil: { ...z.editor.stil, ...teil } } });
    stilSetzen(z.editor.art, teil);
    return;
  }
  stilSetzen(z.werkzeug, teil);
}

// --------------------------------------------------------------- Textauswahl
const woerterCache = new Map<string, Promise<Wort[]>>();

export function woerterLaden(dokId: string, seite: number, kennung: string): Promise<Wort[]> {
  const schluessel = `${dokId}:${kennung}`;
  let p = woerterCache.get(schluessel);
  if (!p) {
    p = api.woerter(dokId, seite).catch(() => {
      woerterCache.delete(schluessel);
      return [];
    });
    woerterCache.set(schluessel, p);
    if (woerterCache.size > 60) woerterCache.delete(woerterCache.keys().next().value!);
  }
  return p;
}

/** Wörter (von..bis) zu Zeilenrechtecken zusammenfassen */
export function zeilenRechtecke(woerter: Wort[], von: number, bis: number): [number, number, number, number][] {
  const [a, b] = von <= bis ? [von, bis] : [bis, von];
  const zeilen = new Map<string, [number, number, number, number]>();
  for (let i = a; i <= b && i < woerter.length; i++) {
    const w = woerter[i];
    const schluessel = `${w[5]}:${w[6]}`;
    const r = zeilen.get(schluessel);
    zeilen.set(schluessel, r ? [Math.min(r[0], w[0]), Math.min(r[1], w[1]), Math.max(r[2], w[2]), Math.max(r[3], w[3])] : [w[0], w[1], w[2], w[3]]);
  }
  return [...zeilen.values()];
}

export function auswahlText(woerter: Wort[], von: number, bis: number): string {
  const [a, b] = von <= bis ? [von, bis] : [bis, von];
  let text = "";
  for (let i = a; i <= b && i < woerter.length; i++) {
    const w = woerter[i];
    const vorher = woerter[i - 1];
    if (i > a) text += vorher && (vorher[5] !== w[5] || vorher[6] !== w[6]) ? "\n" : " ";
    text += w[4];
  }
  return text;
}

export async function textAuswahlKopieren(): Promise<void> {
  const t = holen().textAuswahl;
  if (!t) return;
  const d = holen().dokumente.find((x) => x.id === t.dokId);
  if (!d) return;
  const woerter = await woerterLaden(t.dokId, t.seite, d.kennungen[t.seite] ?? "");
  const text = auswahlText(woerter, t.von, t.bis);
  try {
    await navigator.clipboard.writeText(text);
    melden("Text kopiert.");
  } catch {
    melden("Kopieren nicht möglich – Zwischenablage gesperrt.", "fehler");
  }
}

/** Markierten Text hervorheben/unterstreichen/durchstreichen/schwärzen */
export async function textAuswahlMarkieren(art: string): Promise<void> {
  const t = holen().textAuswahl;
  if (!t) return;
  const d = holen().dokumente.find((x) => x.id === t.dokId);
  if (!d) return;
  const woerter = await woerterLaden(t.dokId, t.seite, d.kennungen[t.seite] ?? "");
  const rechtecke = zeilenRechtecke(woerter, t.von, t.bis);
  setzen({ textAuswahl: null });
  if (art === "schwaerzung") {
    try {
      anwenden(await api.schwaerzenVormerken(t.dokId, rechtecke.map((r) => ({ seite: t.seite, rechteck: r }))));
      melden("Zum Schwärzen vorgemerkt – „Schwärzungen anwenden“ entfernt den Text endgültig.");
    } catch (e) {
      fehler(e);
    }
    return;
  }
  const stil = stilFuer(art);
  await anmerkungAnlegen(t.dokId, t.seite, { art, rechtecke, farbe: stil.farbe, deckkraft: art === "hervorheben" ? undefined : stil.deckkraft }, false);
}

// ----------------------------------------------------------- Sichtbarkeit
export function gruppeUmschalten(g: Gruppe): void {
  setzen((z) => ({ ausblenden: z.ausblenden.includes(g) ? z.ausblenden.filter((x) => x !== g) : [...z.ausblenden, g] }));
}

// -------------------------------------------------------------- Formulare
export async function formularfeldSetzen(dokId: string, seite: number, feld: number, wert: string | boolean): Promise<void> {
  try {
    anwenden(await api.formularSetzen(dokId, feld, seite, wert));
  } catch (e) {
    fehler(e);
  }
}

// ------------------------------------------------------ Formular gestalten
/** Feld in der lokalen Liste sofort ändern (kein Zurückspringen beim Verschieben) */
function feldLokal(dokId: string, seite: number, id: number, teil: Partial<Formularfeld> | null): void {
  setzen((z) => {
    const f = z.formulare[dokId];
    if (!f) return {};
    const liste = f.seiten[String(seite)] ?? [];
    const neu = teil === null ? liste.filter((x) => x.id !== id) : liste.map((x) => (x.id === id ? { ...x, ...teil } : x));
    return { formulare: { ...z.formulare, [dokId]: { ...f, seiten: { ...f.seiten, [String(seite)]: neu } } } };
  });
}

export async function formularfeldAnlegen(dokId: string, seite: number, typ: FormularTyp, rechteck: Rechteck): Promise<number | null> {
  try {
    const r = await api.formularfeldNeu(dokId, { seite, typ, rechteck });
    anwenden(r);
    setzen({ formularAuswahl: { dokId, seite, id: r.id } });
    return r.id;
  } catch (e) {
    fehler(e);
    return null;
  }
}

export async function formularfeldAendern(dokId: string, seite: number, id: number, daten: Record<string, unknown>): Promise<boolean> {
  // sofort anzeigen (Häkchen, Lage, Name …) – der Dienst bestätigt gleich
  feldLokal(dokId, seite, id, daten as Partial<Formularfeld>);
  try {
    anwenden(await api.formularfeldAendern(dokId, id, { seite, ...daten }));
    return true;
  } catch (e) {
    fehler(e);
    void anmerkungenLaden(dokId, -Date.now()); // lokalen Stand verwerfen
    return false;
  }
}

export async function formularfeldLoeschen(dokId: string, seite: number, id: number): Promise<void> {
  feldLokal(dokId, seite, id, null);
  setzen((z) => ({ formularAuswahl: z.formularAuswahl?.id === id ? null : z.formularAuswahl }));
  try {
    anwenden(await api.formularfeldLoeschen(dokId, id, seite));
    melden("Formularfeld gelöscht – Strg+Z macht es rückgängig.");
  } catch (e) {
    fehler(e);
  }
}

export function formularfeldFinden(dokId: string, seite: number, id: number): Formularfeld | undefined {
  return holen().formulare[dokId]?.seiten[String(seite)]?.find((f) => f.id === id);
}
