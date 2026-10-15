// Anmerkungs-Ebene über einer Seite: Anmerkungen auswählen, verschieben und
// in der Größe ändern; neue zeichnen (Formen, Linien, Freihand), Text
// markieren, Schreibmaschinentext/Notizen eingeben, Bilder/Stempel platzieren,
// Formularfelder ausfüllen.
//
// Koordinaten: Alles innen ist normiert (0..1) auf die *ungedrehte* angezeigte
// Seite. Die Ansichtsdrehung übernimmt eine CSS-Drehung des Innenbereichs.

import { Copy, Eraser, Highlighter, Pencil, Strikethrough, Trash2, Underline } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Anmerkung, Formularfeld, Punkt, Rechteck, Wort } from "../typen";
import {
  anmerkungAendern,
  anmerkungAnlegen,
  anmerkungenLoeschen,
  ART_NAMEN,
  auswahlSchubsen,
  einzelbildGeladen,
  vorschauSchluessel,
  vorschauSetzen,
  formularfeldSetzen,
  stilFuer,
  TEXTWERKZEUGE,
  textAuswahlKopieren,
  textAuswahlMarkieren,
  woerterLaden,
  zeilenRechtecke,
  ZEICHENWERKZEUGE,
} from "../zustand/anmerkungen";
import { holen, melden, setzen, useZustand, werkzeugBenutzt, type AnmVorschau, type Editor } from "../zustand/store";
import { anfordern, ausCache } from "../render/bildlader";
import { renderStufe } from "../render/layout";
import { api } from "../api";
import { anwenden } from "../zustand/seitenaktionen";
import { Kontextmenue } from "./Kontextmenue";
import { FormularGestaltung } from "./FormularGestaltung";
import { RsTextarea } from "./RsTextarea";

const KEINE_STEMPEL: { text: string; farbe: string }[] = [];

export interface AnmerkungsEbeneProps {
  dokId: string;
  seite: number;
  kennung: string;
  /** Größe der angezeigten (ggf. gedrehten) Seite in CSS-px */
  b: number;
  h: number;
  drehung: number;
  /** Seitengröße in pt ohne Ansichtsdrehung */
  breitePt: number;
  hoehePt: number;
  /** Bildschirm-Pixeldichte (für scharfe Einzelbilder) */
  dpr: number;
}

type Operation =
  | { art: "rechteck"; p0: Punkt; p1: Punkt }
  | { art: "linie"; p0: Punkt; p1: Punkt }
  | { art: "freihand"; punkte: Punkt[] }
  | { art: "text"; woerter: Wort[]; von: number; bis: number }
  | { art: "verschieben"; anm: Anmerkung; p0: Punkt; p1: Punkt }
  | { art: "groesse"; anm: Anmerkung; griff: string; p0: Punkt; p1: Punkt };

const KEINE_FELDER: Formularfeld[] = [];
const VERSCHIEBBAR_IN_GROESSE = new Set(["rechteck", "ellipse", "abdecken", "bild", "unterschrift", "textfeld", "freihand", "schwaerzung"]);
const NICHT_VERSCHIEBBAR = new Set(["hervorheben", "unterstreichen", "durchstreichen", "wellenlinie"]);
export const GRIFFE = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Bildschirmpunkt → normierter Punkt auf der ungedrehten Seite */
export function normPunkt(e: { clientX: number; clientY: number }, el: HTMLElement, drehung: number): Punkt {
  const r = el.getBoundingClientRect();
  const dx = (e.clientX - r.left) / r.width;
  const dy = (e.clientY - r.top) / r.height;
  switch (((drehung % 360) + 360) % 360) {
    case 90:
      return [dy, 1 - dx];
    case 180:
      return [1 - dx, 1 - dy];
    case 270:
      return [1 - dy, dx];
    default:
      return [dx, dy];
  }
}

const klemmen = (v: number) => Math.max(0, Math.min(1, v));
export const norm = (a: Punkt, b: Punkt): Rechteck => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
export const stilAus = (r: Rechteck): CSSProperties => ({
  left: `${r[0] * 100}%`,
  top: `${r[1] * 100}%`,
  width: `${(r[2] - r[0]) * 100}%`,
  height: `${(r[3] - r[1]) * 100}%`,
});

export function groesseAendern(r: Rechteck, griff: string, dx: number, dy: number, seitenverhaeltnis: number | null): Rechteck {
  let [x0, y0, x1, y1] = r;
  if (griff.includes("w")) x0 += dx;
  if (griff.includes("e")) x1 += dx;
  if (griff.includes("n")) y0 += dy;
  if (griff.includes("s")) y1 += dy;
  if (seitenverhaeltnis && griff.length === 2) {
    // Ecke: Seitenverhältnis halten (Bilder)
    const b = Math.abs(x1 - x0);
    const h = b / seitenverhaeltnis;
    if (griff.includes("n")) y0 = y1 - h;
    else y1 = y0 + h;
  }
  return norm([x0, y0], [x1, y1]);
}

export function AnmerkungsEbene(p: AnmerkungsEbeneProps) {
  const werkzeug = useZustand((z) => z.werkzeug);
  const anmerkungen = useZustand((z) => z.anmerkungen[p.dokId]?.seiten[String(p.seite)]);
  const felder = useZustand((z) => z.formulare[p.dokId]?.seiten[String(p.seite)]);
  const ausblenden = useZustand((z) => z.ausblenden);
  const auswahl = useZustand((z) => (z.anmAuswahl?.dokId === p.dokId && z.anmAuswahl.seite === p.seite ? z.anmAuswahl.id : null));
  const editor = useZustand((z) => (z.editor?.dokId === p.dokId && z.editor.seite === p.seite ? z.editor : null));
  const textAuswahl = useZustand((z) => (z.textAuswahl?.dokId === p.dokId && z.textAuswahl.seite === p.seite ? z.textAuswahl : null));
  const platzieren = useZustand((z) => z.platzieren);
  const stempelIndex = useZustand((z) => z.stempelVorlage);
  const vorlagen = useZustand((z) => z.einstellungen?.stempel ?? KEINE_STEMPEL);
  const vorschauAlle = useZustand((z) => z.anmVorschau);

  const aussen = useRef<HTMLDivElement>(null);
  const [op, setOp] = useState<Operation | null>(null);
  const opRef = useRef<Operation | null>(null);
  opRef.current = op;
  const [maus, setMaus] = useState<Punkt | null>(null);
  const [woerter, setWoerter] = useState<Wort[] | null>(null);
  const [menue, setMenue] = useState<{ x: number; y: number; anm: Anmerkung } | null>(null);

  const quer = p.drehung % 180 !== 0;
  const iw = quer ? p.h : p.b;
  const ih = quer ? p.b : p.h;
  const pxProPt = iw / p.breitePt;

  const zeichnen = ZEICHENWERKZEUGE.includes(werkzeug);
  const textwerkzeug = TEXTWERKZEUGE.includes(werkzeug);
  const sichtbar = useMemo(() => (anmerkungen ?? []).filter((a) => !ausblenden.includes(a.gruppe) && !a.ausgeblendet), [anmerkungen, ausblenden]);
  const vorschauVon = (id: number | string): AnmVorschau | undefined => vorschauAlle[vorschauSchluessel(p.dokId, id)];
  const gewaehltRoh = auswahl !== null ? sichtbar.find((a) => a.id === auswahl) ?? null : null;
  // Auswahlrahmen folgt sofort der Vorschau (Pfeiltasten, nach dem Loslassen)
  const gewaehlt = gewaehltRoh && vorschauVon(gewaehltRoh.id)?.rechteck ? { ...gewaehltRoh, rechteck: vorschauVon(gewaehltRoh.id)!.rechteck! } : gewaehltRoh;
  const spriteStufe = renderStufe(pxProPt * p.dpr);

  // Pfeiltasten: ausgewählte Anmerkung um 1 pt (Umschalt: 10 pt) verschieben
  useEffect(() => {
    if (auswahl === null) return;
    const taste = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]") || holen().dialog || holen().editor) return;
      const schritt = e.shiftKey ? 10 : 1;
      const r = { ArrowLeft: [-schritt, 0], ArrowRight: [schritt, 0], ArrowUp: [0, -schritt], ArrowDown: [0, schritt] }[e.key];
      if (!r) return;
      // Ansichtsdrehung berücksichtigen: Pfeil nach rechts = auf dem Bildschirm nach rechts
      const d = ((p.drehung % 360) + 360) % 360;
      const [dx, dy] = d === 90 ? [r[1], -r[0]] : d === 180 ? [-r[0], -r[1]] : d === 270 ? [-r[1], r[0]] : r;
      if (auswahlSchubsen(dx, dy)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", taste, true);
    return () => window.removeEventListener("keydown", taste, true);
  }, [auswahl, p.drehung]);

  // Wörter für Textauswahl laden, sobald ein Textwerkzeug aktiv ist
  useEffect(() => {
    if (!textwerkzeug && !textAuswahl) return;
    let aktiv = true;
    void woerterLaden(p.dokId, p.seite, p.kennung).then((w) => aktiv && setWoerter(w));
    return () => {
      aktiv = false;
    };
  }, [textwerkzeug, textAuswahl, p.dokId, p.seite, p.kennung]);

  // ---------------------------------------------------------- Maus-Ablauf
  useEffect(() => {
    if (!op) return;
    const el = aussen.current!;
    const bewegen = (e: MouseEvent) => {
      const pt = normPunkt(e, el, p.drehung);
      const o = opRef.current;
      if (!o) return;
      if (o.art === "rechteck" || o.art === "verschieben" || o.art === "groesse") setOp({ ...o, p1: pt });
      else if (o.art === "linie") {
        let ziel = pt;
        if (e.shiftKey) {
          // auf 45°-Schritte einrasten
          const dx = (pt[0] - o.p0[0]) * p.breitePt;
          const dy = (pt[1] - o.p0[1]) * p.hoehePt;
          const winkel = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const laenge = Math.hypot(dx, dy);
          ziel = [o.p0[0] + (Math.cos(winkel) * laenge) / p.breitePt, o.p0[1] + (Math.sin(winkel) * laenge) / p.hoehePt];
        }
        setOp({ ...o, p1: ziel });
      } else if (o.art === "freihand") setOp({ ...o, punkte: [...o.punkte, pt] });
      else if (o.art === "text") setOp({ ...o, bis: naechstesWort(o.woerter, pt) });
    };
    const loslassen = (e: MouseEvent) => {
      const o = opRef.current;
      setOp(null);
      if (o) void abschliessen(o, e.shiftKey);
    };
    window.addEventListener("mousemove", bewegen);
    window.addEventListener("mouseup", loslassen);
    return () => {
      window.removeEventListener("mousemove", bewegen);
      window.removeEventListener("mouseup", loslassen);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op !== null]);

  const naechstesWort = (liste: Wort[], pt: Punkt): number => {
    let beste = -1;
    let abstand = Infinity;
    liste.forEach((w, i) => {
      const dx = Math.max(w[0] - pt[0], 0, pt[0] - w[2]) * p.breitePt;
      const dy = Math.max(w[1] - pt[1], 0, pt[1] - w[3]) * p.hoehePt * 2.5; // Zeile zählt mehr
      const d = dx + dy;
      if (d < abstand) {
        abstand = d;
        beste = i;
      }
    });
    return beste;
  };

  const stilDaten = (werkzeugName: string) => {
    const s = stilFuer(werkzeugName);
    return { farbe: s.farbe, fuellung: s.fuellung, breite: s.breite, deckkraft: s.deckkraft, schriftgroesse: s.schriftgroesse };
  };

  async function abschliessen(o: Operation, umschalt: boolean) {
    const w = holen().werkzeug;
    if (o.art === "rechteck") {
      const r = norm(o.p0, o.p1).map(klemmen) as Rechteck;
      const klein = (r[2] - r[0]) * p.breitePt < 4 && (r[3] - r[1]) * p.hoehePt < 4;
      if (w === "platzieren") return bildPlatzieren(o.p1, klein ? null : r);
      if (w === "textfeld") {
        const rr: Rechteck = klein ? [r[0], r[1], klemmen(r[0] + 180 / p.breitePt), klemmen(r[1] + 40 / p.hoehePt)] : r;
        setzen({ editor: { dokId: p.dokId, seite: p.seite, id: null, art: "textfeld", punkt: [rr[0], rr[1]], rechteck: rr, text: "", stil: stilFuer("textfeld") } });
        return;
      }
      if (klein) return;
      if (w === "schwaerzen") {
        try {
          anwenden(await api.schwaerzenVormerken(p.dokId, [{ seite: p.seite, rechteck: r }]));
          melden("Zum Schwärzen vorgemerkt – „Schwärzungen anwenden“ macht es endgültig.");
        } catch (e) {
          melden(e instanceof Error ? e.message : String(e), "fehler");
        }
        werkzeugBenutzt();
        return;
      }
      await anmerkungAnlegen(p.dokId, p.seite, { art: w, rechteck: r, ...stilDaten(w) });
      return;
    }
    if (o.art === "linie") {
      if (Math.hypot((o.p1[0] - o.p0[0]) * p.breitePt, (o.p1[1] - o.p0[1]) * p.hoehePt) < 4) return;
      await anmerkungAnlegen(p.dokId, p.seite, { art: w, punkte: [o.p0, o.p1], ...stilDaten(w) });
      return;
    }
    if (o.art === "freihand") {
      if (o.punkte.length < 2) return;
      await anmerkungAnlegen(p.dokId, p.seite, { art: "freihand", striche: [vereinfachen(o.punkte)], ...stilDaten("freihand") }, false);
      return;
    }
    if (o.art === "text") {
      if (o.von < 0) return;
      setzen({ textAuswahl: { dokId: p.dokId, seite: p.seite, von: o.von, bis: o.bis } });
      if (w !== "textauswahl") await textAuswahlMarkieren(w);
      return;
    }
    if (o.art === "verschieben") {
      const dx = o.p1[0] - o.p0[0];
      const dy = o.p1[1] - o.p0[1];
      if (Math.abs(dx * p.breitePt) < 1.5 && Math.abs(dy * p.hoehePt) < 1.5) return;
      const a = o.anm;
      const r = a.rechteck;
      const ziel: Rechteck = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
      await anmerkungAendern(p.dokId, p.seite, a.id, { verschieben: [dx, dy] }, { rechteck: ziel });
      return;
    }
    if (o.art === "groesse") {
      const a = o.anm;
      const verhaeltnis = a.pdf_art === "bild" && !umschalt ? ((a.rechteck[2] - a.rechteck[0]) * p.breitePt) / ((a.rechteck[3] - a.rechteck[1]) * p.hoehePt) * (p.hoehePt / p.breitePt) : null;
      const neu = groesseAendern(a.rechteck, o.griff, o.p1[0] - o.p0[0], o.p1[1] - o.p0[1], verhaeltnis);
      if ((neu[2] - neu[0]) * p.breitePt < 4 || (neu[3] - neu[1]) * p.hoehePt < 4) return;
      await anmerkungAendern(p.dokId, p.seite, a.id, { rechteck: neu }, { rechteck: neu });
    }
  }

  function bildPlatzieren(mitte: Punkt, rechteck: Rechteck | null) {
    const pl = holen().platzieren;
    if (!pl) return;
    let r = rechteck;
    const verhaeltnis = pl.hoehe / pl.breite; // Höhe/Breite in Pixeln
    if (!r) {
      // Standardgröße: Unterschrift ~6 cm breit, Bild ~ bis 60 % der Seitenbreite
      const breitePt = pl.art === "unterschrift" ? 170 : Math.min(p.breitePt * 0.6, pl.breite * 0.75);
      const b = breitePt / p.breitePt;
      const h = (breitePt * verhaeltnis) / p.hoehePt;
      r = [mitte[0] - b / 2, mitte[1] - h / 2, mitte[0] + b / 2, mitte[1] + h / 2];
    } else {
      // aufgezogenes Rechteck: Breite zählt, Seitenverhältnis bleibt
      const b = r[2] - r[0];
      r = [r[0], r[1], r[2], r[1] + (b * p.breitePt * verhaeltnis) / p.hoehePt];
    }
    void anmerkungAnlegen(p.dokId, p.seite, {
      art: pl.art,
      rechteck: r,
      bild_id: pl.bildId,
      unterschrift_id: pl.unterschriftId,
    }).then(() => {
      if (!holen().werkzeugFixiert) setzen({ platzieren: null });
    });
  }

  // ------------------------------------------------------------ Mausdruck
  const druecken = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = aussen.current!;
    const pt = normPunkt(e, el, p.drehung);
    const w = holen().werkzeug;
    if (holen().editor) return; // Editor schließt sich über blur
    if (zeichnen || textwerkzeug) {
      e.stopPropagation();
      e.preventDefault();
      setzen({ anmAuswahl: null, textAuswahl: null });
    }
    if (["rechteck", "ellipse", "abdecken", "schwaerzen", "textfeld", "platzieren"].includes(w)) setOp({ art: "rechteck", p0: pt, p1: pt });
    else if (w === "linie" || w === "pfeil") setOp({ art: "linie", p0: pt, p1: pt });
    else if (w === "freihand") setOp({ art: "freihand", punkte: [pt] });
    else if (textwerkzeug) {
      void woerterLaden(p.dokId, p.seite, p.kennung).then((liste) => {
        setWoerter(liste);
        if (!liste.length) {
          melden("Auf dieser Seite gibt es keinen Text – erst Texterkennung starten.", "fehler");
          return;
        }
        const i = naechstesWort(liste, pt);
        setOp({ art: "text", woerter: liste, von: i, bis: i });
      });
    } else if (w === "schreibmaschine") {
      const treffer = sichtbar.find(
        (a) => (a.art === "schreibmaschine" || a.art === "textfeld") && pt[0] >= a.rechteck[0] && pt[0] <= a.rechteck[2] && pt[1] >= a.rechteck[1] && pt[1] <= a.rechteck[3],
      );
      if (treffer) {
        bearbeiten(treffer);
        return;
      }
      setzen({ editor: { dokId: p.dokId, seite: p.seite, id: null, art: "schreibmaschine", punkt: pt, text: "", stil: stilFuer("schreibmaschine") } });
    } else if (w === "notiz") {
      setzen({ editor: { dokId: p.dokId, seite: p.seite, id: null, art: "notiz", punkt: pt, text: "", stil: stilFuer("notiz") } });
    } else if (w === "stempel") {
      const v = vorlagen[stempelIndex] ?? vorlagen[0];
      if (!v) {
        melden("Keine Stempelvorlage vorhanden.", "fehler");
        return;
      }
      const s = stilFuer("stempel");
      void anmerkungAnlegen(p.dokId, p.seite, { art: "stempel", punkt: pt, vorlage: v.text, farbe: v.farbe, schriftgroesse: s.schriftgroesse, breite: s.breite });
    }
  };

  const anmDruecken = (e: React.MouseEvent, a: Anmerkung) => {
    if (e.button !== 0 || holen().werkzeug !== "hand") return;
    e.stopPropagation();
    e.preventDefault();
    setzen({ anmAuswahl: { dokId: p.dokId, seite: p.seite, id: a.id }, textAuswahl: null, aktiv: p.dokId });
    if (NICHT_VERSCHIEBBAR.has(a.art)) return;
    const pt = normPunkt(e, aussen.current!, p.drehung);
    setOp({ art: "verschieben", anm: a, p0: pt, p1: pt });
  };

  const bearbeiten = (a: Anmerkung) => {
    if (a.art === "schreibmaschine" || a.art === "textfeld") {
      // Bild der Anmerkung ausblenden – der Editor steht genau an ihrer Stelle
      vorschauSetzen(vorschauSchluessel(p.dokId, a.id), { seite: p.seite, versteckt: true, alteV: "__bearbeitung__" });
      setzen({
        anmAuswahl: null,
        editor: {
          dokId: p.dokId,
          seite: p.seite,
          id: a.id,
          art: a.art,
          punkt: [a.rechteck[0], a.rechteck[1]],
          rechteck: a.rechteck,
          text: a.text ?? a.inhalt,
          stil: { ...stilFuer(a.art), farbe: a.textfarbe ?? a.farbe ?? "#000000", schriftgroesse: a.schriftgroesse ?? 11, fuellung: a.fuellung },
        },
      });
    } else {
      setzen({
        anmAuswahl: null,
        editor: { dokId: p.dokId, seite: p.seite, id: a.id, art: "notiz", punkt: [a.rechteck[0], a.rechteck[1]], text: a.inhalt, stil: stilFuer("notiz") },
      });
    }
  };

  // --------------------------------------------------------------- Anzeige
  const cursor = zeichnen ? (werkzeug === "platzieren" || werkzeug === "stempel" ? "copy" : "crosshair") : textwerkzeug ? "text" : undefined;
  const auswahlRechtecke = textAuswahl && woerter ? zeilenRechtecke(woerter, textAuswahl.von, textAuswahl.bis) : [];
  const opText = op?.art === "text" ? zeilenRechtecke(op.woerter, op.von, op.bis) : [];
  const verschiebung = op && (op.art === "verschieben" || op.art === "groesse") ? op : null;

  let vorschauRechteck: Rechteck | null = null;
  if (verschiebung?.art === "verschieben") {
    const dx = verschiebung.p1[0] - verschiebung.p0[0];
    const dy = verschiebung.p1[1] - verschiebung.p0[1];
    const r = verschiebung.anm.rechteck;
    vorschauRechteck = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
  } else if (verschiebung?.art === "groesse") {
    vorschauRechteck = groesseAendern(verschiebung.anm.rechteck, verschiebung.griff, verschiebung.p1[0] - verschiebung.p0[0], verschiebung.p1[1] - verschiebung.p0[1], null);
  }

  const stempelVorschau = werkzeug === "stempel" && maus ? vorlagen[stempelIndex] ?? vorlagen[0] : null;

  /** Wo eine Anmerkung gerade zu sehen ist: live beim Ziehen, sonst Vorschau, sonst gespeichert */
  const lage = (a: Anmerkung): Rechteck => {
    if (verschiebung && verschiebung.anm.id === a.id && vorschauRechteck) return vorschauRechteck;
    return vorschauVon(a.id)?.rechteck ?? a.rechteck;
  };

  return (
    <div
      ref={aussen}
      className={`anm-ebene${zeichnen || textwerkzeug || werkzeug === "formular" ? " aktiv" : ""}`}
      style={{ cursor }}
      onMouseDown={druecken}
      onMouseMove={(e) => (werkzeug === "platzieren" || werkzeug === "stempel") && setMaus(normPunkt(e, aussen.current!, p.drehung))}
      onMouseLeave={() => setMaus(null)}
      data-seite={p.seite}
    >
      <div
        className="anm-innen"
        style={{ width: iw, height: ih, left: (p.b - iw) / 2, top: (p.h - ih) / 2, transform: p.drehung ? `rotate(${p.drehung}deg)` : undefined }}
      >
        {/* Formularfelder: ausfüllen – oder im Modus „Formular gestalten“ bearbeiten */}
        {werkzeug === "formular" ? (
          <FormularGestaltung
            dokId={p.dokId}
            seite={p.seite}
            felder={felder ?? KEINE_FELDER}
            aussen={aussen}
            drehung={p.drehung}
            breitePt={p.breitePt}
            hoehePt={p.hoehePt}
          />
        ) : (
          felder?.map((f) => <Feld key={f.id} feld={f} dokId={p.dokId} seite={p.seite} pxProPt={pxProPt} hoehePt={p.hoehePt} ih={ih} />)
        )}

        {/* Anmerkungen als eigene Bilder (die Seite selbst wird ohne sie gezeichnet) */}
        {sichtbar.map((a) => {
          const v = vorschauVon(a.id);
          return (
            <Einzelbild
              key={a.id}
              dokId={p.dokId}
              anm={a}
              rechteck={lage(a)}
              stufe={spriteStufe}
              versteckt={Boolean(v?.versteckt || v?.text)}
            />
          );
        })}
        {sichtbar.map((a) => {
          const t = vorschauVon(a.id)?.text;
          return t ? <TextVorschau key={`t${a.id}`} t={t} pxProPt={pxProPt} iw={iw} ih={ih} /> : null;
        })}
        {Object.entries(vorschauAlle).map(([schluessel, v]) => {
          // neue Anmerkungen, die noch nicht in der Liste stehen
          if (!v.text || v.seite !== p.seite || !schluessel.startsWith(`${p.dokId}:`)) return null;
          const id = schluessel.slice(p.dokId.length + 1);
          if (sichtbar.some((a) => String(a.id) === id)) return null;
          return <TextVorschau key={schluessel} t={v.text} pxProPt={pxProPt} iw={iw} ih={ih} />;
        })}

        {/* Trefferflächen der Anmerkungen (nur Hand-Werkzeug) */}
        {werkzeug === "hand" &&
          sichtbar.map((a) => (
            <div
              key={a.id}
              className={`anm-treffer art-${a.art}${a.id === auswahl ? " gewaehlt" : ""}`}
              style={stilAus(lage(a))}
              title={`${ART_NAMEN[a.art] ?? a.art}${a.autor ? ` · ${a.autor}` : ""}${a.inhalt && a.art !== "stempel" ? `\n${a.inhalt}` : ""}`}
              onMouseDown={(e) => anmDruecken(e, a)}
              onDoubleClick={() => (["schreibmaschine", "textfeld", "notiz"].includes(a.art) ? bearbeiten(a) : undefined)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setzen({ anmAuswahl: { dokId: p.dokId, seite: p.seite, id: a.id } });
                setMenue({ x: e.clientX, y: e.clientY, anm: a });
              }}
              data-anmerkung={a.id}
            />
          ))}

        {/* Auswahlrahmen mit Griffen */}
        {gewaehlt && !verschiebung && (
          <div className="anm-auswahl" style={stilAus(gewaehlt.rechteck)}>
            {VERSCHIEBBAR_IN_GROESSE.has(gewaehlt.art) &&
              GRIFFE.map((g) => (
                <div
                  key={g}
                  className={`anm-griff griff-${g}`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    const pt = normPunkt(e, aussen.current!, p.drehung);
                    setOp({ art: "groesse", anm: gewaehlt, griff: g, p0: pt, p1: pt });
                  }}
                />
              ))}
            <div className="anm-schwebeleiste" style={{ transform: p.drehung ? `rotate(${-p.drehung}deg)` : undefined }}>
              {["schreibmaschine", "textfeld", "notiz"].includes(gewaehlt.art) && (
                <button title="Text bearbeiten" aria-label="Text bearbeiten" onMouseDown={(e) => e.stopPropagation()} onClick={() => bearbeiten(gewaehlt)}>
                  <Pencil size={14} />
                </button>
              )}
              <button
                title="Löschen (Entf)"
                aria-label="Anmerkung löschen"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => void anmerkungenLoeschen(p.dokId, [{ seite: p.seite, id: gewaehlt.id }])}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )}
        {vorschauRechteck && <div className="anm-auswahl live" style={stilAus(vorschauRechteck)} />}

        {/* Zeichnen: Vorschau */}
        {op?.art === "rechteck" && (
          <div
            className={`anm-zeichnung werkzeug-${werkzeug}`}
            style={{
              ...stilAus(norm(op.p0, op.p1)),
              borderColor: werkzeug === "schwaerzen" ? "#000" : stilFuer(werkzeug).farbe,
              borderRadius: werkzeug === "ellipse" ? "50%" : undefined,
            }}
          />
        )}
        {(op?.art === "linie" || op?.art === "freihand") && (
          <svg className="anm-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">
            <polyline
              points={(op.art === "linie" ? [op.p0, op.p1] : op.punkte).map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")}
              fill="none"
              stroke={stilFuer(werkzeug).farbe}
              strokeWidth={Math.max(1, stilFuer(werkzeug).breite * pxProPt)}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}

        {/* Textauswahl */}
        {(op?.art === "text" ? opText : auswahlRechtecke).map((r, i) => (
          <div key={i} className={`text-auswahl werkzeug-${werkzeug}`} style={stilAus(r)} />
        ))}
        {textAuswahl && !op && auswahlRechtecke.length > 0 && (
          <TextLeiste r={auswahlRechtecke[0]} drehung={p.drehung} />
        )}

        {/* Bild/Stempel platzieren: Vorschau am Mauszeiger */}
        {werkzeug === "platzieren" && platzieren && maus && !op && (
          <img
            className="platzieren-vorschau"
            src={platzieren.bild}
            alt=""
            style={(() => {
              const breitePt = platzieren.art === "unterschrift" ? 170 : Math.min(p.breitePt * 0.6, platzieren.breite * 0.75);
              const b = breitePt / p.breitePt;
              const h = (breitePt * (platzieren.hoehe / platzieren.breite)) / p.hoehePt;
              return stilAus([maus[0] - b / 2, maus[1] - h / 2, maus[0] + b / 2, maus[1] + h / 2]);
            })()}
          />
        )}
        {stempelVorschau && maus && (
          <div
            className="stempel-vorschau"
            style={{
              left: `${maus[0] * 100}%`,
              top: `${maus[1] * 100}%`,
              color: stempelVorschau.farbe,
              borderColor: stempelVorschau.farbe,
              fontSize: stilFuer("stempel").schriftgroesse * pxProPt,
            }}
          >
            {stempelVorschau.text.replace("{datum}", new Date().toLocaleDateString("de-DE")).replace("{zeit}", "").replace("{kuerzel}", holen().einstellungen?.kuerzel || "Kürzel")}
          </div>
        )}

        {editor && <TextEditor editor={editor} pxProPt={pxProPt} iw={iw} ih={ih} drehung={p.drehung} />}
      </div>
      {menue && (
        <Kontextmenue
          x={menue.x}
          y={menue.y}
          schliessen={() => setMenue(null)}
          punkte={[
            ...(["schreibmaschine", "textfeld", "notiz"].includes(menue.anm.art)
              ? [{ titel: "Text bearbeiten", icon: Pencil, aktion: () => bearbeiten(menue.anm) }]
              : []),
            { titel: "Löschen", icon: Trash2, kuerzel: "Entf", gefahr: true, aktion: () => void anmerkungenLoeschen(p.dokId, [{ seite: p.seite, id: menue.anm.id }]) },
          ]}
        />
      )}
    </div>
  );
}

/** Freihandlinie ausdünnen (Punkte mit < 0,15 % Abstand weglassen) */
function vereinfachen(punkte: Punkt[]): Punkt[] {
  const ergebnis: Punkt[] = [punkte[0]];
  for (const pt of punkte.slice(1)) {
    const l = ergebnis[ergebnis.length - 1];
    if (Math.hypot(pt[0] - l[0], pt[1] - l[1]) > 0.0015) ergebnis.push(pt);
  }
  if (ergebnis.length === 1) ergebnis.push(punkte[punkte.length - 1]);
  return ergebnis.map(([x, y]) => [Math.round(x * 100000) / 100000, Math.round(y * 100000) / 100000]);
}

// -------------------------------------------------- Leiste nach Textauswahl
function TextLeiste({ r, drehung }: { r: Rechteck; drehung: number }) {
  const halt = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <div
      className="text-leiste"
      style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, transform: `translateY(-110%)${drehung ? ` rotate(${-drehung}deg)` : ""}` }}
      onMouseDown={halt}
      role="toolbar"
      aria-label="Markierten Text"
    >
      <button onClick={() => void textAuswahlKopieren()} title="Kopieren (Strg+C)">
        <Copy size={14} /> Kopieren
      </button>
      <button onClick={() => void textAuswahlMarkieren("hervorheben")} title="Hervorheben">
        <Highlighter size={14} />
      </button>
      <button onClick={() => void textAuswahlMarkieren("unterstreichen")} title="Unterstreichen">
        <Underline size={14} />
      </button>
      <button onClick={() => void textAuswahlMarkieren("durchstreichen")} title="Durchstreichen">
        <Strikethrough size={14} />
      </button>
      <button onClick={() => void textAuswahlMarkieren("schwaerzung")} title="Zum Schwärzen vormerken">
        <Eraser size={14} />
      </button>
    </div>
  );
}

// --------------------------------------------------------- Einzelbild
/** Eine Anmerkung als eigenes Bild. Bei neuer Fassung bleibt das alte Bild
 * stehen, bis das neue geladen ist – nichts flackert. */
function Einzelbild(p: { dokId: string; anm: Anmerkung; rechteck: Rechteck; stufe: number; versteckt: boolean }) {
  const url = `/api/dokumente/${p.dokId}/anmerkungen/${p.anm.id}/bild?seite=${p.anm.seite}&skala=${p.stufe}&v=${p.anm.v}`;
  const [bild, setBild] = useState<string | null>(() => ausCache(url));
  useEffect(() => {
    const v = p.anm.v;
    return anfordern(url, 0, (objektUrl) => {
      if (!objektUrl) return;
      setBild(objektUrl);
      einzelbildGeladen(p.dokId, p.anm.id, v);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  if (!bild) return null;
  return (
    <img
      className={`anm-bild art-${p.anm.pdf_art}`}
      src={bild}
      alt=""
      draggable={false}
      style={{ ...stilAus(p.rechteck), visibility: p.versteckt ? "hidden" : undefined }}
      data-anmerkung-bild={p.anm.id}
    />
  );
}

/** Gerade eingegebener Text, bis der Dienst das fertige Bild liefert */
function TextVorschau({ t, pxProPt, iw, ih }: { t: NonNullable<AnmVorschau["text"]>; pxProPt: number; iw: number; ih: number }) {
  const fs = t.stil.schriftgroesse * pxProPt;
  const schrift: CSSProperties = {
    fontFamily: "Helvetica, Arial, 'Liberation Sans', sans-serif",
    fontSize: fs,
    lineHeight: 1.2,
    color: t.stil.farbe,
    whiteSpace: t.art === "schreibmaschine" ? "pre" : "pre-wrap",
  };
  if (t.art === "textfeld" && t.rechteck) {
    return (
      <div
        className="text-vorschau textfeld"
        style={{ ...stilAus(t.rechteck), ...schrift, borderColor: t.stil.farbe, background: t.stil.fuellung ?? "transparent", padding: `${fs * 0.1}px ${fs * 0.15}px` }}
      >
        {t.inhalt}
      </div>
    );
  }
  return (
    <div className="text-vorschau" style={{ left: t.punkt[0] * iw, top: t.punkt[1] * ih - GRUNDLINIEN_VERSATZ * fs, ...schrift }}>
      {t.inhalt}
    </div>
  );
}

// ------------------------------------------------------------- Texteditor
// MuPDF setzt die erste Grundlinie bei 0,794 × Schriftgröße unter die
// Oberkante, der Browser (Zeilenhöhe 1,2, Arial) bei 0,947 × – Versatz:
const GRUNDLINIEN_VERSATZ = 0.1525;

function TextEditor({ editor, pxProPt, iw, ih, drehung }: { editor: Editor; pxProPt: number; iw: number; ih: number; drehung: number }) {
  const [text, setText] = useState(editor.text);
  const fertigRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    window.setTimeout(() => {
      // preventScroll: sonst springt die Ansicht zum Eingabefeld
      ref.current?.focus({ preventScroll: true });
      const n = ref.current?.value.length ?? 0;
      ref.current?.setSelectionRange(n, n);
    });
  }, []);

  const fertig = async () => {
    if (fertigRef.current) return;
    fertigRef.current = true;
    const e = holen().editor ?? editor;
    setzen({ editor: null });
    const stil = e.stil;
    const leer = !text.trim();
    const schluessel = e.id !== null ? vorschauSchluessel(e.dokId, e.id) : "";
    const textVorschau =
      e.art === "notiz" ? undefined : { inhalt: text, art: e.art as "schreibmaschine" | "textfeld", punkt: e.punkt, rechteck: e.rechteck, stil };
    if (e.id === null) {
      if (leer) return;
      if (e.art === "schreibmaschine")
        await anmerkungAnlegen(
          e.dokId,
          e.seite,
          { art: "schreibmaschine", punkt: e.punkt, text, farbe: stil.farbe, schriftgroesse: stil.schriftgroesse },
          false,
          { werkzeugBleibt: true, vorschau: { seite: e.seite, text: textVorschau, alteV: "" } },
        );
      else if (e.art === "textfeld")
        await anmerkungAnlegen(
          e.dokId,
          e.seite,
          { art: "textfeld", rechteck: e.rechteck, text, farbe: stil.farbe, fuellung: stil.fuellung, schriftgroesse: stil.schriftgroesse, breite: stil.breite },
          true,
          { vorschau: { seite: e.seite, text: textVorschau, alteV: "" } },
        );
      else await anmerkungAnlegen(e.dokId, e.seite, { art: "notiz", punkt: e.punkt, inhalt: text, farbe: stil.farbe }, false);
      return;
    }
    if (leer && e.art !== "notiz") {
      vorschauSetzen(schluessel, null);
      await anmerkungenLoeschen(e.dokId, [{ seite: e.seite, id: e.id }]);
      return;
    }
    const unveraendert =
      text === editor.text && stil.farbe === editor.stil.farbe && stil.schriftgroesse === editor.stil.schriftgroesse && stil.fuellung === editor.stil.fuellung;
    if (unveraendert) {
      vorschauSetzen(schluessel, null);
      return;
    }
    if (e.art === "notiz") {
      vorschauSetzen(schluessel, null);
      await anmerkungAendern(e.dokId, e.seite, e.id, { inhalt: text });
    } else
      await anmerkungAendern(
        e.dokId,
        e.seite,
        e.id,
        { text, farbe: stil.farbe, schriftgroesse: stil.schriftgroesse, fuellung: stil.fuellung },
        { text: textVorschau, versteckt: true },
      );
  };
  const abbrechen = () => {
    fertigRef.current = true;
    if (editor.id !== null) vorschauSetzen(vorschauSchluessel(editor.dokId, editor.id), null);
    setzen({ editor: null });
  };

  const fs = editor.stil.schriftgroesse * pxProPt;
  const gegendreh = drehung ? { transform: `rotate(${-drehung}deg)`, transformOrigin: "top left" } : {};
  if (editor.art === "notiz") {
    return (
      <div className="notiz-editor" style={{ left: `${editor.punkt[0] * 100}%`, top: `${editor.punkt[1] * 100}%`, ...gegendreh }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="notiz-kopf">Notiz{holen().einstellungen?.kuerzel ? ` · ${holen().einstellungen?.kuerzel}` : ""}</div>
        <RsTextarea
          ref={ref}
          wert={text}
          aendern={setText}
          schrift={{ fontSize: 13, lineHeight: "18px", fontFamily: "var(--schrift)", padding: "6px 8px" }}
          breite={240}
          minHoehe={72}
          platzhalter="Notiz schreiben …"
          fertig={() => void fertig()}
          abbrechen={abbrechen}
          label="Notiztext"
        />
      </div>
    );
  }
  const schrift: CSSProperties = {
    fontFamily: "Helvetica, Arial, 'Liberation Sans', sans-serif",
    fontSize: fs,
    lineHeight: 1.2,
    color: editor.stil.farbe,
    padding: 0,
  };
  if (editor.art === "textfeld" && editor.rechteck) {
    const r = editor.rechteck;
    return (
      <div
        className="textfeld-editor"
        style={{ ...stilAus(r), height: "auto", minHeight: `${(r[3] - r[1]) * 100}%`, borderColor: editor.stil.farbe, background: editor.stil.fuellung ?? "transparent" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <RsTextarea
          ref={ref}
          wert={text}
          aendern={setText}
          schrift={{ ...schrift, padding: `${fs * 0.1}px ${fs * 0.15}px` }}
          breite={(r[2] - r[0]) * iw - 2}
          minHoehe={(r[3] - r[1]) * ih - 2}
          fertig={() => void fertig()}
          abbrechen={abbrechen}
          label="Text des Textfelds"
        />
      </div>
    );
  }
  return (
    <div
      className="schreibmaschine-editor"
      style={{ left: editor.punkt[0] * iw, top: editor.punkt[1] * ih - GRUNDLINIEN_VERSATZ * fs }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <RsTextarea ref={ref} wert={text} aendern={setText} schrift={schrift} automatisch fertig={() => void fertig()} abbrechen={abbrechen} label="Schreibmaschinentext" />
    </div>
  );
}

// ---------------------------------------------------------- Formularfeld
function Feld({ feld, dokId, seite, pxProPt, ih }: { feld: Formularfeld; dokId: string; seite: number; pxProPt: number; hoehePt: number; ih: number }) {
  const werkzeug = useZustand((z) => z.werkzeug);
  const [wert, setWert] = useState(feld.wert);
  useEffect(() => setWert(feld.wert), [feld.wert]);
  const hoehePx = (feld.rechteck[3] - feld.rechteck[1]) * ih;
  const fs = Math.max(6, Math.min(hoehePx * 0.7, (feld.schriftgroesse || 10) * pxProPt));
  const stil: CSSProperties = { ...stilAus(feld.rechteck), fontSize: fs, pointerEvents: werkzeug === "hand" ? "auto" : "none" };
  const speichern = (neu: string | boolean) => {
    if (neu === feld.wert) return;
    void formularfeldSetzen(dokId, seite, feld.id, neu);
  };
  if (feld.typ === "ankreuzen" || feld.typ === "auswahlknopf") {
    return (
      <button
        className={`formular-feld ankreuzen${wert ? " an" : ""}${feld.typ === "auswahlknopf" ? " rund" : ""}`}
        style={stil}
        disabled={feld.nur_lesen}
        title={feld.name}
        aria-label={feld.name}
        aria-pressed={Boolean(wert)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          setWert(!wert);
          speichern(!wert);
        }}
      >
        {wert ? "✓" : ""}
      </button>
    );
  }
  if (feld.typ === "auswahlliste" || feld.typ === "liste") {
    return (
      <select
        className="formular-feld"
        style={stil}
        value={String(wert)}
        disabled={feld.nur_lesen}
        title={feld.name}
        aria-label={feld.name}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          setWert(e.target.value);
          speichern(e.target.value);
        }}
      >
        <option value="" />
        {feld.optionen?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  const Element = feld.mehrzeilig ? "textarea" : "input";
  return (
    <Element
      className="formular-feld"
      style={stil}
      value={String(wert)}
      maxLength={feld.max_laenge || undefined}
      readOnly={feld.nur_lesen}
      title={feld.name}
      aria-label={feld.name}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !feld.mehrzeilig) (e.target as HTMLElement).blur();
      }}
      onChange={(e) => setWert(e.target.value)}
      onBlur={() => speichern(String(wert))}
    />
  );
}
