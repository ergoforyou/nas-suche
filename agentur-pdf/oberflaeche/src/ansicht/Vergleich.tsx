// Dokumente vergleichen: Auswahl (Dialog) und Liste der Unterschiede
// (Seitenleiste). Die Markierungen zeichnet die Dokumentansicht.

import { ChevronDown, ChevronUp, FolderOpen, GitCompareArrows, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ausfuehren } from "../befehle/register";
import type { VergleichAenderung } from "../typen";
import { vergleichBeenden, vergleichSpringen, vergleichStarten } from "../zustand/vergleich";
import { holen, setzen, useZustand } from "../zustand/store";

const ART: Record<VergleichAenderung["art"], string> = {
  geaendert: "Geändert",
  entfernt: "Entfernt",
  eingefuegt: "Neu",
  bild: "Bild",
};

export function VergleichDialog() {
  const dokumente = useZustand((z) => z.dokumente);
  const aktiv = useZustand((z) => z.aktiv);
  const [a, setA] = useState(aktiv ?? dokumente[0]?.id ?? "");
  const [b, setB] = useState(() => holen().verlauf.find((id) => id !== aktiv) ?? dokumente.find((d) => d.id !== aktiv)?.id ?? "");
  const [laeuft, setLaeuft] = useState(false);
  const zu = () => setzen({ dialog: null });
  // neu geöffnetes Dokument (über „Datei öffnen …“) gleich als „neue Fassung“ vorschlagen
  const anzahl = useRef(dokumente.length);
  useEffect(() => {
    if (dokumente.length > anzahl.current) setB(dokumente[dokumente.length - 1].id);
    anzahl.current = dokumente.length;
  }, [dokumente]);

  const auswahl = (wert: string, setzen_: (v: string) => void, label: string) => (
    <select value={wert} onChange={(e) => setzen_(e.target.value)} aria-label={label}>
      <option value="">– bitte wählen –</option>
      {dokumente.map((d) => (
        <option key={d.id} value={d.id}>
          {d.titel}
        </option>
      ))}
    </select>
  );
  return (
    <div className="dialog-hintergrund" onMouseDown={zu}>
      <form
        className="dialog breit"
        role="dialog"
        aria-label="Dokumente vergleichen"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && zu()}
        onSubmit={async (e) => {
          e.preventDefault();
          setLaeuft(true);
          await vergleichStarten(a, b);
          setLaeuft(false);
        }}
      >
        <h2>
          <GitCompareArrows size={18} /> Dokumente vergleichen
        </h2>
        <p className="leise">Zeigt, was sich zwischen zwei Fassungen geändert hat – Wort für Wort, Scans als Bild. Beide werden nebeneinander angezeigt.</p>
        <label className="feld">
          Alte Fassung
          {auswahl(a, setA, "Alte Fassung")}
        </label>
        <label className="feld">
          Neue Fassung
          {auswahl(b, setB, "Neue Fassung")}
        </label>
        <button type="button" className="umschalter" onClick={() => ausfuehren("datei.oeffnen")}>
          <FolderOpen size={14} /> Weitere Datei öffnen …
        </button>
        <div className="dialog-knoepfe">
          <button type="button" onClick={zu}>
            Abbrechen
          </button>
          <button type="submit" className="primaer" disabled={laeuft || !a || !b || a === b}>
            {laeuft ? "Vergleiche …" : "Vergleichen"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function VergleichPanel() {
  const v = useZustand((z) => z.vergleich);
  const dokumente = useZustand((z) => z.dokumente);
  const liste = useRef<HTMLUListElement>(null);
  useEffect(() => {
    liste.current?.querySelector(".aktiv")?.scrollIntoView({ block: "nearest" });
  }, [v?.aktiv]);
  if (!v) {
    return (
      <div className="panel-leer">
        <p className="leise">Kein Vergleich aktiv.</p>
        <button className="umschalter" onClick={() => setzen({ dialog: { art: "vergleich" } })}>
          <GitCompareArrows size={14} /> Dokumente vergleichen …
        </button>
      </div>
    );
  }
  const titel = (id: string) => dokumente.find((d) => d.id === id)?.titel ?? "?";
  const { aenderungen } = v.ergebnis;
  return (
    <div className="vergleich-panel">
      <div className="vergleich-kopf">
        <div className="klein">
          <span className="v-farbe v-alt" /> {titel(v.a)}
          <br />
          <span className="v-farbe v-neu" /> {titel(v.b)}
        </div>
        <div className="vergleich-navi">
          <strong>{aenderungen.length ? `${v.aktiv + 1} / ${aenderungen.length}` : "keine Unterschiede"}</strong>
          <button title="Voriger Unterschied" aria-label="Voriger Unterschied" disabled={!aenderungen.length} onClick={() => vergleichSpringen(v.aktiv - 1)}>
            <ChevronUp size={15} />
          </button>
          <button title="Nächster Unterschied" aria-label="Nächster Unterschied" disabled={!aenderungen.length} onClick={() => vergleichSpringen(v.aktiv + 1)}>
            <ChevronDown size={15} />
          </button>
          <button title="Vergleich beenden" aria-label="Vergleich beenden" onClick={vergleichBeenden}>
            <X size={15} />
          </button>
        </div>
        {v.ergebnis.gekuerzt && <p className="warnung klein">Sehr viele Unterschiede – nur die ersten werden gezeigt.</p>}
      </div>
      <ul className="trefferliste vergleich-liste" ref={liste} aria-label="Unterschiede">
        {aenderungen.map((x, i) => (
          <li key={i}>
            <button className={i === v.aktiv ? "aktiv" : ""} onClick={() => vergleichSpringen(i)}>
              <span className="treffer-ort">
                <span className={`v-art v-${x.art}`}>{ART[x.art]}</span> Seite {(x.seite_a ?? x.seite_b ?? 0) + 1}
                {x.seite_b !== null && x.seite_a !== null && x.seite_b !== x.seite_a ? ` → ${x.seite_b + 1}` : ""}
              </span>
              <span className="treffer-text">
                {x.alt && (x.art === "bild" ? <span>{x.alt}</span> : <del>{x.alt}</del>)}
                {x.alt && x.neu && " → "}
                {x.neu && <ins>{x.neu}</ins>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
