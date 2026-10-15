// Stapelverarbeitung: viele Dateien oder ganze Ordner auf einmal
// (Texterkennung, Leerseiten, Metadaten, Verkleinern) – als Hintergrundauftrag.

import { FilePlus2, FolderPlus, Layers3, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { StapelOptionen } from "../typen";
import { holen, melden, setzen, useZustand } from "../zustand/store";

const schliessen = () => setzen({ dialog: null });

const STANDARD: StapelOptionen = {
  texterkennung: true,
  sprachen: "deu+eng",
  leerseiten_entfernen: false,
  metadaten_entfernen: false,
  komprimieren: "",
  ausgabe: "daneben",
  zielordner: "",
  namensmuster: "{name}_bearbeitet",
};

const groesse = (b: number) =>
  b > 1048576 ? `${(b / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export function StapelDialog({ pfade: start }: { pfade: string[] }) {
  const desktop = useZustand((z) => z.desktop);
  const [pfade, setPfade] = useState<string[]>(start);
  const [eingabe, setEingabe] = useState("");
  const [unterordner, setUnterordner] = useState(false);
  const [vorschau, setVorschau] = useState<{ anzahl: number; dateien: { pfad: string; name: string; ordner: string; groesse: number }[] } | null>(null);
  const [o, setO] = useState<StapelOptionen>({ ...STANDARD, sprachen: holen().einstellungen?.ocr_sprachen ?? "deu+eng" });
  const [laeuft, setLaeuft] = useState(false);
  const aendern = (teil: Partial<StapelOptionen>) => setO((alt) => ({ ...alt, ...teil }));

  useEffect(() => {
    if (!pfade.length) {
      setVorschau(null);
      return;
    }
    const t = window.setTimeout(() => {
      api.stapelVorschau(pfade, unterordner).then(setVorschau).catch((e: Error) => melden(e.message, "fehler"));
    }, 150);
    return () => window.clearTimeout(t);
  }, [pfade, unterordner]);

  const hinzu = (neu: string[]) => setPfade((alt) => [...alt, ...neu.filter((p) => p && !alt.includes(p))]);
  const starten = async () => {
    setLaeuft(true);
    try {
      const a = await api.stapelStarten(pfade, unterordner, o);
      setzen((z) => ({ auftraege: [...z.auftraege, a], dialog: null }));
      melden(`${a.titel} läuft im Hintergrund – Fortschritt unten rechts.`);
    } catch (e) {
      melden((e as Error).message, "fehler");
    }
    setLaeuft(false);
  };

  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <form
        className="dialog sehr-breit stapel-dialog"
        role="dialog"
        aria-label="Stapelverarbeitung"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void starten();
        }}
        onKeyDown={(e) => e.key === "Escape" && schliessen()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const neu = [...e.dataTransfer.files].map((f) => (f as File & { pywebviewFullPath?: string }).pywebviewFullPath ?? "").filter(Boolean);
          if (neu.length) hinzu(neu);
          else melden("Dateien bitte über „Dateien …“ oder „Ordner …“ hinzufügen.", "fehler");
        }}
      >
        <h2>
          <Layers3 size={18} /> Stapelverarbeitung
        </h2>
        <section className="stapel-quellen">
          <div className="auswahl-zeile">
            {desktop && (
              <>
                <button
                  type="button"
                  className="umschalter"
                  onClick={async () => {
                    const r = await api.dialogOeffnen().catch(() => null);
                    if (r?.pfade.length) hinzu(r.pfade);
                  }}
                >
                  <FilePlus2 size={14} /> Dateien …
                </button>
                <button
                  type="button"
                  className="umschalter"
                  onClick={async () => {
                    const r = await api.ordnerDialog().catch(() => null);
                    if (r?.pfad) hinzu([r.pfad]);
                  }}
                >
                  <FolderPlus size={14} /> Ordner …
                </button>
              </>
            )}
            <input
              className="stapel-pfad"
              value={eingabe}
              onChange={(e) => setEingabe(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  hinzu([eingabe.trim()]);
                  setEingabe("");
                }
              }}
              placeholder="Ordner oder Datei (Pfad) eintragen und Eingabe drücken"
              aria-label="Pfad hinzufügen"
            />
            <label className="schalter-zeile">
              <input type="checkbox" checked={unterordner} onChange={(e) => setUnterordner(e.target.checked)} /> mit Unterordnern
            </label>
          </div>
          <ul className="stapel-liste" aria-label="Ausgewählte Dateien">
            {!pfade.length && <li className="leise">Noch nichts ausgewählt – Dateien oder Ordner hinzufügen (auch per Ziehen aus dem Explorer).</li>}
            {pfade.map((p) => (
              <li key={p}>
                <span title={p}>{p}</span>
                <button type="button" aria-label={`${p} entfernen`} onClick={() => setPfade((alt) => alt.filter((x) => x !== p))}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
          {vorschau && (
            <p className="leise klein" aria-live="polite">
              {vorschau.anzahl} Datei(en) werden bearbeitet
              {vorschau.dateien.length ? ` (${groesse(vorschau.dateien.reduce((n, d) => n + d.groesse, 0))})` : ""}: {" "}
              {vorschau.dateien.slice(0, 6).map((d) => d.name).join(", ")}
              {vorschau.anzahl > 6 ? " …" : ""}
            </p>
          )}
        </section>
        <div className="stapel-spalten">
          <fieldset className="gruppe">
            <legend>Bearbeiten</legend>
            <label className="schalter-zeile">
              <input type="checkbox" checked={o.texterkennung} onChange={(e) => aendern({ texterkennung: e.target.checked })} /> Texterkennung (durchsuchbar machen)
            </label>
            <label className="schalter-zeile">
              <input type="checkbox" checked={o.leerseiten_entfernen} onChange={(e) => aendern({ leerseiten_entfernen: e.target.checked })} /> Leerseiten entfernen
            </label>
            <label className="schalter-zeile">
              <input type="checkbox" checked={o.metadaten_entfernen} onChange={(e) => aendern({ metadaten_entfernen: e.target.checked })} /> Metadaten entfernen (Autor, Programm …)
            </label>
            <label className="schalter-zeile">
              Verkleinern
              <select value={o.komprimieren} onChange={(e) => aendern({ komprimieren: e.target.value as StapelOptionen["komprimieren"] })} aria-label="Verkleinern">
                <option value="">nicht verkleinern</option>
                <option value="gering">gering (beste Qualität)</option>
                <option value="mittel">mittel (E-Mail)</option>
                <option value="stark">stark</option>
                <option value="maximal">maximal</option>
              </select>
            </label>
            <p className="leise klein">Bilder, Word, Excel und E-Mails werden dabei in PDF umgewandelt.</p>
          </fieldset>
          <fieldset className="gruppe">
            <legend>Speichern</legend>
            <label className="schalter-zeile">
              <input type="radio" name="stapel-ausgabe" checked={o.ausgabe === "daneben"} onChange={() => aendern({ ausgabe: "daneben" })} /> Neben dem Original
            </label>
            <label className="schalter-zeile">
              <input type="radio" name="stapel-ausgabe" checked={o.ausgabe === "ordner"} onChange={() => aendern({ ausgabe: "ordner" })} /> In diesen Ordner:
            </label>
            {o.ausgabe === "ordner" && (
              <span className="feld-mit-knopf">
                <input value={o.zielordner} onChange={(e) => aendern({ zielordner: e.target.value })} aria-label="Zielordner" placeholder="z. B. \\NAS\Agentur\Eingang\bearbeitet" />
                {desktop && (
                  <button
                    type="button"
                    className="umschalter"
                    onClick={async () => {
                      const r = await api.ordnerDialog(o.zielordner).catch(() => null);
                      if (r?.pfad) aendern({ zielordner: r.pfad });
                    }}
                  >
                    Wählen …
                  </button>
                )}
              </span>
            )}
            <label className="schalter-zeile">
              <input type="radio" name="stapel-ausgabe" checked={o.ausgabe === "ersetzen"} onChange={() => aendern({ ausgabe: "ersetzen" })} /> Original ersetzen (Sicherung in „_Original“)
            </label>
            {o.ausgabe !== "ersetzen" && (
              <label className="feld">
                Dateiname – {"{name}"} = Originalname, {"{datum}"}, {"{zeit}"}, {"{nr}"}
                <input value={o.namensmuster} onChange={(e) => aendern({ namensmuster: e.target.value })} aria-label="Namensmuster" />
              </label>
            )}
          </fieldset>
        </div>
        <div className="dialog-knoepfe">
          <button type="button" onClick={schliessen}>
            Abbrechen
          </button>
          <button type="submit" className="primaer" disabled={laeuft || !vorschau?.anzahl}>
            {vorschau?.anzahl ? `${vorschau.anzahl} Datei(en) bearbeiten` : "Bearbeiten"}
          </button>
        </div>
      </form>
    </div>
  );
}
