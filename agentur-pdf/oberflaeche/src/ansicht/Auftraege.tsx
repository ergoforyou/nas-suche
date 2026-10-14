// Fortschritt der Hintergrundaufträge (unten rechts), Abbrechen möglich.

import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { auftragAbbrechen, auftragAusblenden } from "../zustand/konvertieren";
import { useZustand } from "../zustand/store";

export function Auftraege() {
  // Aufträge aus dem Zusammenführen-Dialog zeigt der Dialog selbst
  const dialogOffen = useZustand((z) => z.dialog?.art === "zusammenfuehren");
  const auftraege = useZustand((z) => z.auftraege);
  const sichtbar = dialogOffen ? [] : auftraege;
  if (!sichtbar.length) return null;
  return (
    <div className="auftraege" aria-live="polite">
      {sichtbar.map((a) => {
        const laeuft = a.status === "laeuft" || a.status === "wartet";
        return (
          <div key={a.id} className={`auftrag ${a.status}`}>
            {laeuft ? (
              <Loader2 size={16} className="dreht" />
            ) : a.status === "fertig" ? (
              <CheckCircle2 size={16} />
            ) : (
              <XCircle size={16} />
            )}
            <div className="auftrag-text">
              <strong>{a.titel}</strong>
              <span>{a.status === "fehler" ? a.fehler : a.status === "abgebrochen" ? "Abgebrochen" : a.schritt}</span>
              {laeuft && (
                <div className="balken">
                  <div style={{ width: `${Math.round(a.fortschritt * 100)}%` }} />
                </div>
              )}
            </div>
            <button
              className="symbol"
              aria-label={laeuft ? "Abbrechen" : "Ausblenden"}
              title={laeuft ? "Abbrechen" : "Ausblenden"}
              onClick={() => (laeuft ? auftragAbbrechen(a.id) : auftragAusblenden(a.id))}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
