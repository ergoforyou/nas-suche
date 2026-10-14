// Tabs, Eigenschaftsleiste, Statusleiste, Meldungen, Passwortdialog.

import { BookOpen, ChevronsDown, Columns2, FileText, Lock, Minus, Pin, Plus, RectangleVertical, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dokumentSchliessen, oeffnenDialog } from "../zustand/aktionen";
import { Kontextmenue } from "./Kontextmenue";
import {
  aktivesDokument,
  modusSetzen,
  nebeneinanderOeffnen,
  setzen,
  springen,
  tabVerschieben,
  useZustand,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomSchritt,
  zoomSetzen,
} from "../zustand/store";
import type { AnsichtsModus } from "../typen";

// ------------------------------------------------------------------- Tabs
export function Tabs() {
  const dokumente = useZustand((z) => z.dokumente);
  const aktiv = useZustand((z) => z.aktiv);
  const [ziehe, setZiehe] = useState<number | null>(null);
  const [tabMenue, setTabMenue] = useState<{ x: number; y: number; id: string } | null>(null);

  return (
    <div className="tabs" role="tablist" aria-label="Geöffnete Dokumente">
      <div className="tabs-logo" aria-hidden>
        <FileText size={16} />
        <span>Agentur-PDF</span>
      </div>
      {dokumente.map((d, i) => (
        <div
          key={d.id}
          role="tab"
          aria-selected={d.id === aktiv}
          className={d.id === aktiv ? "tab aktiv" : "tab"}
          title={d.pfad ?? d.titel}
          draggable
          onDragStart={() => setZiehe(i)}
          onDragOver={(e) => {
            if (ziehe !== null) e.preventDefault();
          }}
          onDrop={() => {
            if (ziehe !== null && ziehe !== i) tabVerschieben(ziehe, i);
            setZiehe(null);
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              void dokumentSchliessen(d.id);
            }
          }}
          onClick={() => setzen({ aktiv: d.id })}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabMenue({ x: e.clientX, y: e.clientY, id: d.id });
          }}
        >
          {d.verschluesselt && <Lock size={12} />}
          <span className="tab-titel">{d.titel}</span>
          {d.geaendert && <span className="geaendert-punkt" title="Ungespeicherte Änderungen" />}
          <button
            className="tab-schliessen"
            aria-label={`${d.titel} schließen`}
            onClick={(e) => {
              e.stopPropagation();
              void dokumentSchliessen(d.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button className="tab-neu" title="Datei öffnen (Strg+O)" aria-label="Datei öffnen" onClick={() => void oeffnenDialog()}>
        <Plus size={16} />
      </button>
      {tabMenue && (
        <Kontextmenue
          x={tabMenue.x}
          y={tabMenue.y}
          schliessen={() => setTabMenue(null)}
          punkte={[
            {
              titel: "Rechts daneben anzeigen",
              icon: Columns2,
              deaktiviert: dokumente.length < 2,
              aktion: () => nebeneinanderOeffnen(tabMenue.id),
            },
            { titel: "Schließen", icon: X, kuerzel: "Strg+W", aktion: () => void dokumentSchliessen(tabMenue.id) },
          ]}
        />
      )}
    </div>
  );
}

// --------------------------------------------------- Eigenschaftsleiste
/** Erscheint nur bei aktivem Werkzeug (kontextabhängig, nicht dauerhaft). */
export function Eigenschaftsleiste() {
  const werkzeug = useZustand((z) => z.werkzeug);
  const fixiert = useZustand((z) => z.werkzeugFixiert);
  const lupeFaktor = useZustand((z) => z.lupeFaktor);
  if (werkzeug === "hand") return null;
  return (
    <div className="eigenschaftsleiste" role="toolbar" aria-label="Werkzeugeinstellungen">
      {werkzeug === "lassozoom" && (
        <span>
          <strong>Bereich zoomen:</strong> Rechteck aufziehen · Klick = 2× vergrößern · Umschalt+Klick = verkleinern
        </span>
      )}
      {werkzeug === "lupe" && (
        <>
          <strong>Lupe:</strong>
          <label>
            Vergrößerung
            <select value={lupeFaktor} onChange={(e) => setzen({ lupeFaktor: Number(e.target.value) })}>
              {[2, 3, 4, 6].map((f) => (
                <option key={f} value={f}>
                  {f}×
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <span className="abstand" />
      {werkzeug === "lassozoom" && (
        <button className={fixiert ? "umschalter an" : "umschalter"} onClick={() => setzen({ werkzeugFixiert: !fixiert })} aria-pressed={fixiert}>
          <Pin size={14} /> Werkzeug fixieren
        </button>
      )}
      <button className="umschalter" onClick={() => setzen({ werkzeug: "hand" })}>
        Beenden (Esc)
      </button>
    </div>
  );
}

// ------------------------------------------------------------ Statusleiste
const MODI: { id: AnsichtsModus; titel: string; icon: typeof FileText }[] = [
  { id: "einzelseite", titel: "Einzelseite", icon: RectangleVertical },
  { id: "fortlaufend", titel: "Fortlaufend", icon: ChevronsDown },
  { id: "doppelseite", titel: "Doppelseite", icon: BookOpen },
  { id: "doppelseite_fortlaufend", titel: "Doppelseite fortlaufend", icon: Columns2 },
];

// Logarithmischer Zoomregler: gleichmäßiges Gefühl von 10 % bis 800 %
const zuRegler = (z: number) => Math.round((Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 1000);
const ausRegler = (v: number) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 1000);

export function Statusleiste() {
  const dok = useZustand((z) => aktivesDokument(z));
  const [seitenEingabe, setSeitenEingabe] = useState("");
  const [zoomEingabe, setZoomEingabe] = useState("");
  const seite = dok ? dok.ansicht.seite + 1 : 0;
  const zoomProzent = dok ? Math.round(dok.ansicht.zoom * 100) : 100;
  useEffect(() => setSeitenEingabe(String(seite)), [seite]);
  useEffect(() => setZoomEingabe(`${zoomProzent} %`), [zoomProzent]);

  if (!dok) return <footer className="statusleiste" />;

  return (
    <footer className="statusleiste">
      <form
        className="seitenwahl"
        onSubmit={(e) => {
          e.preventDefault();
          const n = parseInt(seitenEingabe, 10);
          if (n >= 1 && n <= dok.seitenanzahl) springen(dok.id, n - 1);
          else setSeitenEingabe(String(seite));
        }}
      >
        Seite
        <input
          aria-label="Seitenzahl"
          value={seitenEingabe}
          onChange={(e) => setSeitenEingabe(e.target.value)}
          onFocus={(e) => e.target.select()}
          size={4}
        />
        von {dok.seitenanzahl}
      </form>
      <span className="abstand" />
      <div className="modi" role="radiogroup" aria-label="Seitenanzeige">
        {MODI.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={dok.ansicht.modus === m.id}
            className={dok.ansicht.modus === m.id ? "gewaehlt" : ""}
            title={m.titel}
            onClick={() => modusSetzen(m.id)}
          >
            <m.icon size={15} />
          </button>
        ))}
      </div>
      <div className="zoom">
        <button aria-label="Verkleinern" title="Verkleinern (Strg+-)" onClick={() => zoomSchritt(-1)}>
          <Minus size={14} />
        </button>
        <input
          type="range"
          aria-label="Zoom"
          min={0}
          max={1000}
          value={zuRegler(dok.ansicht.zoom)}
          onChange={(e) => zoomSetzen(ausRegler(Number(e.target.value)))}
        />
        <button aria-label="Vergrößern" title="Vergrößern (Strg++)" onClick={() => zoomSchritt(1)}>
          <Plus size={14} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseFloat(zoomEingabe.replace(",", "."));
            if (n > 0) zoomSetzen(n / 100);
            (document.activeElement as HTMLElement)?.blur();
          }}
        >
          <input
            className="zoom-wert"
            aria-label="Zoom in Prozent"
            value={zoomEingabe}
            onChange={(e) => setZoomEingabe(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setZoomEingabe(`${zoomProzent} %`)}
            size={6}
          />
        </form>
      </div>
    </footer>
  );
}

// ------------------------------------------------------------- Meldungen
export function Meldungen() {
  const meldung = useZustand((z) => z.meldung);
  const [sichtbar, setSichtbar] = useState(false);
  useEffect(() => {
    if (!meldung) return;
    setSichtbar(true);
    const t = window.setTimeout(() => setSichtbar(false), meldung.art === "fehler" ? 7000 : 3500);
    return () => window.clearTimeout(t);
  }, [meldung]);
  if (!meldung || !sichtbar) return null;
  return (
    <div className={`meldung ${meldung.art}`} role={meldung.art === "fehler" ? "alert" : "status"}>
      {meldung.text}
      <button aria-label="Meldung schließen" onClick={() => setSichtbar(false)}>
        <X size={14} />
      </button>
    </div>
  );
}

// --------------------------------------------------------- Passwortdialog
export function Passwortdialog() {
  const anfrage = useZustand((z) => z.passwortAnfrage);
  const [pw, setPw] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setPw("");
    ref.current?.focus();
  }, [anfrage]);
  if (!anfrage) return null;
  return (
    <div className="dialog-hintergrund" onMouseDown={() => setzen({ passwortAnfrage: null })}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          anfrage.wiederholen(pw);
        }}
      >
        <h2>
          <Lock size={18} /> Passwort erforderlich
        </h2>
        <p>„{anfrage.titel}“ ist geschützt. Bitte Passwort eingeben:</p>
        <input ref={ref} type="password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Passwort" />
        <div className="dialog-knoepfe">
          <button type="button" onClick={() => setzen({ passwortAnfrage: null })}>
            Abbrechen
          </button>
          <button type="submit" className="primaer">
            Öffnen
          </button>
        </div>
      </form>
    </div>
  );
}
