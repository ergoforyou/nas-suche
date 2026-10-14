// Zusammenführen-Dialog: Dateiliste, Reihenfolge per Drag & Drop oder
// Pfeiltasten, Sortieren, Optionen, Fortschritt.

import { ArrowDown, ArrowDownAZ, ArrowUp, File, FileImage, FileSpreadsheet, FileText, GripVertical, Layers, Loader2, Mail, Plus, X } from "lucide-react";
import { useState } from "react";
import type { ZfEintrag } from "../typen";
import { auftragAbbrechen, dateiauswahlFuerDialog, dateienZumDialog, endung, zusammenfuehrenStarten } from "../zustand/konvertieren";
import { setzen, useZustand } from "../zustand/store";

function symbol(name: string) {
  const e = endung(name);
  if (["png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "heic", "heif", "webp"].includes(e)) return FileImage;
  if (["xls", "xlsx", "ods", "csv"].includes(e)) return FileSpreadsheet;
  if (["eml", "msg"].includes(e)) return Mail;
  if (["pdf", "doc", "docx", "odt", "rtf", "txt"].includes(e)) return FileText;
  return File;
}

export function ZusammenfuehrenDialog({ eintraege }: { eintraege: ZfEintrag[] }) {
  const [lesezeichen, setLesezeichen] = useState(true);
  const [anhaenge, setAnhaenge] = useState(true);
  const [ziehe, setZiehe] = useState<number | null>(null);
  const [ueber, setUeber] = useState<number | null>(null);
  const [auftragId, setAuftragId] = useState<string | null>(null);
  const auftrag = useZustand((z) => z.auftraege.find((a) => a.id === auftragId) ?? null);
  const hatMails = eintraege.some((e) => ["eml", "msg"].includes(endung(e.name)));
  const laedt = eintraege.some((e) => e.laedt);

  const setzeListe = (liste: ZfEintrag[]) =>
    setzen((z) => (z.dialog?.art === "zusammenfuehren" ? { dialog: { ...z.dialog, eintraege: liste } } : {}));
  const verschieben = (von: number, nach: number) => {
    if (nach < 0 || nach >= eintraege.length || von === nach) return;
    const liste = [...eintraege];
    const [e] = liste.splice(von, 1);
    liste.splice(nach, 0, e);
    setzeListe(liste);
  };
  const schliessen = () => {
    if (auftrag && (auftrag.status === "laeuft" || auftrag.status === "wartet")) auftragAbbrechen(auftrag.id);
    setzen({ dialog: null });
  };

  // Fertig → Dialog schließen (das Dokument öffnet die Ereignisschleife)
  if (auftrag?.status === "fertig") setTimeout(() => setzen((z) => (z.dialog?.art === "zusammenfuehren" ? { dialog: null } : {})), 0);
  const laeuft = auftrag && (auftrag.status === "laeuft" || auftrag.status === "wartet");

  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <div
        className="dialog zf-dialog"
        role="dialog"
        aria-label="Zu einer PDF zusammenführen"
        onMouseDown={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          dateienZumDialog([...e.dataTransfer.files]);
        }}
      >
        <h2>
          <Layers size={18} /> Zu einer PDF zusammenführen
        </h2>
        <p>Reihenfolge per Ziehen oder mit den Pfeilen festlegen. Weitere Dateien einfach hierher ziehen – auch aus Outlook.</p>

        <ol className="zf-liste" aria-label="Dateien in Reihenfolge">
          {eintraege.map((e, i) => {
            const Symbol = symbol(e.name);
            return (
              <li
                key={e.schluessel}
                className={`${ziehe === i ? "zieht" : ""}${ueber === i && ziehe !== null && ziehe !== i ? (ziehe < i ? " ueber-unten" : " ueber-oben") : ""}`}
                draggable={!laeuft}
                onDragStart={(ev) => {
                  setZiehe(i);
                  ev.dataTransfer.effectAllowed = "move";
                  ev.dataTransfer.setData("text/plain", String(i));
                }}
                onDragOver={(ev) => {
                  if (ziehe === null) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  setUeber(i);
                }}
                onDrop={(ev) => {
                  if (ziehe === null) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  verschieben(ziehe, i);
                  setZiehe(null);
                  setUeber(null);
                }}
                onDragEnd={() => {
                  setZiehe(null);
                  setUeber(null);
                }}
                data-name={e.name}
              >
                <GripVertical size={14} className="griff" />
                <span className="zf-nr">{i + 1}</span>
                <Symbol size={16} />
                <span className="zf-name" title={e.pfad ?? e.name}>
                  {e.name}
                </span>
                {e.laedt && <Loader2 size={14} className="dreht" aria-label="wird geladen" />}
                <button className="symbol" aria-label={`${e.name} nach oben`} disabled={i === 0 || !!laeuft} onClick={() => verschieben(i, i - 1)}>
                  <ArrowUp size={14} />
                </button>
                <button
                  className="symbol"
                  aria-label={`${e.name} nach unten`}
                  disabled={i === eintraege.length - 1 || !!laeuft}
                  onClick={() => verschieben(i, i + 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button className="symbol" aria-label={`${e.name} entfernen`} disabled={!!laeuft} onClick={() => setzeListe(eintraege.filter((x) => x !== e))}>
                  <X size={14} />
                </button>
              </li>
            );
          })}
          {!eintraege.length && <li className="leer-hinweis zf-leer">Noch keine Dateien – „Dateien hinzufügen“ oder hierher ziehen.</li>}
        </ol>

        <div className="zf-werkzeuge">
          <button className="umschalter" onClick={() => void dateiauswahlFuerDialog()} disabled={!!laeuft}>
            <Plus size={14} /> Dateien hinzufügen …
          </button>
          <button
            className="umschalter"
            disabled={eintraege.length < 2 || !!laeuft}
            onClick={() => setzeListe([...eintraege].sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true })))}
          >
            <ArrowDownAZ size={14} /> Nach Name sortieren
          </button>
          <span className="abstand" />
          <span className="leise">{eintraege.length} Datei(en)</span>
        </div>

        <label className="checkbox">
          <input type="checkbox" checked={lesezeichen} onChange={(e) => setLesezeichen(e.target.checked)} />
          Lesezeichen je Datei anlegen
        </label>
        {hatMails && (
          <label className="checkbox">
            <input type="checkbox" checked={anhaenge} onChange={(e) => setAnhaenge(e.target.checked)} />
            E-Mail-Anhänge mit einfügen
          </label>
        )}

        {auftrag && (
          <div className={`zf-fortschritt ${auftrag.status}`} role="status">
            <div className="balken">
              <div style={{ width: `${Math.round(auftrag.fortschritt * 100)}%` }} />
            </div>
            <span>{auftrag.status === "fehler" ? auftrag.fehler : auftrag.schritt || "Starte …"}</span>
          </div>
        )}

        <div className="dialog-knoepfe">
          <button onClick={schliessen}>{laeuft ? "Abbrechen" : "Schließen"}</button>
          <button
            className="primaer"
            disabled={!eintraege.length || laedt || !!laeuft}
            onClick={async () => {
              const a = await zusammenfuehrenStarten(eintraege, lesezeichen, anhaenge);
              if (a) setAuftragId(a.id);
            }}
          >
            {laeuft ? "Wird zusammengeführt …" : eintraege.length === 1 ? "In PDF umwandeln" : "Zusammenführen"}
          </button>
        </div>
      </div>
    </div>
  );
}
