// „Über Agentur-PDF & Einrichtung“: Version, Bausteine, Protokoll, Explorer-Menü.

import { CheckCircle2, Info, MousePointerClick, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { melden, setzen } from "../zustand/store";

type System = Awaited<ReturnType<typeof api.system>>;

function Zeile({ ok, titel, detail }: { ok: boolean; titel: string; detail?: string }) {
  return (
    <li className={ok ? "ok" : "fehlt"}>
      {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      <span>
        <strong>{titel}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </li>
  );
}

export function InfoDialog() {
  const [s, setS] = useState<System | null>(null);
  useEffect(() => {
    api.system().then(setS).catch(() => undefined);
  }, []);
  const schliessen = () => setzen({ dialog: null });
  const explorer = async (einrichten: boolean) => {
    try {
      await api.explorerMenue(einrichten);
      melden(einrichten ? "Rechtsklick-Einträge im Explorer eingerichtet." : "Rechtsklick-Einträge entfernt.");
    } catch (e) {
      melden((e as Error).message, "fehler");
    }
  };
  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <div className="dialog breit" role="dialog" aria-label="Über Agentur-PDF" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Info size={18} /> Agentur-PDF {s ? s.version : ""}
        </h2>
        {s && (
          <>
            <ul className="bausteine">
              <Zeile ok={!!s.tesseract} titel="Texterkennung (Tesseract)" detail={s.tesseract ? (s.beste_modelle ? "beste Modelle (tessdata_best)" : "Standard-Modelle") : "nicht gefunden"} />
              <Zeile ok={!!s.libreoffice} titel="Word/Excel → PDF (LibreOffice)" detail={s.libreoffice ?? "nicht gefunden – Word/Excel-Dateien können nicht umgewandelt werden"} />
              <Zeile ok={s.woerterbuch} titel="Deutsches Wörterbuch" detail={s.woerterbuch ? "für Texterkennung und Rechtschreibung" : "nicht gefunden"} />
            </ul>
            <p className="leise">
              Einstellungen und Fehlerprotokoll: <code>{s.datenordner}</code> (Datei <code>protokoll.log</code> – bei Problemen bitte mitschicken)
            </p>
            {s.windows && (
              <fieldset className="gruppe">
                <legend>Windows-Explorer</legend>
                <p className="leise">
                  Rechtsklick auf Dateien: „Mit Agentur-PDF öffnen“, „Zu einer PDF zusammenführen“, „In PDF umwandeln“. Wird nur für Ihr
                  Benutzerkonto eingerichtet (keine Administratorrechte nötig). Unter Windows 11 unter „Weitere Optionen anzeigen“.
                </p>
                <div className="zf-werkzeuge">
                  <button className="umschalter" onClick={() => void explorer(true)}>
                    <MousePointerClick size={14} /> Rechtsklick-Einträge einrichten
                  </button>
                  <button className="umschalter" onClick={() => void explorer(false)}>
                    Entfernen
                  </button>
                </div>
              </fieldset>
            )}
          </>
        )}
        <div className="dialog-knoepfe">
          <button className="primaer" onClick={schliessen}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
