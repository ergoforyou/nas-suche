// PDF-Drucker „Agentur-PDF“: aus jedem Programm drucken → öffnet sich hier
// als neues Dokument (Einrichtung einmalig mit Administratorrechten).

import { Globe, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ChromeStatus } from "../api";
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

/** Google Chrome: Seitenleiste (Erweiterung) einrichten */
export function ChromeBereich() {
  const [s, setS] = useState<ChromeStatus | null>(null);
  useEffect(() => {
    api.chromeStatus().then(setS).catch(() => undefined);
  }, []);
  return (
    <fieldset className="gruppe">
      <legend>
        <Globe size={13} /> Google Chrome
      </legend>
      <p className="leise">
        Die <strong>Agentur-PDF-Seitenleiste</strong> in Chrome: Dateien und Bilder hineinziehen, zusammenführen, umwandeln (auch E-Mails), Seiten drehen
        oder löschen, Vorschau, speichern und drucken – direkt neben dem Kundenportal oder Webmailer. Rechtsklick auf Links/Bilder: „Mit Agentur-PDF
        öffnen“.
      </p>
      <ol className="leise anleitung">
        <li>Unten auf „Chrome einrichten …“ klicken – Chrome öffnet die Erweiterungsseite, der Ordnerpfad liegt in der Zwischenablage.</li>
        <li>Oben rechts „Entwicklermodus“ einschalten, dann „Entpackte Erweiterung laden“.</li>
        <li>Im Ordnerfenster oben in die Adresszeile klicken, Strg+V, Enter, „Ordner auswählen“.</li>
        <li>Puzzle-Symbol → Agentur-PDF anheften. Klick auf das Symbol (oder Alt+Umschalt+P) öffnet die Leiste.</li>
      </ol>
      {s && !s.vorhanden && <p className="warnung">Erweiterung nicht gefunden: {s.ordner}</p>}
      {s?.windows && s.vorhanden && (
        <div className="auswahl-zeile">
          <button
            type="button"
            className="umschalter"
            onClick={async () => {
              try {
                const neu = await api.chromeEinrichten();
                setS(neu);
                melden(neu.chrome ? "Chrome geöffnet – Ordnerpfad ist in der Zwischenablage." : "Chrome nicht gefunden – Ordner wurde geöffnet.");
              } catch (e) {
                melden((e as Error).message, "fehler");
              }
            }}
          >
            Chrome einrichten …
          </button>
          <span className="leise klein">{s.ordner}</span>
        </div>
      )}
    </fieldset>
  );
}
