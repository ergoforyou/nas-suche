// „Text bearbeiten“: vorhandene Textzeilen im PDF anklicken und direkt an Ort
// und Stelle ändern. Enter übernimmt, Esc bricht ab. Die neue Zeile steht
// sofort da (Vorschau), bis die neu gezeichnete Seite geladen ist.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { Textzeile } from "../typen";
import { FARBEN } from "../zustand/anmerkungen";
import { anwenden } from "../zustand/seitenaktionen";
import { melden } from "../zustand/store";

const cache = new Map<string, Textzeile[]>();

const lage = (r: Textzeile["rechteck"]): CSSProperties => ({
  left: `${r[0] * 100}%`,
  top: `${r[1] * 100}%`,
  width: `${(r[2] - r[0]) * 100}%`,
  height: `${(r[3] - r[1]) * 100}%`,
});

export function TextBearbeitung(p: { dokId: string; seite: number; kennung: string; pxProPt: number }) {
  const schluessel = `${p.dokId}:${p.seite}:${p.kennung}`;
  const [zeilen, setZeilen] = useState<Textzeile[] | null>(() => cache.get(schluessel) ?? null);
  const [bearbeiten, setBearbeiten] = useState<{ zeile: Textzeile; text: string; groesse: number; farbe: string } | null>(null);
  /** Klickposition in der Zeile (0..1) → Schreibmarke dort setzen */
  const klickAnteil = useRef(1);
  const [vorschau, setVorschau] = useState<{ zeile: Textzeile; text: string; groesse: number; farbe: string; kennung: string } | null>(null);
  const eingabe = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let aktuell = true;
    const vorhanden = cache.get(schluessel);
    if (vorhanden) setZeilen(vorhanden);
    else
      api
        .textzeilen(p.dokId, p.seite)
        .then((z) => {
          cache.set(schluessel, z);
          if (aktuell) setZeilen(z);
        })
        .catch(() => undefined);
    return () => {
      aktuell = false;
    };
  }, [schluessel, p.dokId, p.seite]);

  // Vorschau verschwindet, sobald die geänderte Seite da ist
  useEffect(() => {
    if (vorschau && vorschau.kennung !== p.kennung) {
      const t = window.setTimeout(() => setVorschau(null), 350);
      return () => window.clearTimeout(t);
    }
  }, [p.kennung, vorschau]);

  useLayoutEffect(() => {
    const el = eingabe.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const pos = Math.round(el.value.length * klickAnteil.current);
    el.setSelectionRange(pos, pos);
  }, [bearbeiten?.zeile.bbox.join()]);

  const uebernehmen = async () => {
    const b = bearbeiten;
    if (!b) return;
    setBearbeiten(null);
    const gleich = b.text === b.zeile.text && b.groesse === b.zeile.groesse && b.farbe.toUpperCase() === b.zeile.farbe.toUpperCase();
    if (gleich) return;
    setVorschau({ ...b, kennung: p.kennung });
    try {
      const r = await api.textErsetzen(
        p.dokId,
        p.seite,
        b.zeile.bbox,
        b.text,
        b.groesse !== b.zeile.groesse ? b.groesse : undefined,
        b.farbe.toUpperCase() !== b.zeile.farbe.toUpperCase() ? b.farbe : undefined,
      );
      anwenden(r);
    } catch (e) {
      setVorschau(null);
      melden((e as Error).message, "fehler");
    }
  };

  const schrift = (z: Textzeile, groesse: number, farbe: string): CSSProperties => ({
    fontFamily: z.css_schrift,
    fontSize: groesse * p.pxProPt,
    fontWeight: z.fett ? 700 : 400,
    fontStyle: z.kursiv ? "italic" : "normal",
    color: farbe,
    lineHeight: 1,
  });

  return (
    <div className="tb-ebene">
      {zeilen?.map((z, i) =>
        z.bearbeitbar && !(bearbeiten && bearbeiten.zeile === z) ? (
          <div
            key={i}
            className="tb-zeile"
            style={lage(z.rechteck)}
            title="Klicken zum Bearbeiten"
            data-text={z.text}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              klickAnteil.current = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
              setBearbeiten({ zeile: z, text: z.text, groesse: z.groesse, farbe: z.farbe });
            }}
          />
        ) : null,
      )}
      {vorschau && (
        <div className="tb-vorschau" style={{ ...lage(vorschau.zeile.rechteck), ...schrift(vorschau.zeile, vorschau.groesse, vorschau.farbe) }}>
          {vorschau.text}
        </div>
      )}
      {bearbeiten && (
        <div
          className="tb-editor"
          style={lage(bearbeiten.zeile.rechteck)}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            // erst übernehmen, wenn der Fokus den Editor ganz verlässt (nicht beim Klick auf Größe/Farbe)
            if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
            void uebernehmen();
          }}
        >
          <div className="tb-leiste">
            <span className="leise" title={`Schrift im Dokument: ${bearbeiten.zeile.schrift}`}>
              {bearbeiten.zeile.schrift}
            </span>
            <select
              value={bearbeiten.groesse}
              onChange={(e) => {
                setBearbeiten({ ...bearbeiten, groesse: Number(e.target.value) });
                eingabe.current?.focus({ preventScroll: true });
              }}
              aria-label="Schriftgröße"
            >
              {[...new Set([bearbeiten.zeile.groesse, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36])]
                .sort((a, b) => a - b)
                .map((g) => (
                  <option key={g} value={g}>
                    {String(g).replace(".", ",")} pt
                  </option>
                ))}
            </select>
            {[bearbeiten.zeile.farbe, ...FARBEN.filter((f) => f.toUpperCase() !== bearbeiten.zeile.farbe.toUpperCase()).slice(0, 5)].map((f) => (
              <button
                key={f}
                type="button"
                className={`farbe${bearbeiten.farbe.toUpperCase() === f.toUpperCase() ? " gewaehlt" : ""}`}
                style={{ background: f }}
                aria-label={`Farbe ${f}`}
                onClick={() => {
                  setBearbeiten({ ...bearbeiten, farbe: f });
                  eingabe.current?.focus({ preventScroll: true });
                }}
              />
            ))}
          </div>
          <input
            ref={eingabe}
            className="tb-eingabe"
            value={bearbeiten.text}
            aria-label="Text der Zeile"
            spellCheck
            style={schrift(bearbeiten.zeile, bearbeiten.groesse, bearbeiten.farbe)}
            onChange={(e) => setBearbeiten({ ...bearbeiten, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void uebernehmen();
              if (e.key === "Escape") setBearbeiten(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
