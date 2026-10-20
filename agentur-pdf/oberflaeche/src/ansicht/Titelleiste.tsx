// Titelleiste: Programmsymbol, Schnellzugriff (Öffnen, Speichern, Drucken,
// Rückgängig, Wiederholen), Dokumenttitel, Funktionssuche.

import { PRODUKT, STAND } from "../marke";
import { Download, FileText, FolderOpen, Printer, Redo2, Save, Search, Undo2 } from "lucide-react";
import { updateInstallieren } from "../zustand/aktionen";
import { ausfuehren } from "../befehle/register";
import { aktivesDokument, setzen, useZustand } from "../zustand/store";

const SCHNELL = [
  { id: "datei.oeffnen", titel: "Öffnen (Strg+O)", icon: FolderOpen, farbe: "#C08A00", dok: false },
  { id: "datei.speichern", titel: "Speichern (Strg+S)", icon: Save, farbe: "#1F5BAA", dok: true },
  { id: "ausgabe.drucken", titel: "Drucken (Strg+P)", icon: Printer, farbe: "#3B4A5A", dok: true },
  { id: "bearbeiten.rueckgaengig", titel: "Rückgängig (Strg+Z)", icon: Undo2, farbe: "#1F5BAA", dok: true },
  { id: "bearbeiten.wiederholen", titel: "Wiederholen (Strg+Y)", icon: Redo2, farbe: "#1F5BAA", dok: true },
];

export function Titelleiste() {
  const dok = useZustand((z) => aktivesDokument(z));
  const rueckgaengig = dok?.rueckgaengig;
  const wiederholen = dok?.wiederholen;
  const update = useZustand((z) => z.update);
  return (
    <header className="titelleiste">
      <div className="titel-logo" aria-hidden>
        <FileText size={16} />
      </div>
      <div className="schnellzugriff" role="toolbar" aria-label="Schnellzugriff">
        {SCHNELL.map((s) => {
          const aus =
            (s.dok && !dok) ||
            (s.id === "bearbeiten.rueckgaengig" && !rueckgaengig) ||
            (s.id === "bearbeiten.wiederholen" && !wiederholen);
          const titel =
            s.id === "bearbeiten.rueckgaengig" && rueckgaengig ? `Rückgängig: ${rueckgaengig} (Strg+Z)` : s.id === "bearbeiten.wiederholen" && wiederholen ? `Wiederholen: ${wiederholen} (Strg+Y)` : s.titel;
          return (
            <button key={s.id} title={titel} aria-label={titel} disabled={aus} onClick={() => ausfuehren(s.id)} data-befehl={`schnell.${s.id}`}>
              <s.icon size={16} strokeWidth={1.8} color={aus ? undefined : s.farbe} />
            </button>
          );
        })}
      </div>
      <div className="titel-text">
        {dok ? (
          <>
            <strong>{dok.titel}</strong>
            {dok.geaendert && <span className="titel-geaendert"> ●</span>}
            <span className="leise"> – {PRODUKT}</span>
          </>
        ) : (
          <strong>{PRODUKT}</strong>
        )}
      </div>
      <button className="titel-suche" onClick={() => setzen({ befehlssucheOffen: true })} title="Alle Funktionen durchsuchen">
        <Search size={14} />
        <span>Funktion suchen …</span>
        <kbd>Strg+K</kbd>
      </button>
      {update?.version && (
        <button className="update-hinweis" title={`Neue Version ${update.version} im Update-Ordner`} onClick={() => void updateInstallieren()}>
          <Download size={13} /> Update {update.version}
        </button>
      )}
      <button className="testversion" title="Einstellungen, Einrichtung und Version" onClick={() => setzen({ dialog: { art: "info" } })}>
        {STAND}
      </button>
    </header>
  );
}
