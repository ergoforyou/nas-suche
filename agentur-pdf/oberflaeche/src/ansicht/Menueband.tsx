// Menüband mit 6 Registern. Große beschriftete Schaltflächen, Kleinkram
// gruppiert; alles Weitere unter „Mehr“ bzw. über die Befehlssuche.

import { ChevronDown, Command, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { alleBefehle, REGISTER, type Befehl } from "../befehle/register";
import { holen, setzen, useZustand } from "../zustand/store";

function Schaltflaeche({ b, gross }: { b: Befehl; gross?: boolean }) {
  const aktiv = useZustand((z) => (b.aktiv ? b.aktiv(z) : true));
  const gewaehlt = useZustand((z) => (b.gewaehlt ? b.gewaehlt(z) : false));
  const tipp = `${b.titel}${b.kuerzel ? ` (${b.kuerzel})` : ""}${b.beschreibung ? `\n${b.beschreibung}` : ""}`;
  return (
    <button
      className={`${gross ? "mb-gross" : "mb-klein"}${gewaehlt ? " gewaehlt" : ""}`}
      disabled={!aktiv}
      title={tipp}
      aria-pressed={b.gewaehlt ? gewaehlt : undefined}
      onClick={() => b.ausfuehren()}
      data-befehl={b.id}
    >
      <b.icon size={gross ? 22 : 16} strokeWidth={1.6} />
      <span>{b.titel}</span>
    </button>
  );
}

function MehrMenue({ befehle }: { befehle: Befehl[] }) {
  const [offen, setOffen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!offen) return;
    const zu = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOffen(false);
    window.addEventListener("mousedown", zu);
    return () => window.removeEventListener("mousedown", zu);
  }, [offen]);
  if (!befehle.length) return null;
  return (
    <div className="mb-mehr" ref={ref}>
      <button className="mb-gross" onClick={() => setOffen((o) => !o)} aria-expanded={offen}>
        <MoreHorizontal size={22} strokeWidth={1.6} />
        <span>
          Mehr <ChevronDown size={12} />
        </span>
      </button>
      {offen && (
        <div className="menue" role="menu">
          {befehle.map((b) => {
            const aktiv = b.aktiv ? b.aktiv(holen()) : true;
            return (
              <button
                key={b.id}
                role="menuitem"
                disabled={!aktiv}
                onClick={() => {
                  setOffen(false);
                  b.ausfuehren();
                }}
              >
                <b.icon size={16} strokeWidth={1.6} />
                <span>{b.titel}</span>
                {b.kuerzel && <kbd>{b.kuerzel}</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Menueband() {
  const register = useZustand((z) => z.register);
  const info = REGISTER.find((r) => r.id === register)!;
  const befehle = alleBefehle().filter((b) => b.register === register);
  const gruppen = [...new Set(befehle.filter((b) => !b.versteckt).map((b) => b.gruppe))];

  return (
    <div className="menueband">
      <div className="mb-reiter" role="tablist">
        {REGISTER.map((r) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={r.id === register}
            className={r.id === register ? "gewaehlt" : ""}
            onClick={() => setzen({ register: r.id })}
          >
            {r.titel}
          </button>
        ))}
        <button className="mb-befehlssuche" onClick={() => setzen({ befehlssucheOffen: true })} title="Alle Funktionen durchsuchen">
          <Command size={14} />
          <span>Funktion suchen …</span>
          <kbd>Strg+K</kbd>
        </button>
      </div>
      <div className="mb-leiste" role="toolbar" aria-label={info.titel}>
        {gruppen.map((g) => {
          const inGruppe = befehle.filter((b) => b.gruppe === g && !b.versteckt);
          const grosse = inGruppe.filter((b) => b.gross);
          const kleine = inGruppe.filter((b) => !b.gross);
          return (
            <div className="mb-gruppe" key={g}>
              <div className="mb-gruppe-inhalt">
                {grosse.map((b) => (
                  <Schaltflaeche key={b.id} b={b} gross />
                ))}
                {kleine.length > 0 && (
                  <div className="mb-kleine">
                    {kleine.map((b) => (
                      <Schaltflaeche key={b.id} b={b} />
                    ))}
                  </div>
                )}
              </div>
              <div className="mb-gruppe-titel">{g}</div>
            </div>
          );
        })}
        <MehrMenue befehle={befehle.filter((b) => b.versteckt)} />
        {info.geplant && !befehle.length && (
          <div className="mb-geplant">
            <strong>In Vorbereitung.</strong> {info.geplant}
          </div>
        )}
      </div>
    </div>
  );
}
