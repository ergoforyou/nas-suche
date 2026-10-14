// „Über Agentur-PDF & Einrichtung“: Version, Bausteine, Protokoll, Explorer-Menü.

import { Camera, CheckCircle2, Info, MousePointerClick, Settings, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { holen, melden, setzen } from "../zustand/store";

type System = Awaited<ReturnType<typeof api.system>>;

function Zeile({ ok, titel, detail }: { ok: boolean; titel: string; detail?: string }) {
  return (
    <li className={ok ? "ok" : "fehlt"}>
      {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      <span>
        <strong>{titel}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </li>
  );
}

type ScreenshotStatus = Awaited<ReturnType<typeof api.screenshotStatus>>;

function EinstellungenBereich() {
  const e = holen().einstellungen;
  const [kuerzel, setKuerzel] = useState(e?.kuerzel ?? "");
  const [aktiv, setAktiv] = useState(e?.screenshot_aktiv ?? true);
  const [taste, setTaste] = useState(e?.screenshot_taste ?? "Strg+Umschalt+Druck");
  const [ordner, setOrdner] = useState(e?.screenshot_ordner ?? "");
  const [ocr, setOcr] = useState(e?.screenshot_ocr ?? true);
  const [bild, setBild] = useState(e?.screenshot_bild_kopieren ?? true);
  const [text, setText] = useState(e?.screenshot_text_kopieren ?? false);
  const [status, setStatus] = useState<ScreenshotStatus | null>(null);
  const statusLaden = () => api.screenshotStatus().then(setStatus).catch(() => undefined);
  useEffect(() => {
    void statusLaden();
  }, []);
  const speichern = async () => {
    try {
      const neu = await api.einstellungenSetzen({
        kuerzel: kuerzel.trim(),
        screenshot_aktiv: aktiv,
        screenshot_taste: taste.trim(),
        screenshot_ordner: ordner.trim(),
        screenshot_ocr: ocr,
        screenshot_bild_kopieren: bild,
        screenshot_text_kopieren: text,
      });
      setzen({ einstellungen: neu });
      await statusLaden();
      melden("Einstellungen gespeichert.");
    } catch (err) {
      melden((err as Error).message, "fehler");
    }
  };
  return (
    <>
      <fieldset className="gruppe">
        <legend>
          <Settings size={13} /> Allgemein
        </legend>
        <label className="feld">
          Ihr Kürzel (für Stempel, Kommentare und Screenshot-Namen)
          <input value={kuerzel} onChange={(ev) => setKuerzel(ev.target.value)} placeholder="z. B. JK" maxLength={20} />
        </label>
      </fieldset>
      <fieldset className="gruppe">
        <legend>
          <Camera size={13} /> Screenshot-Werkzeug
        </legend>
        <label className="auswahl-zeile">
          <input type="checkbox" checked={aktiv} onChange={(ev) => setAktiv(ev.target.checked)} /> Tastenkürzel überall aktiv
          <input className="zahl breit" value={taste} onChange={(ev) => setTaste(ev.target.value)} aria-label="Tastenkürzel" />
        </label>
        <label className="feld">
          Ablageordner (leer = Bilder\Screenshots\Agentur-PDF, gern auch ein NAS-Ordner)
          <input value={ordner} onChange={(ev) => setOrdner(ev.target.value)} placeholder={status?.ordner ?? ""} />
        </label>
        <label className="auswahl-zeile">
          <input type="checkbox" checked={ocr} onChange={(ev) => setOcr(ev.target.checked)} /> Texterkennung: zusätzlich durchsuchbare PDF ablegen
        </label>
        <label className="auswahl-zeile">
          <input type="checkbox" checked={bild} onChange={(ev) => setBild(ev.target.checked)} /> Bild in die Zwischenablage
        </label>
        <label className="auswahl-zeile">
          <input type="checkbox" checked={text} onChange={(ev) => setText(ev.target.checked)} /> Erkannten Text in die Zwischenablage
        </label>
        {status && (
          <p className={status.fehler ? "warnung" : "leise"}>
            {status.fehler
              ? status.fehler
              : status.verfuegbar
                ? status.aktiv
                  ? `Aktiv: ${status.taste} drücken, Bereich aufziehen.`
                  : "Tastenkürzel ist ausgeschaltet."
                : "Das Tastenkürzel gibt es nur im Windows-Programm."}
          </p>
        )}
      </fieldset>
      <div>
        <button className="umschalter" onClick={() => void speichern()}>
          Einstellungen speichern
        </button>
      </div>
    </>
  );
}

export function InfoDialog() {
  const [s, setS] = useState<System | null>(null);
  useEffect(() => {
    api.system().then(setS).catch(() => undefined);
  }, []);
  const schliessen = () => setzen({ dialog: null });
  const explorer = async (einrichten: boolean) => {
    try {
      await api.explorerMenue(einrichten);
      melden(einrichten ? "Rechtsklick-Einträge im Explorer eingerichtet." : "Rechtsklick-Einträge entfernt.");
    } catch (e) {
      melden((e as Error).message, "fehler");
    }
  };
  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <div className="dialog sehr-breit" role="dialog" aria-label="Über Agentur-PDF" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Info size={18} /> Agentur-PDF {s ? s.version : ""}
        </h2>
        {s && (
          <>
            <ul className="bausteine">
              <Zeile ok={!!s.tesseract} titel="Texterkennung (Tesseract)" detail={s.tesseract ? (s.beste_modelle ? "beste Modelle (tessdata_best)" : "Standard-Modelle") : "nicht gefunden"} />
              <Zeile ok={!!s.libreoffice} titel="Word/Excel → PDF (LibreOffice)" detail={s.libreoffice ?? "nicht gefunden – Word/Excel-Dateien können nicht umgewandelt werden"} />
              <Zeile ok={s.woerterbuch} titel="Deutsches Wörterbuch" detail={s.woerterbuch ? "für Texterkennung und Rechtschreibung" : "nicht gefunden"} />
            </ul>
            <p className="leise">
              Einstellungen und Fehlerprotokoll: <code>{s.datenordner}</code> (Datei <code>protokoll.log</code> – bei Problemen bitte mitschicken)
            </p>
            {s.windows && (
              <fieldset className="gruppe">
                <legend>Windows-Explorer</legend>
                <p className="leise">
                  Rechtsklick auf Dateien: „Mit Agentur-PDF öffnen“, „Zu einer PDF zusammenführen“, „In PDF umwandeln“. Wird nur für Ihr
                  Benutzerkonto eingerichtet (keine Administratorrechte nötig). Unter Windows 11 unter „Weitere Optionen anzeigen“.
                </p>
                <div className="zf-werkzeuge">
                  <button className="umschalter" onClick={() => void explorer(true)}>
                    <MousePointerClick size={14} /> Rechtsklick-Einträge einrichten
                  </button>
                  <button className="umschalter" onClick={() => void explorer(false)}>
                    Entfernen
                  </button>
                </div>
              </fieldset>
            )}
          </>
        )}
        <EinstellungenBereich />
        <div className="dialog-knoepfe">
          <button className="primaer" onClick={schliessen}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
