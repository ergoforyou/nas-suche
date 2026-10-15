// Datei-Menü („Backstage“): links die Befehle, rechts zuletzt verwendete
// Dateien bzw. Informationen zum Dokument.

import { ArrowLeft, Clock, FileOutput, FileText, FolderOpen, Info, Layers, Printer, Save, SaveAll, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ausfuehren } from "../befehle/register";
import type { ZuletztEintrag } from "../typen";
import { pfadOeffnen } from "../zustand/aktionen";
import { aktivesDokument, setzen, useZustand } from "../zustand/store";

function zeitText(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? `heute, ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const zu = () => setzen({ dateiMenue: false });

export function DateiMenue() {
  const offen = useZustand((z) => z.dateiMenue);
  const dok = useZustand((z) => aktivesDokument(z));
  const [zuletzt, setZuletzt] = useState<ZuletztEintrag[]>([]);
  useEffect(() => {
    if (offen) api.zuletzt().then(setZuletzt).catch(() => undefined);
  }, [offen]);
  useEffect(() => {
    if (!offen) return;
    const taste = (e: KeyboardEvent) => e.key === "Escape" && zu();
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, [offen]);
  if (!offen) return null;

  const befehl = (id: string) => () => {
    zu();
    ausfuehren(id);
  };
  const eintraege: ({ titel: string; icon: typeof FileText; id: string; dok?: boolean } | "trenner")[] = [
    { titel: "Öffnen …", icon: FolderOpen, id: "datei.oeffnen" },
    { titel: "Zusammenführen …", icon: Layers, id: "konvertieren.zusammenfuehren" },
    "trenner",
    { titel: "Speichern", icon: Save, id: "datei.speichern", dok: true },
    { titel: "Speichern unter …", icon: SaveAll, id: "datei.speichern_unter", dok: true },
    { titel: "Exportieren …", icon: FileOutput, id: "ausgabe.exportieren", dok: true },
    { titel: "Drucken …", icon: Printer, id: "ausgabe.drucken", dok: true },
    "trenner",
    { titel: "Dokumenteigenschaften", icon: Info, id: "dokument.eigenschaften", dok: true },
    { titel: "Schließen", icon: X, id: "datei.schliessen", dok: true },
    "trenner",
    { titel: "Einstellungen & Einrichtung", icon: Settings, id: "hilfe.info" },
  ];

  return (
    <div className="datei-menue" role="dialog" aria-label="Datei">
      <nav className="datei-links">
        <button className="datei-zurueck" onClick={zu} aria-label="Zurück zum Dokument">
          <ArrowLeft size={18} />
        </button>
        {eintraege.map((e, i) =>
          e === "trenner" ? (
            <hr key={i} />
          ) : (
            <button key={e.id} disabled={e.dok && !dok} onClick={befehl(e.id)}>
              <e.icon size={18} strokeWidth={1.6} />
              <span>{e.titel}</span>
            </button>
          ),
        )}
      </nav>
      <section className="datei-rechts">
        <h2>
          <Clock size={18} /> Zuletzt verwendet
        </h2>
        {!zuletzt.length && <p className="leise">Noch keine Dateien geöffnet.</p>}
        <ul className="datei-zuletzt">
          {zuletzt.map((z) => (
            <li key={z.pfad}>
              <button
                disabled={!z.vorhanden}
                title={z.vorhanden ? z.pfad : `${z.pfad} (nicht mehr vorhanden)`}
                onClick={() => {
                  zu();
                  void pfadOeffnen(z.pfad);
                }}
              >
                <FileText size={22} strokeWidth={1.4} color="#C0262D" />
                <span className="datei-name">
                  <strong>{z.titel}</strong>
                  <small>{z.pfad.replace(/[^\\/]+$/, "")}</small>
                </span>
                <span className="leise klein">
                  {z.seiten} S. · {zeitText(z.zeit)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
