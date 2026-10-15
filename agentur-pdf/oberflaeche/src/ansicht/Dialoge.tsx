// Dialoge: Teilen, Leerseiten entfernen, ungespeicherte Änderungen.

import { AlertTriangle, History, Scissors, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { speichern } from "../zustand/seitenaktionen";
import { seitenEntfernen, teilen } from "../zustand/seitenaktionen";
import { dokumentHinzufuegen, holen, melden, setzen, useZustand, type FrageKnopf } from "../zustand/store";
import { api } from "../api";
import type { Wiederherstellung } from "../typen";
import { dokumentSchliessen } from "../zustand/aktionen";
import { ZusammenfuehrenDialog } from "./Zusammenfuehren";
import { StapelDialog } from "./StapelDialog";
import { InfoDialog } from "./InfoDialog";
import { BereichstextDialog, OcrDialog, UeberwachungDialog } from "./OcrDialoge";
import {
  BildDialog,
  BilderExportDialog,
  DruckDialog,
  EigenschaftenDialog,
  FotoDialog,
  KennwortDialog,
  KomprimierenDialog,
  SchwaerzenDialog,
  StempelDialog,
  WasserzeichenDialog,
  KopfFussDialog,
} from "./WerkzeugDialoge";

export function Dialoge() {
  const dialog = useZustand((z) => z.dialog);
  if (!dialog) return null;
  if (dialog.art === "teilen") return <TeilenDialog dokId={dialog.dokId} />;
  if (dialog.art === "leerseiten") return <LeerseitenLeiste dokId={dialog.dokId} gefunden={dialog.seiten.length} />;
  if (dialog.art === "zusammenfuehren") return <ZusammenfuehrenDialog eintraege={dialog.eintraege} />;
  if (dialog.art === "ocr") return <OcrDialog dokId={dialog.dokId} />;
  if (dialog.art === "ueberwachung") return <UeberwachungDialog />;
  if (dialog.art === "info") return <InfoDialog />;
  if (dialog.art === "bereichstext") return <BereichstextDialog text={dialog.text} sicherheit={dialog.sicherheit} />;
  if (dialog.art === "druck") return <DruckDialog dokId={dialog.dokId} alsExport={dialog.export} />;
  if (dialog.art === "kennwort") return <KennwortDialog dokId={dialog.dokId} />;
  if (dialog.art === "schwaerzen") return <SchwaerzenDialog dokId={dialog.dokId} />;
  if (dialog.art === "komprimieren") return <KomprimierenDialog dokId={dialog.dokId} />;
  if (dialog.art === "eigenschaften") return <EigenschaftenDialog dokId={dialog.dokId} />;
  if (dialog.art === "bild") return <BildDialog dokId={dialog.dokId} unterschrift={dialog.unterschrift} />;
  if (dialog.art === "foto") return <FotoDialog dokId={dialog.dokId} seite={dialog.seite} bild={dialog.bild} />;
  if (dialog.art === "stempel") return <StempelDialog />;
  if (dialog.art === "bilderexport") return <BilderExportDialog dokId={dialog.dokId} />;
  if (dialog.art === "wasserzeichen") return <WasserzeichenDialog dokId={dialog.dokId} />;
  if (dialog.art === "kopffuss") return <KopfFussDialog dokId={dialog.dokId} />;
  if (dialog.art === "frage") return <FrageDialog titel={dialog.titel} text={dialog.text} knoepfe={dialog.knoepfe} antwort={dialog.antwort} />;
  if (dialog.art === "wiederherstellung") return <WiederherstellungDialog eintraege={dialog.eintraege} />;
  if (dialog.art === "stapel") return <StapelDialog pfade={dialog.pfade} />;
  return <UngespeichertDialog dokId={dialog.dokId} weiter={dialog.weiter} />;
}

const schliessen = () => setzen({ dialog: null });

function TeilenDialog({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const [modus, setModus] = useState("seitenanzahl");
  const [seiten, setSeiten] = useState("1");
  const [mb, setMb] = useState("5");
  const [laeuft, setLaeuft] = useState(false);
  if (!dok) return null;
  const n = parseInt(seiten, 10);
  const teileVorschau = modus === "seitenanzahl" && n > 0 ? Math.ceil(dok.seitenanzahl / n) : null;

  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <form
        className="dialog breit"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setLaeuft(true);
          const wert = modus === "seitenanzahl" ? n : modus === "dateigroesse" ? parseFloat(mb.replace(",", ".")) : 0;
          const ok = await teilen(dokId, modus, wert);
          setLaeuft(false);
          if (ok) schliessen();
        }}
      >
        <h2>
          <Scissors size={18} /> Dokument teilen
        </h2>
        <p>
          „{dok.titel}“ ({dok.seitenanzahl} Seiten)
          {dok.pfad ? " – die Teile werden neben der Originaldatei gespeichert." : " – die Teile werden als neue Dokumente geöffnet."}
        </p>
        <label className="auswahl-zeile">
          <input type="radio" name="modus" checked={modus === "seitenanzahl"} onChange={() => setModus("seitenanzahl")} />
          Alle
          <input className="zahl" value={seiten} onChange={(e) => setSeiten(e.target.value)} onFocus={() => setModus("seitenanzahl")} aria-label="Seiten pro Teil" />
          Seiten {teileVorschau ? <span className="leise">→ {teileVorschau} Teile</span> : null}
        </label>
        <label className="auswahl-zeile">
          <input type="radio" name="modus" checked={modus === "leerseiten"} onChange={() => setModus("leerseiten")} />
          An Leerseiten (Trennblätter werden entfernt)
        </label>
        <label className="auswahl-zeile">
          <input type="radio" name="modus" checked={modus === "lesezeichen"} onChange={() => setModus("lesezeichen")} />
          An Lesezeichen der obersten Ebene
        </label>
        <label className="auswahl-zeile">
          <input type="radio" name="modus" checked={modus === "dateigroesse"} onChange={() => setModus("dateigroesse")} />
          Teile höchstens
          <input className="zahl" value={mb} onChange={(e) => setMb(e.target.value)} onFocus={() => setModus("dateigroesse")} aria-label="Größe in MB" />
          MB (z. B. für E-Mail)
        </label>
        <div className="dialog-knoepfe">
          <button type="button" onClick={schliessen}>
            Abbrechen
          </button>
          <button type="submit" className="primaer" disabled={laeuft}>
            {laeuft ? "Teile …" : "Teilen"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Nicht-modal: Die gefundenen Leerseiten sind in den Miniaturen markiert und
 * können vor dem Entfernen noch angepasst werden. */
function LeerseitenLeiste({ dokId, gefunden }: { dokId: string; gefunden: number }) {
  const auswahl = useZustand((z) => z.dokumente.find((d) => d.id === dokId)?.auswahl ?? []);
  return (
    <div className="hinweisleiste" role="dialog" aria-label="Leerseiten entfernen">
      <Trash2 size={16} />
      <span>
        {gefunden === 1 ? "1 Leerseite" : `${gefunden} Leerseiten`} gefunden und markiert
        {auswahl.length !== gefunden ? ` (jetzt ${auswahl.length} markiert)` : ""}. Markierung in den Miniaturen bei Bedarf anpassen.
      </span>
      <span className="abstand" />
      <button
        className="primaer"
        disabled={!auswahl.length}
        onClick={() => {
          schliessen();
          void seitenEntfernen(dokId, auswahl);
        }}
      >
        {auswahl.length === 1 ? "1 Seite entfernen" : `${auswahl.length} Seiten entfernen`}
      </button>
      <button className="umschalter" onClick={schliessen}>
        Abbrechen
      </button>
    </div>
  );
}

function UngespeichertDialog({ dokId, weiter }: { dokId: string; weiter: () => void }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const speichernRef = useRef<HTMLButtonElement>(null);
  useEffect(() => speichernRef.current?.focus(), []);
  if (!dok) return null;
  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <div className="dialog" role="alertdialog" aria-label="Ungespeicherte Änderungen" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <AlertTriangle size={18} /> Änderungen speichern?
        </h2>
        <p>„{dok.titel}“ wurde geändert. Sollen die Änderungen gespeichert werden?</p>
        <div className="dialog-knoepfe">
          <button onClick={schliessen}>Abbrechen</button>
          <button
            onClick={() => {
              schliessen();
              weiter();
            }}
          >
            Nicht speichern
          </button>
          <button
            ref={speichernRef}
            className="primaer"
            onClick={async () => {
              schliessen();
              const d = holen().dokumente.find((x) => x.id === dokId);
              if (d && (await speichern(d))) weiter();
            }}
          >
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}

function FrageDialog(p: { titel: string; text: string; knoepfe: FrageKnopf[]; antwort: (wert: string | null) => void }) {
  const primaer = useRef<HTMLButtonElement>(null);
  useEffect(() => primaer.current?.focus(), []);
  return (
    <div className="dialog-hintergrund" onMouseDown={() => p.antwort(null)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-label={p.titel}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && p.antwort(null)}
      >
        <h2>
          <AlertTriangle size={18} /> {p.titel}
        </h2>
        <p>{p.text}</p>
        <div className="dialog-knoepfe">
          {p.knoepfe.map((k) => (
            <button
              key={k.wert}
              ref={k.primaer ? primaer : undefined}
              className={k.primaer ? "primaer" : k.gefahr ? "gefahr" : ""}
              onClick={() => p.antwort(k.wert)}
            >
              {k.titel}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function zeitpunkt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

/** Beim Start: ungespeicherte Änderungen aus einem abgestürzten Programmlauf */
function WiederherstellungDialog({ eintraege }: { eintraege: Wiederherstellung[] }) {
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(() => new Set(eintraege.map((e) => e.schluessel)));
  const [laeuft, setLaeuft] = useState(false);
  const umschalten = (s: string) =>
    setGewaehlt((alt) => {
      const neu = new Set(alt);
      if (neu.has(s)) neu.delete(s);
      else neu.add(s);
      return neu;
    });
  const wiederherstellen = async () => {
    setLaeuft(true);
    let anzahl = 0;
    for (const e of eintraege) {
      if (!gewaehlt.has(e.schluessel)) {
        await api.wiederherstellungVerwerfen(e.schluessel).catch(() => undefined);
        continue;
      }
      try {
        const info = await api.wiederherstellen(e.schluessel);
        // gleiche Datei unverändert aus der Sitzung geöffnet → durch die Sicherung ersetzen
        const alt = holen().dokumente.find((d) => d.id !== info.id && d.pfad && info.pfad && d.pfad.toLowerCase() === info.pfad.toLowerCase());
        if (alt && !alt.geaendert) await dokumentSchliessen(alt.id, true);
        dokumentHinzufuegen(info);
        anzahl++;
      } catch (err) {
        melden(`${e.titel}: ${(err as Error).message}`, "fehler");
      }
    }
    setzen({ dialog: null });
    if (anzahl) melden(`${anzahl} Dokument${anzahl === 1 ? "" : "e"} wiederhergestellt – bitte speichern.`);
  };
  return (
    <div className="dialog-hintergrund">
      <div className="dialog breit" role="dialog" aria-label="Dokumente wiederherstellen">
        <h2>
          <History size={18} /> Ungespeicherte Änderungen wiederherstellen?
        </h2>
        <p>Agentur-PDF wurde zuletzt nicht normal beendet. Diese Dokumente hatten ungespeicherte Änderungen:</p>
        <ul className="wiederherstellung-liste">
          {eintraege.map((e) => (
            <li key={e.schluessel}>
              <label>
                <input type="checkbox" checked={gewaehlt.has(e.schluessel)} onChange={() => umschalten(e.schluessel)} />
                <span className="wh-name">
                  <strong>{e.titel}</strong>
                  <small className="leise">{e.pfad ?? "noch nie gespeichert"}</small>
                </span>
                <span className="leise klein">
                  {e.seiten} S. · Stand {zeitpunkt(e.zeit)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="dialog-knoepfe">
          <button disabled={laeuft} onClick={() => setzen({ dialog: null })} title="Beim nächsten Start erneut fragen">
            Später
          </button>
          <button
            disabled={laeuft}
            className="gefahr"
            onClick={async () => {
              setLaeuft(true);
              for (const e of eintraege) await api.wiederherstellungVerwerfen(e.schluessel).catch(() => undefined);
              setzen({ dialog: null });
            }}
          >
            Alle verwerfen
          </button>
          <button disabled={laeuft || !gewaehlt.size} className="primaer" onClick={() => void wiederherstellen()}>
            Wiederherstellen
          </button>
        </div>
      </div>
    </div>
  );
}
