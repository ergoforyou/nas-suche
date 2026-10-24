// Formular gestalten: Felder aufziehen (oder klicken), anklicken, verschieben,
// an den Griffen in der Größe ändern, Entf löscht. Eigenschaften rechts.

import { CheckSquare, ChevronDownSquare, List, PenLine, TextCursorInput } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import type { Formularfeld, FormularTyp, Punkt, Rechteck } from "../typen";
import { formularfeldAendern, formularfeldAnlegen } from "../zustand/anmerkungen";
import { holen, setzen, useZustand } from "../zustand/store";
import { GRIFFE, groesseAendern, norm, normPunkt, stilAus } from "./Anmerkungen";

type Op =
  | { art: "neu"; p0: Punkt; p1: Punkt }
  | { art: "verschieben"; feld: Formularfeld; p0: Punkt; p1: Punkt }
  | { art: "groesse"; feld: Formularfeld; griff: string; p0: Punkt; p1: Punkt };

/** Standardgröße beim einfachen Klicken (in pt) */
const STANDARD_PT: Record<FormularTyp, [number, number]> = {
  text: [170, 20],
  ankreuzen: [13, 13],
  auswahlliste: [150, 20],
  liste: [150, 60],
  unterschrift: [180, 42],
};

const SYMBOL = { text: TextCursorInput, ankreuzen: CheckSquare, auswahlknopf: CheckSquare, auswahlliste: ChevronDownSquare, liste: List, unterschrift: PenLine };

function verschoben(r: Rechteck, dx: number, dy: number): Rechteck {
  // im Blatt halten
  const b = r[2] - r[0];
  const h = r[3] - r[1];
  const x0 = Math.max(0, Math.min(1 - b, r[0] + dx));
  const y0 = Math.max(0, Math.min(1 - h, r[1] + dy));
  return [x0, y0, x0 + b, y0 + h];
}

export function FormularGestaltung(p: {
  dokId: string;
  seite: number;
  felder: Formularfeld[];
  aussen: RefObject<HTMLDivElement | null>;
  drehung: number;
  breitePt: number;
  hoehePt: number;
}) {
  const typ = useZustand((z) => z.formularTyp);
  const auswahl = useZustand((z) => (z.formularAuswahl?.dokId === p.dokId && z.formularAuswahl.seite === p.seite ? z.formularAuswahl.id : null));
  const [op, setOp] = useState<Op | null>(null);

  const punkt = (e: { clientX: number; clientY: number }) => normPunkt(e, p.aussen.current!, p.drehung);

  useEffect(() => {
    if (!op) return;
    const bewegen = (e: MouseEvent) => setOp((o) => (o ? { ...o, p1: punkt(e) } : o));
    const los = (e: MouseEvent) => {
      const o = op;
      setOp(null);
      const p1 = punkt(e);
      const dx = p1[0] - o.p0[0];
      const dy = p1[1] - o.p0[1];
      const bewegt = Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002;
      if (o.art === "neu") {
        let r = norm(o.p0, p1);
        if (r[2] - r[0] < 0.01 && r[3] - r[1] < 0.01) {
          const [b, h] = STANDARD_PT[holen().formularTyp];
          r = verschoben([o.p0[0], o.p0[1], o.p0[0] + b / p.breitePt, o.p0[1] + h / p.hoehePt], 0, 0);
        }
        void formularfeldAnlegen(p.dokId, p.seite, holen().formularTyp, r);
      } else if (bewegt) {
        const r = o.art === "verschieben" ? verschoben(o.feld.rechteck, dx, dy) : groesseAendern(o.feld.rechteck, o.griff, dx, dy, null);
        void formularfeldAendern(p.dokId, p.seite, o.feld.id, { rechteck: r });
      }
    };
    window.addEventListener("mousemove", bewegen);
    window.addEventListener("mouseup", los, { once: true });
    return () => {
      window.removeEventListener("mousemove", bewegen);
      window.removeEventListener("mouseup", los);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op?.art, op && "feld" in op ? op.feld.id : null]);

  const lage = (f: Formularfeld): Rechteck => {
    if (op && op.art !== "neu" && op.feld.id === f.id) {
      const dx = op.p1[0] - op.p0[0];
      const dy = op.p1[1] - op.p0[1];
      return op.art === "verschieben" ? verschoben(f.rechteck, dx, dy) : groesseAendern(f.rechteck, op.griff, dx, dy, null);
    }
    return f.rechteck;
  };

  return (
    <div
      className="fg-ebene"
      data-typ={typ}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        setzen({ formularAuswahl: null });
        const pt = punkt(e);
        setOp({ art: "neu", p0: pt, p1: pt });
      }}
    >
      {p.felder.map((f) => {
        const Symbol = SYMBOL[f.typ] ?? TextCursorInput;
        const gewaehlt = auswahl === f.id;
        return (
          <div
            key={f.id}
            className={`fg-feld fg-${f.typ}${gewaehlt ? " gewaehlt" : ""}`}
            style={stilAus(lage(f))}
            title={`${f.name} – ziehen zum Verschieben`}
            data-feld={f.name}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              setzen({ formularAuswahl: { dokId: p.dokId, seite: p.seite, id: f.id }, rechtsOffen: true });
              const pt = punkt(e);
              setOp({ art: "verschieben", feld: f, p0: pt, p1: pt });
            }}
          >
            {f.typ !== "ankreuzen" && (
              <span className="fg-name">
                <Symbol size={11} /> {f.name}
                {f.pflicht ? " *" : ""}
              </span>
            )}
            {gewaehlt &&
              GRIFFE.map((g) => (
                <span
                  key={g}
                  className={`griff griff-${g}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const pt = punkt(e);
                    setOp({ art: "groesse", feld: f, griff: g, p0: pt, p1: pt });
                  }}
                />
              ))}
          </div>
        );
      })}
      {op?.art === "neu" && <div className="fg-neu" style={stilAus(norm(op.p0, op.p1))} />}
    </div>
  );
}
