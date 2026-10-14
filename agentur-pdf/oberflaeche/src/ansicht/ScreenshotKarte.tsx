// Karte nach einem Screenshot: öffnen, ins Dokument einfügen, Text kopieren.

import { Camera, ClipboardCopy, FilePlus2, FolderOpen, FileText, X } from "lucide-react";
import { useEffect } from "react";
import { api } from "../api";
import { pfadOeffnen } from "../zustand/aktionen";
import { anwenden } from "../zustand/seitenaktionen";
import { holen, melden, setzen, springen, useZustand } from "../zustand/store";

export function ScreenshotKarte() {
  const s = useZustand((z) => z.screenshot);
  const aktiv = useZustand((z) => z.aktiv);
  const desktop = useZustand((z) => z.desktop);
  useEffect(() => {
    if (!s) return;
    const t = window.setTimeout(() => setzen({ screenshot: null }), 25_000);
    return () => window.clearTimeout(t);
  }, [s]);
  if (!s) return null;
  const name = s.png.split(/[\\/]/).pop();
  const datei = s.pdf ?? s.png;
  const zu = () => setzen({ screenshot: null });
  return (
    <div className="screenshot-karte" role="status" aria-label="Screenshot gespeichert">
      <div className="screenshot-kopf">
        <Camera size={16} />
        <strong>Screenshot gespeichert</strong>
        <span className="abstand" />
        <button aria-label="Schließen" onClick={zu}>
          <X size={14} />
        </button>
      </div>
      <div className="leise klein">
        {name}
        {s.pdf ? " + durchsuchbare PDF" : ""}
      </div>
      {s.text && <div className="screenshot-text">{s.text.slice(0, 160)}{s.text.length > 160 ? " …" : ""}</div>}
      <div className="screenshot-knoepfe">
        <button
          onClick={() => {
            zu();
            void pfadOeffnen(datei);
          }}
        >
          <FileText size={14} /> Öffnen
        </button>
        {aktiv && (
          <button
            onClick={async () => {
              const d = holen().dokumente.find((x) => x.id === aktiv);
              if (!d) return;
              const position = d.ansicht.seite + 1;
              try {
                anwenden(await api.einfuegenPfade(d.id, position, [datei]), d.id);
                springen(d.id, position);
                zu();
              } catch (e) {
                melden((e as Error).message, "fehler");
              }
            }}
          >
            <FilePlus2 size={14} /> In Dokument einfügen
          </button>
        )}
        {s.text && (
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(s.text)
                .then(() => melden("Text kopiert."))
                .catch(() => melden("Kopieren nicht möglich.", "fehler"))
            }
          >
            <ClipboardCopy size={14} /> Text kopieren
          </button>
        )}
        {desktop && (
          <button onClick={() => void api.ordnerZeigen(s.png).catch(() => undefined)}>
            <FolderOpen size={14} /> Im Ordner zeigen
          </button>
        )}
      </div>
    </div>
  );
}
