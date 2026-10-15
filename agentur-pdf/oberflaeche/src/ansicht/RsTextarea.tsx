// Textfeld mit eigener Rechtschreibprüfung (Hunspell de_DE + Fachwörter im
// Dienst): Falsche Wörter bekommen eine rote Wellenlinie, Rechtsklick zeigt
// Vorschläge. Technik: Hinter dem (durchsichtigen) Textfeld liegt ein
// „Spiegel“ mit identischer Schrift, in dem die Fehler unterstrichen sind.

import { BookPlus, Check } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { RsFehler } from "../typen";
import { Kontextmenue, type MenuePunkt } from "./Kontextmenue";

export interface RsTextareaProps {
  wert: string;
  aendern: (text: string) => void;
  /** Schrift, Farbe, Zeilenhöhe … (gilt für Feld und Spiegel) */
  schrift: CSSProperties;
  /** true = wächst mit dem Text in Breite und Höhe (Schreibmaschine) */
  automatisch?: boolean;
  /** feste Breite in px (Textfeld, Notiz) – Höhe wächst */
  breite?: number;
  minHoehe?: number;
  platzhalter?: string;
  fertig?: () => void;
  abbrechen?: () => void;
  className?: string;
  label?: string;
}

const ignoriert = new Set<string>();

export const RsTextarea = forwardRef<HTMLTextAreaElement, RsTextareaProps>(function RsTextarea(p, ref) {
  const feld = useRef<HTMLTextAreaElement>(null);
  const spiegel = useRef<HTMLDivElement>(null);
  const [fehler, setFehler] = useState<RsFehler[]>([]);
  const [groesse, setGroesse] = useState({ b: p.breite ?? 40, h: p.minHoehe ?? 20 });
  const [menue, setMenue] = useState<{ x: number; y: number; f: RsFehler; vorschlaege: string[] | null } | null>(null);
  useImperativeHandle(ref, () => feld.current!);

  // Prüfen (verzögert, alte Anfragen abbrechen)
  useEffect(() => {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      if (!p.wert.trim()) {
        setFehler([]);
        return;
      }
      api
        .rechtschreibung(p.wert, ctrl.signal)
        .then((f) => setFehler(f.filter((x) => !ignoriert.has(x.wort))))
        .catch(() => undefined);
    }, 350);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [p.wert]);

  // Größe aus dem Spiegel übernehmen
  useLayoutEffect(() => {
    const s = spiegel.current;
    if (!s) return;
    const zeilenhoehe = parseFloat(getComputedStyle(s).lineHeight) || 16;
    const b = p.automatisch ? Math.ceil(s.scrollWidth) + zeilenhoehe : p.breite ?? s.scrollWidth;
    const h = Math.max(p.minHoehe ?? 0, Math.ceil(s.scrollHeight));
    setGroesse((alt) => (alt.b === b && alt.h === h ? alt : { b, h }));
  }, [p.wert, p.automatisch, p.breite, p.minHoehe, p.schrift.fontSize]);

  // Spiegeltext mit markierten Fehlern
  const teile: (string | { f: RsFehler; text: string })[] = [];
  let pos = 0;
  for (const f of fehler) {
    if (f.start < pos || f.ende > p.wert.length || p.wert.slice(f.start, f.ende) !== f.wort) continue;
    teile.push(p.wert.slice(pos, f.start), { f, text: f.wort });
    pos = f.ende;
  }
  teile.push(p.wert.slice(pos) + "​");

  const fehlerAnPunkt = (x: number, y: number): RsFehler | null => {
    for (const span of spiegel.current?.querySelectorAll<HTMLSpanElement>("span.rs-fehler") ?? []) {
      for (const r of span.getClientRects()) {
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 2 && y <= r.bottom + 2) {
          const f = fehler[Number(span.dataset.index)];
          if (f) return f;
        }
      }
    }
    return null;
  };

  const ersetzen = (f: RsFehler, neu: string) => {
    p.aendern(p.wert.slice(0, f.start) + neu + p.wert.slice(f.ende));
    window.setTimeout(() => {
      feld.current?.focus({ preventScroll: true });
      const c = f.start + neu.length;
      feld.current?.setSelectionRange(c, c);
    });
  };

  const weisseRaum: CSSProperties = p.automatisch ? { whiteSpace: "pre" } : { whiteSpace: "pre-wrap", overflowWrap: "break-word" };
  const punkte: MenuePunkt[] = menue
    ? [
        ...(menue.vorschlaege === null
          ? [{ titel: "Vorschläge werden gesucht …", aktion: () => undefined, deaktiviert: true }]
          : menue.vorschlaege.length
            ? menue.vorschlaege.map((v) => ({ titel: v, icon: Check, aktion: () => ersetzen(menue.f, v) }))
            : [{ titel: "Keine Vorschläge", aktion: () => undefined, deaktiviert: true }]),
        "trenner" as const,
        {
          titel: `„${menue.f.wort}“ ins Wörterbuch`,
          icon: BookPlus,
          aktion: () => {
            ignoriert.add(menue.f.wort);
            setFehler((alt) => alt.filter((x) => x.wort !== menue.f.wort));
            void api.woerterbuchHinzufuegen(menue.f.wort);
          },
        },
        {
          titel: "Ignorieren",
          aktion: () => {
            ignoriert.add(menue.f.wort);
            setFehler((alt) => alt.filter((x) => x.wort !== menue.f.wort));
          },
        },
      ]
    : [];

  return (
    <div className={`rs-feld ${p.className ?? ""}`} style={{ width: groesse.b, height: groesse.h }}>
      <div ref={spiegel} className="rs-spiegel" style={{ ...p.schrift, ...weisseRaum, width: p.automatisch ? "auto" : groesse.b }} aria-hidden>
        {teile.map((t, i) =>
          typeof t === "string" ? (
            t
          ) : (
            <span key={i} className="rs-fehler" data-index={fehler.indexOf(t.f)}>
              {t.text}
            </span>
          ),
        )}
      </div>
      <textarea
        ref={feld}
        className="rs-eingabe"
        value={p.wert}
        aria-label={p.label ?? "Text"}
        placeholder={p.platzhalter}
        spellCheck={false}
        style={{ ...p.schrift, ...weisseRaum, width: groesse.b, height: groesse.h }}
        onChange={(e) => p.aendern(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            (p.fertig ?? p.abbrechen)?.();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            p.fertig?.();
          }
        }}
        onBlur={() => {
          if (!menue) p.fertig?.();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          const f = fehlerAnPunkt(e.clientX, e.clientY);
          if (!f) return; // normales Menü (Kopieren/Einfügen)
          e.preventDefault();
          setMenue({ x: e.clientX, y: e.clientY, f, vorschlaege: null });
          api
            .vorschlaege(f.wort)
            .then((v) => setMenue((m) => (m && m.f === f ? { ...m, vorschlaege: v } : m)))
            .catch(() => setMenue((m) => (m && m.f === f ? { ...m, vorschlaege: [] } : m)));
        }}
      />
      {menue && (
        <Kontextmenue
          x={menue.x}
          y={menue.y}
          punkte={punkte}
          schliessen={() => {
            setMenue(null);
            window.setTimeout(() => feld.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </div>
  );
});
