// PDF-Drucker „Agentur-PDF“: aus jedem Programm drucken → öffnet sich hier
// als neues Dokument (Einrichtung einmalig mit Administratorrechten).

import { Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { melden, setzen } from "../zustand/store";

type Status = Awaited<ReturnType<typeof api.druckerStatus>>;

export function DruckerBereich() {
  const [s, setS] = useState<Status | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  useEffect(() => {
    api.druckerStatus().then(setS).catch(() => undefined);
  }, []);
  const ausfuehren = async (einrichten: boolean) => {
    setLaeuft(true);
    melden(einrichten ? "Windows fragt gleich nach Administratorrechten …" : "Drucker wird entfernt …");
    try {
      const neu = await api.druckerEinrichten(einrichten);
      setS(neu);
      melden(einrichten ? `Drucker „${neu.name}“ ist eingerichtet.` : "Drucker entfernt.");
    } catch (e) {
      melden((e as Error).message, "fehler");
    }
    setLaeuft(false);
  };
  return (
    <fieldset className="gruppe">
      <legend>
        <Printer size={13} /> PDF-Drucker
      </legend>
      <p className="leise">
        In Word, Outlook, im Browser oder in der Fachsoftware „Drucken“ wählen und als Drucker <strong>Agentur-PDF</strong> nehmen – der
        Ausdruck öffnet sich hier sofort als neues Dokument (zum Prüfen, Ergänzen, Zusammenführen oder Speichern).
      </p>
      {s && !s.windows && <p className="leise">Den Drucker gibt es nur im Windows-Programm.</p>}
      {s?.windows && (
        <>
          <p className={s.eingerichtet ? "leise" : "warnung"}>
            {s.eingerichtet ? `Eingerichtet – Druckordner: ${s.ordner}` : "Noch nicht eingerichtet (einmalig je PC, braucht Administratorrechte)."}
          </p>
          <div className="auswahl-zeile">
            <button type="button" className="umschalter" disabled={laeuft} onClick={() => void ausfuehren(true)}>
              {s.eingerichtet ? "Neu einrichten" : "Drucker einrichten …"}
            </button>
            {s.eingerichtet && (
              <button type="button" className="umschalter" disabled={laeuft} onClick={() => void ausfuehren(false)}>
                Drucker entfernen
              </button>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

export function DruckerDialog() {
  const zu = () => setzen({ dialog: null });
  return (
    <div className="dialog-hintergrund" onMouseDown={zu}>
      <div className="dialog breit" role="dialog" aria-label="PDF-Drucker" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && zu()}>
        <h2>
          <Printer size={18} /> PDF-Drucker „Agentur-PDF“
        </h2>
        <DruckerBereich />
        <div className="dialog-knoepfe">
          <button className="primaer" onClick={zu}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
