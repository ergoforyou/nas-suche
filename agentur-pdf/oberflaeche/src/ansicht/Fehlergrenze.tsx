// Fehlergrenze: Ein Fehler in einem Teil der Oberfläche (Dokumentansicht,
// Dialog, Seitenleiste …) darf nie das ganze Fenster weiß machen. Statt des
// Teils erscheint ein Hinweis mit „Neu laden“ – alles andere bleibt bedienbar,
// ungespeicherte Änderungen liegen ohnehin im Dienst.

import { AlertTriangle, Copy, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Eigenschaften {
  /** Was hier ausgefallen ist, z. B. „Dokumentansicht“ */
  bereich: string;
  children: ReactNode;
  /** vor dem Neuladen aufräumen (z. B. Zoom zurücksetzen) */
  vorNeuladen?: () => void;
  /** statt Hinweis: still zurücksetzen (z. B. Dialog schließen) */
  stillZuruecksetzen?: () => void;
  /** ganzes Programm: Seite neu laden statt Teil neu zeichnen */
  ganzesFenster?: boolean;
}

interface Zustand {
  fehler: Error | null;
  anzahl: number;
}

export class Fehlergrenze extends Component<Eigenschaften, Zustand> {
  state: Zustand = { fehler: null, anzahl: 0 };

  static getDerivedStateFromError(fehler: Error): Partial<Zustand> {
    return { fehler };
  }

  componentDidCatch(fehler: Error, info: ErrorInfo): void {
    console.error(`[${this.props.bereich}]`, fehler, info.componentStack);
    if (this.props.stillZuruecksetzen) {
      this.props.stillZuruecksetzen();
      this.setState({ fehler: null });
    }
  }

  neuLaden = () => {
    if (this.props.ganzesFenster) {
      window.location.reload();
      return;
    }
    try {
      this.props.vorNeuladen?.();
    } finally {
      this.setState((z) => ({ fehler: null, anzahl: z.anzahl + 1 }));
    }
  };

  render() {
    const { fehler } = this.state;
    if (!fehler) return this.props.children;
    if (this.props.stillZuruecksetzen) return null;
    const details = `${this.props.bereich}: ${fehler.message}\n${fehler.stack ?? ""}`;
    return (
      <div className={`fehlergrenze${this.props.ganzesFenster ? " ganz" : ""}`} role="alert">
        <AlertTriangle size={28} />
        <h3>{this.props.ganzesFenster ? "Ergoforyou PDF ist auf einen Fehler gestoßen" : `${this.props.bereich}: Anzeige fehlgeschlagen`}</h3>
        <p className="leise">
          {this.props.ganzesFenster
            ? "Ihre geöffneten Dokumente und ungespeicherten Änderungen bleiben erhalten."
            : "Das Dokument selbst ist nicht betroffen – nur die Anzeige wird neu aufgebaut."}
        </p>
        <div className="fehlergrenze-knoepfe">
          <button type="button" className="primaer" onClick={this.neuLaden}>
            <RotateCcw size={14} /> {this.props.ganzesFenster ? "Neu laden" : "Ansicht neu laden"}
          </button>
          <button type="button" className="umschalter" onClick={() => void navigator.clipboard?.writeText(details).catch(() => undefined)}>
            <Copy size={14} /> Fehlerdetails kopieren
          </button>
        </div>
        <details>
          <summary className="leise klein">Details</summary>
          <pre>{details.slice(0, 2000)}</pre>
        </details>
      </div>
    );
  }
}
