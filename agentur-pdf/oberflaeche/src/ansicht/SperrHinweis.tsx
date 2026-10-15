// Hinweis, wenn die Datei gerade bei jemand anderem geöffnet ist (NAS).
// Schwebt über dem Dokument – blendet sich ein/aus, ohne dass die Seite
// verrutscht.

import { Lock, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { speichernUnter } from "../zustand/seitenaktionen";
import { aktivesDokument, dokumentAktualisieren, melden, useZustand } from "../zustand/store";

export function SperrHinweis() {
  const dok = useZustand((z) => aktivesDokument(z));
  const [zu, setZu] = useState<string | null>(null);
  const [prueft, setPrueft] = useState(false);
  const s = dok?.gesperrt_von;
  if (!dok || !s || zu === dok.id) return null;
  const seit = s.seit ? new Date(s.seit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="sperr-hinweis" role="status" aria-label="Datei ist bei jemand anderem geöffnet">
      <Lock size={16} />
      <span>
        <strong>Bei {s.benutzer}</strong> (PC {s.rechner}){seit ? ` seit ${seit} Uhr` : ""} geöffnet – Änderungen bitte unter anderem
        Namen speichern.
      </span>
      <button onClick={() => void speichernUnter(dok)}>Speichern unter …</button>
      <button
        title="Erneut prüfen, ob die Datei frei ist"
        aria-label="Erneut prüfen"
        disabled={prueft}
        onClick={async () => {
          setPrueft(true);
          try {
            const info = await api.sperrePruefen(dok.id);
            dokumentAktualisieren(info);
            if (!info.gesperrt_von) melden(`„${info.titel}“ ist jetzt frei.`);
            else melden(`„${info.titel}“ ist weiterhin bei ${info.gesperrt_von.benutzer} geöffnet.`);
          } catch {
            /* still */
          }
          setPrueft(false);
        }}
      >
        <RefreshCw size={14} />
      </button>
      <button aria-label="Hinweis ausblenden" title="Ausblenden" onClick={() => setZu(dok.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
