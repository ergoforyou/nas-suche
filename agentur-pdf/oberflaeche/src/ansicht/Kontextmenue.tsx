// Schlichtes Rechtsklick-Menü (wird an Mausposition geöffnet).

import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuePunkt =
  | { titel: string; icon?: LucideIcon; kuerzel?: string; aktion: () => void; deaktiviert?: boolean; gefahr?: boolean }
  | "trenner";

export function Kontextmenue(props: { x: number; y: number; punkte: MenuePunkt[]; schliessen: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });

  // Am Bildschirmrand nicht abschneiden
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(props.x, window.innerWidth - r.width - 8),
      y: Math.min(props.y, window.innerHeight - r.height - 8),
    });
  }, [props.x, props.y]);

  const schliessenRef = useRef(props.schliessen);
  schliessenRef.current = props.schliessen;
  useEffect(() => {
    const schliessen = () => schliessenRef.current();
    const zu = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      schliessen();
    };
    window.addEventListener("mousedown", zu);
    window.addEventListener("keydown", zu);
    window.addEventListener("blur", schliessen);
    window.addEventListener("wheel", schliessen, { passive: true });
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("mousedown", zu);
      window.removeEventListener("keydown", zu);
      window.removeEventListener("blur", schliessen);
      window.removeEventListener("wheel", schliessen);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="menue kontextmenue"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const knoepfe = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = knoepfe.indexOf(document.activeElement as HTMLButtonElement);
        knoepfe[(i + (e.key === "ArrowDown" ? 1 : -1) + knoepfe.length) % knoepfe.length]?.focus();
      }}
    >
      {props.punkte.map((p, i) =>
        p === "trenner" ? (
          <div key={i} className="menue-trenner" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={p.deaktiviert}
            className={p.gefahr ? "gefahr" : ""}
            onClick={() => {
              props.schliessen();
              p.aktion();
            }}
          >
            {p.icon ? <p.icon size={16} strokeWidth={1.6} /> : <span style={{ width: 16 }} />}
            <span>{p.titel}</span>
            {p.kuerzel && <kbd>{p.kuerzel}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
