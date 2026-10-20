// „Über Ergo4You PDF & Einrichtung“: Version, Bausteine, Protokoll, Explorer-Menü.

import { PRODUKT, STAND } from "../marke";
import { Camera, CheckCircle2, Download, Info, MonitorCog, MousePointerClick, RefreshCw, Settings, Users, XCircle } from "lucide-react";
import { updateInstallieren, updatePruefen } from "../zustand/aktionen";
import { ChromeBereich, DruckerBereich } from "./DruckerBereich";
import { useEffect, useState } from "react";
import { api } from "../api";
import { holen, melden, setzen, useZustand } from "../zustand/store";
import type { GemeinsamStatus, UpdateInfo, WindowsStatus } from "../typen";

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
  const [gemeinsam, setGemeinsam] = useState(e?.gemeinsamer_ordner ?? "");
  const [gStatus, setGStatus] = useState<GemeinsamStatus | null>(null);
  const desktop = useZustand((z) => z.desktop);
  const statusLaden = () => {
    void api.screenshotStatus().then(setStatus).catch(() => undefined);
    return api.gemeinsamStatus().then(setGStatus).catch(() => undefined);
  };
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
        gemeinsamer_ordner: gemeinsam.trim(),
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
          <Users size={13} /> Alle Arbeitsplätze (NAS)
        </legend>
        <label className="feld">
          Gemeinsamer Ordner – an allen PCs denselben eintragen, z. B. {"\\\\NAS\\Ergo4You\\PDF"}
          <span className="feld-mit-knopf">
            <input value={gemeinsam} onChange={(ev) => setGemeinsam(ev.target.value)} placeholder="leer = nur dieser PC" aria-label="Gemeinsamer Ordner" />
            {desktop && (
              <button
                type="button"
                className="umschalter"
                onClick={async () => {
                  const r = await api.ordnerDialog(gemeinsam).catch(() => null);
                  if (r?.pfad) setGemeinsam(r.pfad);
                }}
              >
                Wählen …
              </button>
            )}
          </span>
        </label>
        {gStatus?.aktiv ? (
          <p className={gStatus.erreichbar ? "leise" : "warnung"}>
            {gStatus.erreichbar
              ? "Verbunden – für alle gleich: Stempel, Texterkennungssprachen, Favoriten-Ordner und eigenes Wörterbuch. Kürzel, Unterschriften und Ansicht bleiben persönlich."
              : gStatus.fehler}
          </p>
        ) : (
          <p className="leise">Stempel, Favoriten und eigene Wörter gelten nur an diesem PC.</p>
        )}
      </fieldset>
      <WindowsUndUpdates />
      <DruckerBereich />
      <ChromeBereich />
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
      <div className="dialog sehr-breit" role="dialog" aria-label="Über Ergo4You PDF" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Info size={18} /> {PRODUKT} {s ? s.version : ""} · {STAND}
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
                  Rechtsklick auf Dateien: „Mit Ergo4You PDF öffnen“, „Zu einer PDF zusammenführen“, „In PDF umwandeln“. Wird nur für Ihr
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

function WindowsUndUpdates() {
  const [win, setWin] = useState<WindowsStatus | null>(null);
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [prueft, setPrueft] = useState(false);
  const laden = async () => {
    setPrueft(true);
    const [w, u] = await Promise.all([api.windowsStatus().catch(() => null), updatePruefen()]);
    setWin(w);
    setUpd(u);
    setPrueft(false);
  };
  useEffect(() => {
    void laden();
  }, []);
  const updateText = !upd
    ? "…"
    : upd.verfuegbar
      ? `Version ${upd.version} liegt bereit.`
      : upd.grund === "kein_ordner"
        ? "Updates kommen über den gemeinsamen Ordner: neue Setup-Datei in dessen Unterordner „Updates“ legen."
        : upd.grund === "nicht_erreichbar"
          ? `Update-Ordner nicht erreichbar: ${upd.ordner}`
          : `Aktuell – keine neuere Version in ${upd.ordner}.`;
  return (
    <fieldset className="gruppe">
      <legend>
        <MonitorCog size={13} /> Windows & Updates
      </legend>
      <p className="leise">
        Installierte Version: <strong>{upd?.aktuelle_version ?? "…"}</strong> · {updateText}
      </p>
      <div className="auswahl-zeile">
        <button type="button" className="umschalter" disabled={prueft} onClick={() => void laden()}>
          <RefreshCw size={13} /> Nach Updates suchen
        </button>
        {upd?.verfuegbar && (
          <button type="button" className="umschalter primaer" onClick={() => void updateInstallieren()}>
            <Download size={13} /> Jetzt auf {upd.version} aktualisieren
          </button>
        )}
      </div>
      {win?.windows && (
        <>
          <p className={win.standard ? "leise" : "warnung"}>
            {win.standard
              ? "Ergo4You PDF ist das Standard-Programm für PDF-Dateien."
              : "Ein anderes Programm öffnet PDFs per Doppelklick. In den Windows-Einstellungen bei „.pdf“ Ergo4You PDF auswählen."}
          </p>
          <div className="auswahl-zeile">
            {!win.standard && (
              <button
                type="button"
                className="umschalter"
                onClick={() =>
                  void api
                    .standardprogramm()
                    .then(() => melden("Windows-Einstellungen geöffnet – dort bei „.pdf“ Ergo4You PDF wählen."))
                    .catch((e: Error) => melden(e.message, "fehler"))
                }
              >
                Als Standard-PDF-Programm festlegen …
              </button>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
