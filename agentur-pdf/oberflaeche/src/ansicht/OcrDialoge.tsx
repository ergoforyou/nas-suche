// Texterkennung: Dialog, Hinweisleiste für Scans ohne Text, erkannter
// Bereichstext, Überwachungsordner.

import { Copy, FolderSync, Plus, ScanText, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { OcrStatus, OrdnerRegel, UeberwachungsProtokoll } from "../typen";
import { hinweisAusblenden, ocrDialog, ocrStarten } from "../zustand/ocr";
import { melden, setzen, useZustand } from "../zustand/store";

const schliessen = () => setzen({ dialog: null });

const SPRACHEN: Record<string, string> = { "deu+eng": "Deutsch + Englisch", deu: "Nur Deutsch", "deu+frk": "Deutsch + Fraktur", eng: "Englisch" };

export function OcrDialog({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const textlos = useZustand((z) => z.textlos[dokId]);
  const standardSprache = useZustand((z) => z.einstellungen?.ocr_sprachen ?? "deu+eng");
  const [status, setStatus] = useState<OcrStatus | null>(null);
  const [bereich, setBereich] = useState<"alle" | "markiert" | "aktuell">(dok?.auswahl.length ? "markiert" : "alle");
  const [sprachen, setSprachen] = useState(standardSprache);
  const [erzwingen, setErzwingen] = useState(false);
  const [ausrichten, setAusrichten] = useState(true);
  const [entzerren, setEntzerren] = useState(true);
  useEffect(() => {
    api.ocrStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!dok) return null;

  const verfuegbar = (s: string) => !status || s.split("+").every((t) => status.sprachen.includes(t));
  const seiten = bereich === "alle" ? null : bereich === "markiert" ? dok.auswahl : [dok.ansicht.seite];

  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <form
        className="dialog breit"
        role="dialog"
        aria-label="Texterkennung"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (await ocrStarten(dokId, { seiten, sprachen, erzwingen, ausrichten, entzerren })) schliessen();
        }}
      >
        <h2>
          <ScanText size={18} /> Texterkennung (OCR)
        </h2>
        <p>
          Macht gescannte Seiten durchsuchbar und kopierbar. Das Seitenbild bleibt <strong>unverändert</strong> – der Text liegt unsichtbar
          darüber auf der Ebene „OCR-Text“.
          {textlos !== undefined && ` ${textlos} von ${dok.seitenanzahl} Seite(n) enthalten noch keinen Text.`}
        </p>
        {status && !status.verfuegbar && <p className="warnung">Die Texterkennung ist auf diesem PC nicht installiert.</p>}

        <fieldset className="gruppe">
          <legend>Seiten</legend>
          <label className="auswahl-zeile">
            <input type="radio" name="bereich" checked={bereich === "alle"} onChange={() => setBereich("alle")} /> Alle Seiten
          </label>
          <label className="auswahl-zeile">
            <input type="radio" name="bereich" checked={bereich === "aktuell"} onChange={() => setBereich("aktuell")} /> Aktuelle Seite (
            {dok.ansicht.seite + 1})
          </label>
          <label className="auswahl-zeile">
            <input
              type="radio"
              name="bereich"
              disabled={!dok.auswahl.length}
              checked={bereich === "markiert"}
              onChange={() => setBereich("markiert")}
            />
            Markierte Seiten {dok.auswahl.length ? `(${dok.auswahl.length})` : "(keine markiert)"}
          </label>
        </fieldset>

        <label className="auswahl-zeile">
          Sprache
          <select value={sprachen} onChange={(e) => setSprachen(e.target.value)} aria-label="Sprache">
            {Object.entries(SPRACHEN).map(([wert, titel]) => (
              <option key={wert} value={wert} disabled={!verfuegbar(wert)}>
                {titel}
                {verfuegbar(wert) ? "" : " (nicht installiert)"}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={ausrichten} onChange={(e) => setAusrichten(e.target.checked)} />
          Quer oder kopfstehend gescannte Seiten automatisch richtig drehen
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={entzerren} onChange={(e) => setEntzerren(e.target.checked)} />
          Schief eingelegte Seiten ausgleichen (nur für die Erkennung)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={erzwingen} onChange={(e) => setErzwingen(e.target.checked)} />
          Vorhandene Textebene ersetzen (z. B. schwache Scanner-OCR neu erkennen)
        </label>
        {status && !status.beste_modelle && <p className="leise">Hinweis: Es werden die Standard-Erkennungsmodelle verwendet.</p>}

        <div className="dialog-knoepfe">
          <button type="button" onClick={schliessen}>
            Abbrechen
          </button>
          <button type="submit" className="primaer" disabled={status?.verfuegbar === false}>
            Texterkennung starten
          </button>
        </div>
      </form>
    </div>
  );
}

/** Nicht-modal über dem Dokument: Scan ohne durchsuchbaren Text erkannt. */
export function OcrHinweis() {
  const aktiv = useZustand((z) => z.aktiv);
  const textlos = useZustand((z) => (z.aktiv ? z.textlos[z.aktiv] : undefined));
  const weg = useZustand((z) => (z.aktiv ? z.hinweisWeg[z.aktiv] : true));
  const laeuft = useZustand((z) => z.auftraege.some((a) => a.status === "laeuft" && a.titel.startsWith("Texterkennung")));
  const dialog = useZustand((z) => z.dialog);
  if (!aktiv || !textlos || weg || laeuft || dialog) return null;
  return (
    <div className="hinweisleiste" role="status" data-testid="ocr-hinweis">
      <ScanText size={16} />
      <span>
        {textlos === 1 ? "Eine Seite enthält" : `${textlos} Seiten enthalten`} keinen durchsuchbaren Text (Scan oder Bild).
      </span>
      <span className="abstand" />
      <button className="primaer" onClick={() => ocrDialog(aktiv)}>
        Texterkennung starten
      </button>
      <button className="symbol" aria-label="Hinweis schließen" onClick={() => hinweisAusblenden(aktiv)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function BereichstextDialog({ text, sicherheit }: { text: string; sicherheit: number }) {
  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <div className="dialog breit" role="dialog" aria-label="Erkannter Text" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <ScanText size={18} /> Erkannter Text
        </h2>
        <textarea className="textausgabe" defaultValue={text} rows={Math.min(14, text.split("\n").length + 1)} aria-label="Erkannter Text" />
        <p className="leise">Sicherheit der Erkennung: {Math.round(sicherheit)} %. Text kann hier noch korrigiert werden.</p>
        <div className="dialog-knoepfe">
          <button onClick={schliessen}>Schließen</button>
          <button
            className="primaer"
            onClick={async (e) => {
              const feld = (e.currentTarget.closest(".dialog") as HTMLElement).querySelector("textarea")!;
              try {
                await navigator.clipboard.writeText(feld.value);
                melden("Text in die Zwischenablage kopiert.");
              } catch {
                feld.select();
                document.execCommand("copy");
              }
              schliessen();
            }}
          >
            <Copy size={14} /> Kopieren
          </button>
        </div>
      </div>
    </div>
  );
}

const LEERE_REGEL: OrdnerRegel = { ordner: "", ziel: "", original_sichern: true, leerseiten_entfernen: true, aktiv: true };

export function UeberwachungDialog() {
  const [regeln, setRegeln] = useState<OrdnerRegel[] | null>(null);
  const [protokoll, setProtokoll] = useState<UeberwachungsProtokoll[]>([]);
  const [fehler, setFehler] = useState("");
  useEffect(() => {
    api
      .ueberwachung()
      .then((r) => {
        setRegeln(r.regeln.length ? r.regeln : [{ ...LEERE_REGEL }]);
        setProtokoll(r.protokoll);
      })
      .catch((e) => setFehler(String(e.message ?? e)));
  }, []);
  if (!regeln) return null;
  const aendern = (i: number, teil: Partial<OrdnerRegel>) => setRegeln(regeln.map((r, k) => (k === i ? { ...r, ...teil } : r)));

  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <form
        className="dialog sehr-breit"
        role="dialog"
        aria-label="Überwachungsordner"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.ueberwachungSetzen(regeln.filter((r) => r.ordner.trim()));
            melden("Überwachungsordner gespeichert.");
            schliessen();
          } catch (err) {
            setFehler((err as Error).message);
          }
        }}
      >
        <h2>
          <FolderSync size={18} /> Überwachungsordner
        </h2>
        <p>
          Neue PDFs in diesen Ordnern (z. B. ScanSnap-Ausgang) werden automatisch durchsuchbar gemacht. Seiten, die schon Text haben, bleiben
          unverändert. Ergo4You PDF muss dafür laufen.
        </p>
        {regeln.map((r, i) => (
          <fieldset className="gruppe regel" key={i}>
            <legend>
              <label className="checkbox">
                <input type="checkbox" checked={r.aktiv} onChange={(e) => aendern(i, { aktiv: e.target.checked })} /> Ordner {i + 1}
              </label>
            </legend>
            <label className="feld">
              Überwachter Ordner
              <input value={r.ordner} onChange={(e) => aendern(i, { ordner: e.target.value })} placeholder="z. B. Z:\Scans\Eingang" aria-label={`Überwachter Ordner ${i + 1}`} />
            </label>
            <label className="feld">
              Ergebnis speichern in (leer = Datei an Ort und Stelle ersetzen)
              <input value={r.ziel} onChange={(e) => aendern(i, { ziel: e.target.value })} placeholder="optional, z. B. Z:\Scans\Fertig" />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={r.original_sichern} onChange={(e) => aendern(i, { original_sichern: e.target.checked })} />
              Original im Unterordner „_Original“ aufheben
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={r.leerseiten_entfernen}
                onChange={(e) => aendern(i, { leerseiten_entfernen: e.target.checked })}
              />
              Leere Seiten entfernen (Duplex-Rückseiten)
            </label>
            <button type="button" className="umschalter gefahr-text" onClick={() => setRegeln(regeln.filter((_, k) => k !== i))}>
              <Trash2 size={14} /> Ordner entfernen
            </button>
          </fieldset>
        ))}
        <button type="button" className="umschalter" onClick={() => setRegeln([...regeln, { ...LEERE_REGEL }])}>
          <Plus size={14} /> Weiteren Ordner hinzufügen
        </button>
        {protokoll.length > 0 && (
          <details className="protokoll">
            <summary>Zuletzt verarbeitet ({protokoll.length})</summary>
            <ul>
              {protokoll.map((p, i) => (
                <li key={i} className={p.ok ? "" : "fehler"}>
                  {new Date(p.zeit * 1000).toLocaleString("de-DE")} – {p.datei}:{" "}
                  {p.ok ? `${p.erkannt} Seite(n) erkannt${p.leerseiten_entfernt ? `, ${p.leerseiten_entfernt} leer entfernt` : ""}` : p.fehler}
                </li>
              ))}
            </ul>
          </details>
        )}
        {fehler && <p className="warnung">{fehler}</p>}
        <div className="dialog-knoepfe">
          <button type="button" onClick={schliessen}>
            Abbrechen
          </button>
          <button type="submit" className="primaer">
            Speichern
          </button>
        </div>
      </form>
    </div>
  );
}
