// Menüband im Stil klassischer PDF-Programme: „Datei“ öffnet das Datei-Menü,
// darunter Register mit Gruppen aus großen und kleinen, farbigen Schaltflächen.
// Doppelklick auf ein Register klappt das Menüband ein/aus.

import { ChevronDown, ChevronUp, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { befehleFuer, befehlsfarbe } from "../befehle/darstellung";
import { REGISTER, START_GRUPPEN, type Befehl } from "../befehle/register";
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
      onClick={() => {
        b.ausfuehren();
      }}
      data-befehl={b.id}
    >
      <b.icon size={gross ? 26 : 16} strokeWidth={gross ? 1.5 : 1.8} color={aktiv ? befehlsfarbe(b) : undefined} />
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
    <div className="mb-gruppe mb-mehr" ref={ref}>
      <div className="mb-gruppe-inhalt">
        <button className="mb-gross" onClick={() => setOffen((o) => !o)} aria-expanded={offen}>
          <MoreHorizontal size={26} strokeWidth={1.5} />
          <span>
            Mehr <ChevronDown size={11} />
          </span>
        </button>
      </div>
      <div className="mb-gruppe-titel">Weitere</div>
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
                <b.icon size={16} strokeWidth={1.8} color={aktiv ? befehlsfarbe(b) : undefined} />
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
  const klein = useZustand((z) => z.menuebandKlein);
  const dateiMenue = useZustand((z) => z.dateiMenue);
  const eintraege = befehleFuer(register);
  const sichtbar = eintraege.filter((e) => !e.b.versteckt || register === "start");
  let gruppen = [...new Set(sichtbar.map((e) => e.gruppe))];
  if (register === "start") gruppen = START_GRUPPEN.filter((g) => gruppen.includes(g));

  return (
    <div className={`menueband${klein ? " klein" : ""}`}>
      <div className="mb-reiter" role="tablist">
        <button className={`mb-datei${dateiMenue ? " offen" : ""}`} onClick={() => setzen({ dateiMenue: !dateiMenue })} aria-expanded={dateiMenue}>
          Datei
        </button>
        {REGISTER.map((r) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={r.id === register}
            className={r.id === register ? "gewaehlt" : ""}
            onClick={() => setzen({ register: r.id, dateiMenue: false })}
            onDoubleClick={() => setzen((z) => ({ menuebandKlein: !z.menuebandKlein }))}
          >
            {r.titel}
          </button>
        ))}
        <span className="abstand" />
        <button
          className="mb-einklappen"
          title={klein ? "Menüband anzeigen" : "Menüband einklappen"}
          aria-label={klein ? "Menüband anzeigen" : "Menüband einklappen"}
          onClick={() => setzen((z) => ({ menuebandKlein: !z.menuebandKlein }))}
        >
          {klein ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {!klein && (
        <div className="mb-leiste" role="toolbar" aria-label={REGISTER.find((r) => r.id === register)?.titel}>
          {gruppen.map((g) => {
            const inGruppe = sichtbar.filter((e) => e.gruppe === g && (register === "start" || !e.b.versteckt));
            const grosse = inGruppe.filter((e) => e.gross);
            const kleine = inGruppe.filter((e) => !e.gross);
            // kleine Schaltflächen in Spalten zu je drei
            const spalten: (typeof kleine)[] = [];
            for (let i = 0; i < kleine.length; i += 3) spalten.push(kleine.slice(i, i + 3));
            return (
              <div className="mb-gruppe" key={g}>
                <div className="mb-gruppe-inhalt">
                  {grosse.map((e) => (
                    <Schaltflaeche key={e.b.id} b={e.b} gross />
                  ))}
                  {spalten.map((spalte, i) => (
                    <div className="mb-kleine" key={i}>
                      {spalte.map((e) => (
                        <Schaltflaeche key={e.b.id} b={e.b} />
                      ))}
                    </div>
                  ))}
                </div>
                <div className="mb-gruppe-titel">{g}</div>
              </div>
            );
          })}
          {register !== "start" && <MehrMenue befehle={eintraege.filter((e) => e.b.versteckt).map((e) => e.b)} />}
        </div>
      )}
    </div>
  );
}
