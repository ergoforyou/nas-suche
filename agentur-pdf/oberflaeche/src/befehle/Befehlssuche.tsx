// Befehlssuche (Strg+K): jede Funktion per Stichwort erreichbar.

import { useEffect, useMemo, useRef, useState } from "react";
import { befehleSuchen, REGISTER } from "./register";
import { holen, setzen, useZustand } from "../zustand/store";

export function Befehlssuche() {
  const offen = useZustand((z) => z.befehlssucheOffen);
  const [eingabe, setEingabe] = useState("");
  const [auswahl, setAuswahl] = useState(0);
  const eingabeRef = useRef<HTMLInputElement>(null);
  const listeRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (offen) {
      setEingabe("");
      setAuswahl(0);
      requestAnimationFrame(() => eingabeRef.current?.focus());
    }
  }, [offen]);

  const treffer = useMemo(() => befehleSuchen(eingabe), [eingabe]);
  useEffect(() => setAuswahl(0), [eingabe]);
  useEffect(() => {
    listeRef.current?.querySelector(".gewaehlt")?.scrollIntoView({ block: "nearest" });
  }, [auswahl]);

  if (!offen) return null;
  const schliessen = () => setzen({ befehlssucheOffen: false });
  const ausfuehren = (i: number) => {
    const b = treffer[i];
    if (!b || (b.aktiv && !b.aktiv(holen()))) return;
    schliessen();
    b.ausfuehren();
  };

  return (
    <div className="dialog-hintergrund oben" onMouseDown={schliessen}>
      <div className="befehlssuche" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Befehlssuche">
        <input
          ref={eingabeRef}
          value={eingabe}
          placeholder="Was möchten Sie tun? z. B. „drehen“, „zoom“, „suchen“ …"
          onChange={(e) => setEingabe(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAuswahl((a) => Math.min(treffer.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAuswahl((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              ausfuehren(auswahl);
            } else if (e.key === "Escape") {
              schliessen();
            }
          }}
          aria-label="Funktion suchen"
        />
        <ul ref={listeRef}>
          {treffer.map((b, i) => {
            const aktiv = b.aktiv ? b.aktiv(holen()) : true;
            return (
              <li key={b.id}>
                <button
                  className={`${i === auswahl ? "gewaehlt" : ""}${aktiv ? "" : " inaktiv"}`}
                  onMouseEnter={() => setAuswahl(i)}
                  onClick={() => ausfuehren(i)}
                >
                  <b.icon size={16} strokeWidth={1.6} />
                  <span className="bs-titel">{b.titel}</span>
                  <span className="bs-ort">
                    {REGISTER.find((r) => r.id === b.register)?.titel} › {b.gruppe}
                  </span>
                  {b.kuerzel && <kbd>{b.kuerzel}</kbd>}
                </button>
              </li>
            );
          })}
          {!treffer.length && <li className="leer-hinweis">Keine passende Funktion gefunden.</li>}
        </ul>
      </div>
    </div>
  );
}
