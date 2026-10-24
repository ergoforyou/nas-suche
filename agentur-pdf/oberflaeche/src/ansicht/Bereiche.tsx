// Dokumentbereich: ein Dokument oder mehrere nebeneinander (vertikal geteilt),
// im geteilten Modus jedes mit eigener Miniaturleiste.

import { Columns2, X } from "lucide-react";
import { Dokumentansicht } from "./Dokumentansicht";
import { Fehlergrenze } from "./Fehlergrenze";
import { Miniaturen } from "./Miniaturen";
import { ansichtAendern, bereichSchliessen, setzen, useZustand } from "../zustand/store";

/** Dokumentansicht mit Fehlergrenze – bei „Ansicht neu laden“ fester Zoom, damit
 * ein Fehler in der automatischen Zoomberechnung nicht sofort wiederkommt. */
function GeschuetzteAnsicht({ dokId }: { dokId: string }) {
  return (
    <Fehlergrenze bereich="Dokumentansicht" vorNeuladen={() => ansichtAendern(dokId, { zoomModus: "frei" })}>
      <Dokumentansicht dokId={dokId} />
    </Fehlergrenze>
  );
}

export function Bereiche() {
  const bereiche = useZustand((z) => z.bereiche);
  const aktiv = useZustand((z) => z.aktiv);
  if (bereiche.length <= 1) {
    return aktiv ? <GeschuetzteAnsicht key={aktiv} dokId={aktiv} /> : null;
  }
  return (
    <div className="bereiche">
      {bereiche.map((id) => (
        <Bereich key={id} dokId={id} fokus={id === aktiv} />
      ))}
    </div>
  );
}

function Bereich({ dokId, fokus }: { dokId: string; fokus: boolean }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const miniGroesse = useZustand((z) => Math.min(z.seitenleiste.miniGroesse, 110));
  if (!dok) return null;
  return (
    <section
      className={fokus ? "bereich fokus" : "bereich"}
      onMouseDownCapture={() => !fokus && setzen({ aktiv: dokId })}
      aria-label={dok.titel}
      data-testid="bereich"
    >
      <header className="bereich-kopf">
        <Columns2 size={14} />
        <span className="bereich-titel" title={dok.pfad ?? dok.titel}>
          {dok.titel}
          {dok.geaendert && <span className="geaendert-punkt" title="Ungespeicherte Änderungen" />}
        </span>
        <span className="bereich-info">{dok.seitenanzahl} S.</span>
        <button className="symbol" aria-label="Bereich schließen" title="Aus der Nebeneinander-Ansicht entfernen" onClick={() => bereichSchliessen(dokId)}>
          <X size={14} />
        </button>
      </header>
      <div className="bereich-inhalt">
        <div className="bereich-miniaturen" style={{ width: miniGroesse + 40 }}>
          <Miniaturen dok={dok} groesse={miniGroesse} />
        </div>
        <GeschuetzteAnsicht dokId={dokId} />
      </div>
    </section>
  );
}
