// Tabs, Eigenschaftsleiste, Statusleiste, Meldungen, Passwortdialog.

import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  Columns2,
  FileText,
  Lock,
  Minus,
  Pin,
  Plus,
  RectangleVertical,
  Trash2,
  X,
} from "lucide-react";
import { ART_NAMEN, auswahlLoeschen, farbpalette, stilAendern, stilFuer } from "../zustand/anmerkungen";
import { useEffect, useRef, useState } from "react";
import { dokumentSchliessen, oeffnenDialog } from "../zustand/aktionen";
import { Kontextmenue } from "./Kontextmenue";
import { ROLLEN_VORSCHLAEGE } from "./Unterschrift";
import { istSeitenDrag, laufenderSeitenDrag, seitenDragDaten, zeigerInnerhalb } from "../zustand/seitenDrag";
import { seitenUebertragen } from "../zustand/seitenaktionen";
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

const KEINE_STEMPEL: { text: string; farbe: string }[] = [];

// ------------------------------------------------------------------- Tabs
export function Tabs() {
  const dokumente = useZustand((z) => z.dokumente);
  const aktiv = useZustand((z) => z.aktiv);
  const [ziehe, setZiehe] = useState<number | null>(null);
  const [tabMenue, setTabMenue] = useState<{ x: number; y: number; id: string } | null>(null);
  // Seiten aus der Miniaturleiste auf einen Tab ziehen: kurz verweilen
  // wechselt zum Dokument (dann an beliebiger Stelle ablegen), Loslassen auf
  // dem Tab hängt die Seiten hinten an.
  const [seitenZiel, setSeitenZiel] = useState<string | null>(null);
  const wechselTimer = useRef<number>(0);
  const ueberTab = (e: React.DragEvent, id: string) => {
    if (!istSeitenDrag(e)) return;
    const quelle = laufenderSeitenDrag()?.dokId;
    e.preventDefault();
    e.dataTransfer.dropEffect = quelle !== id && (e.ctrlKey || e.metaKey) ? "copy" : "move";
    if (seitenZiel !== id) setSeitenZiel(id);
    if (id !== aktiv && !wechselTimer.current) {
      wechselTimer.current = window.setTimeout(() => {
        wechselTimer.current = 0;
        setzen((z) => ({ aktiv: id, seitenleiste: { ...z.seitenleiste, offen: true, panel: "miniaturen" } }));
      }, 600);
    }
  };
  const zielVerlassen = () => {
    window.clearTimeout(wechselTimer.current);
    wechselTimer.current = 0;
    setSeitenZiel(null);
  };

  return (
    <div className="tabs" role="tablist" aria-label="Geöffnete Dokumente">
      {dokumente.map((d, i) => (
        <div
          key={d.id}
          role="tab"
          aria-selected={d.id === aktiv}
          className={`tab${d.id === aktiv ? " aktiv" : ""}${seitenZiel === d.id ? " seiten-ziel" : ""}`}
          title={d.pfad ?? d.titel}
          draggable
          onDragStart={() => setZiehe(i)}
          onDragEnd={() => setZiehe(null)}
          onDragEnter={(e) => ueberTab(e, d.id)}
          onDragOver={(e) => {
            if (ziehe !== null) {
              e.preventDefault();
              return;
            }
            ueberTab(e, d.id);
          }}
          onDragLeave={(e) => {
            if (!zeigerInnerhalb(e)) zielVerlassen();
          }}
          onDrop={(e) => {
            if (ziehe !== null) {
              if (ziehe !== i) tabVerschieben(ziehe, i);
              setZiehe(null);
              return;
            }
            if (!istSeitenDrag(e)) return;
            e.preventDefault();
            zielVerlassen();
            const daten = seitenDragDaten(e);
            if (!daten || daten.dokId === d.id) return;
            void seitenUebertragen(daten.dokId, daten.seiten, d.id, d.seitenanzahl, !(e.ctrlKey || e.metaKey));
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
          <FileText size={13} className="tab-symbol" />
          {d.verschluesselt && <Lock size={12} />}
          {d.gesperrt_von && (
            <Lock size={12} className="tab-gesperrt" aria-label={`bei ${d.gesperrt_von.benutzer} geöffnet`}>
              <title>{`Bei ${d.gesperrt_von.benutzer} (PC ${d.gesperrt_von.rechner}) geöffnet`}</title>
            </Lock>
          )}
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
const STEUERUNG: Record<string, { farbe?: boolean; fuellung?: boolean; breite?: boolean; deckkraft?: boolean; schrift?: boolean }> = {
  hervorheben: { farbe: true },
  unterstreichen: { farbe: true, deckkraft: true },
  durchstreichen: { farbe: true, deckkraft: true },
  wellenlinie: { farbe: true, deckkraft: true },
  notiz: { farbe: true },
  textfeld: { farbe: true, fuellung: true, breite: true, schrift: true },
  schreibmaschine: { farbe: true, schrift: true },
  rechteck: { farbe: true, fuellung: true, breite: true, deckkraft: true },
  ellipse: { farbe: true, fuellung: true, breite: true, deckkraft: true },
  linie: { farbe: true, breite: true, deckkraft: true },
  pfeil: { farbe: true, breite: true, deckkraft: true },
  freihand: { farbe: true, breite: true, deckkraft: true },
  stempel: { schrift: true },
  bild: { deckkraft: true },
  unterschrift: { deckkraft: true },
};

const HINWEISE: Partial<Record<string, string>> = {
  textauswahl: "Text mit der Maus markieren – dann kopieren (Strg+C), hervorheben oder schwärzen.",
  hervorheben: "Text mit der Maus überstreichen.",
  unterstreichen: "Text mit der Maus überstreichen.",
  durchstreichen: "Text mit der Maus überstreichen.",
  wellenlinie: "Text mit der Maus überstreichen.",
  notiz: "Auf die Seite klicken, um eine Notiz zu setzen.",
  textfeld: "Rechteck aufziehen (oder klicken) und Text eingeben.",
  schreibmaschine: "Auf die Seite klicken und lostippen. Esc oder Klick daneben beendet.",
  rechteck: "Rechteck aufziehen.",
  ellipse: "Ellipse aufziehen.",
  linie: "Linie ziehen – Umschalt rastet auf 45° ein.",
  pfeil: "Pfeil ziehen – Umschalt rastet auf 45° ein.",
  freihand: "Mit gedrückter Maustaste zeichnen.",
  stempel: "Vorlage wählen und auf die Seite klicken.",
  platzieren: "Auf die Seite klicken oder Rechteck aufziehen.",
  abdecken: "Bereich aufziehen, der weiß überdeckt wird.",
  freistellen: "Rahmen eng um das Motiv (Logo, Foto, Unterschrift) ziehen – der Hintergrund wird entfernt.",
  textbearbeiten: "Text bearbeiten: Zeile anklicken und ändern · Enter übernimmt · Esc bricht ab · Strg+Z macht es rückgängig",
  formular: "Formular gestalten: Feld aufziehen oder klicken · Feld ziehen = verschieben · Griffe = Größe · Entf = löschen · Esc = fertig",
  schwaerzen: "Bereich aufziehen – wird zum Schwärzen vorgemerkt (rot). Endgültig erst mit „Schwärzungen anwenden“.",
};

/** Erscheint nur bei aktivem Werkzeug oder ausgewählter Anmerkung (kontextabhängig). */
export function Eigenschaftsleiste() {
  const werkzeug = useZustand((z) => z.werkzeug);
  const fixiert = useZustand((z) => z.werkzeugFixiert);
  const lupeFaktor = useZustand((z) => z.lupeFaktor);
  const auswahl = useZustand((z) => z.anmAuswahl);
  const anm = useZustand((z) =>
    z.anmAuswahl ? z.anmerkungen[z.anmAuswahl.dokId]?.seiten[String(z.anmAuswahl.seite)]?.find((a) => a.id === z.anmAuswahl!.id) ?? null : null,
  );
  const editor = useZustand((z) => z.editor);
  useZustand((z) => z.stile); // neu zeichnen, wenn sich ein Stil ändert
  const vorlagen = useZustand((z) => z.einstellungen?.stempel ?? KEINE_STEMPEL);
  const vorlage = useZustand((z) => z.stempelVorlage);
  const formularTyp = useZustand((z) => z.formularTyp);

  const art = editor?.art ?? (auswahl && anm ? anm.art : werkzeug);
  if (werkzeug === "hand" && !anm && !editor) {
    // Leiste bleibt immer stehen – sonst springt das Dokument bei jedem Werkzeugwechsel
    return (
      <div className="eigenschaftsleiste leer" role="toolbar" aria-label="Werkzeugeinstellungen">
        <span className="leise">Hand: Seite verschieben · Anmerkung anklicken zum Auswählen · Doppelklick auf Text zum Bearbeiten</span>
      </div>
    );
  }
  const steuerung = STEUERUNG[art] ?? {};
  const stil = editor
    ? editor.stil
    : anm
      ? {
          farbe: (anm.art === "schreibmaschine" ? anm.textfarbe : anm.farbe) ?? "#000000",
          fuellung: anm.fuellung,
          breite: anm.breite,
          deckkraft: anm.deckkraft,
          schriftgroesse: anm.schriftgroesse ?? 11,
        }
      : stilFuer(art);

  return (
    <div className="eigenschaftsleiste" role="toolbar" aria-label="Werkzeugeinstellungen">
      {anm && !editor && (
        <strong>
          {ART_NAMEN[anm.art] ?? anm.art}
          {anm.autor ? ` · ${anm.autor}` : ""}
        </strong>
      )}
      {!anm && !editor && werkzeug === "textbereich" && (
        <span>
          <strong>Text aus Bereich:</strong> Rechteck um den gewünschten Text aufziehen – er wird erkannt und kopiert.
        </span>
      )}
      {!anm && !editor && werkzeug === "lassozoom" && (
        <span>
          <strong>Bereich zoomen:</strong> Rechteck aufziehen · Klick = 2× vergrößern · Umschalt+Klick = verkleinern
        </span>
      )}
      {!anm && !editor && werkzeug === "formular" && formularTyp === "unterschrift" && <RollenLeiste />}
      {!anm && !editor && werkzeug === "lupe" && (
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
      {!anm && !editor && werkzeug === "stempel" && (
        <label>
          Stempel
          <select value={vorlage} onChange={(e) => setzen({ stempelVorlage: Number(e.target.value) })} aria-label="Stempelvorlage">
            {vorlagen.map((v, i) => (
              <option key={i} value={i}>
                {v.text.split("\n")[0]}
              </option>
            ))}
          </select>
          <button className="link" onClick={() => setzen({ dialog: { art: "stempel" } })}>
            Verwalten …
          </button>
        </label>
      )}
      {steuerung.farbe && <Farbwahl titel={art === "schreibmaschine" || art === "textfeld" ? "Textfarbe" : "Farbe"} wert={stil.farbe} aendern={(farbe) => farbe && stilAendern({ farbe })} />}
      {steuerung.fuellung && <Farbwahl titel="Füllung" wert={stil.fuellung} leer aendern={(fuellung) => stilAendern({ fuellung })} />}
      {steuerung.breite && (
        <label>
          Linie
          <select value={stil.breite} onChange={(e) => stilAendern({ breite: Number(e.target.value) })} aria-label="Linienbreite">
            {[0, 0.5, 1, 1.5, 2, 3, 4, 6, 8].map((b) => (
              <option key={b} value={b}>
                {b === 0 ? "ohne" : `${String(b).replace(".", ",")} pt`}
              </option>
            ))}
          </select>
        </label>
      )}
      {steuerung.schrift && (
        <label>
          Schrift
          <select value={stil.schriftgroesse} onChange={(e) => stilAendern({ schriftgroesse: Number(e.target.value) })} aria-label="Schriftgröße">
            {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48].map((g) => (
              <option key={g} value={g}>
                {g} pt
              </option>
            ))}
          </select>
        </label>
      )}
      {steuerung.deckkraft && (
        <label>
          Deckkraft
          <select value={Math.round(stil.deckkraft * 100)} onChange={(e) => stilAendern({ deckkraft: Number(e.target.value) / 100 })} aria-label="Deckkraft">
            {[100, 75, 50, 25].map((d) => (
              <option key={d} value={d}>
                {d} %
              </option>
            ))}
          </select>
        </label>
      )}
      {!anm && !editor && HINWEISE[werkzeug] && !(werkzeug === "formular" && formularTyp === "unterschrift") && <span className="leise">{HINWEISE[werkzeug]}</span>}
      <span className="abstand" />
      {anm && !editor && (
        <button className="umschalter" onClick={() => auswahlLoeschen()}>
          <Trash2 size={14} /> Löschen
        </button>
      )}
      {!anm && !editor && werkzeug !== "hand" && werkzeug !== "lupe" && (
        <button className={fixiert ? "umschalter an" : "umschalter"} onClick={() => setzen({ werkzeugFixiert: !fixiert })} aria-pressed={fixiert}>
          <Pin size={14} /> Werkzeug fixieren
        </button>
      )}
      <button className="umschalter" onClick={() => setzen({ werkzeug: "hand", anmAuswahl: null, platzieren: null, textAuswahl: null })}>
        {anm && !editor ? "Auswahl aufheben (Esc)" : "Beenden (Esc)"}
      </button>
    </div>
  );
}

function Farbwahl(p: { titel: string; wert: string | null; aendern: (f: string | null) => void; leer?: boolean }) {
  return (
    <div className="farbwahl" role="group" aria-label={p.titel}>
      <span>{p.titel}</span>
      {p.leer && (
        <button className={`farbe keine${p.wert === null ? " gewaehlt" : ""}`} title="Keine" aria-label="Keine Füllung" onClick={() => p.aendern(null)} />
      )}
      {farbpalette().map((f) => (
        <button
          key={f}
          className={`farbe${p.wert?.toUpperCase() === f ? " gewaehlt" : ""}`}
          style={{ background: f }}
          title={f}
          aria-label={`Farbe ${f}`}
          onClick={() => p.aendern(f)}
        />
      ))}
      <input type="color" value={p.wert ?? "#ffffff"} onChange={(e) => p.aendern(e.target.value.toUpperCase())} aria-label={`${p.titel} frei wählen`} />
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

  if (!dok) return <footer className="statusleiste"><span className="leise">Bereit</span></footer>;
  const s = dok.seiten[dok.ansicht.seite];
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const gehe = (n: number) => springen(dok.id, Math.max(0, Math.min(dok.seitenanzahl - 1, n)));

  return (
    <footer className="statusleiste">
      <span className="status-info" title="Seitenformat">
        {s ? `${mm(s.breite)} × ${mm(s.hoehe)} mm` : ""}
      </span>
      {dok.schutz && dok.schutz !== "keiner" && (
        <span className="status-info" title="Kennwortschutz beim Speichern">
          <Lock size={12} /> geschützt
        </span>
      )}
      <span className="abstand" />
      <div className="seitenwahl" role="group" aria-label="Seite">
        <button aria-label="Erste Seite" title="Erste Seite (Pos1)" disabled={seite <= 1} onClick={() => gehe(0)}>
          <ChevronsLeft size={14} />
        </button>
        <button aria-label="Vorige Seite" title="Vorige Seite (Bild auf)" disabled={seite <= 1} onClick={() => gehe(seite - 2)}>
          <ChevronLeft size={14} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseInt(seitenEingabe, 10);
            if (n >= 1 && n <= dok.seitenanzahl) springen(dok.id, n - 1);
            else setSeitenEingabe(String(seite));
          }}
        >
          <input aria-label="Seitenzahl" value={seitenEingabe} onChange={(e) => setSeitenEingabe(e.target.value)} onFocus={(e) => e.target.select()} size={3} />
          <span> / {dok.seitenanzahl}</span>
        </form>
        <button aria-label="Nächste Seite" title="Nächste Seite (Bild ab)" disabled={seite >= dok.seitenanzahl} onClick={() => gehe(seite)}>
          <ChevronRight size={14} />
        </button>
        <button aria-label="Letzte Seite" title="Letzte Seite (Ende)" disabled={seite >= dok.seitenanzahl} onClick={() => gehe(dok.seitenanzahl - 1)}>
          <ChevronsRight size={14} />
        </button>
      </div>
      <span className="trenner" />
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
      <span className="trenner" />
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
            list="zoom-stufen"
            value={zoomEingabe}
            onChange={(e) => setZoomEingabe(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setZoomEingabe(`${zoomProzent} %`)}
            size={6}
          />
          <datalist id="zoom-stufen">
            {[25, 50, 75, 100, 125, 150, 200, 300, 400, 800].map((z) => (
              <option key={z} value={`${z} %`} />
            ))}
          </datalist>
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

/** Beim Werkzeug „Unterschriftsfeld“: wer unterschreibt in den neuen Feldern? */
function RollenLeiste() {
  const rolle = useZustand((z) => z.signaturRolle);
  const [eigene, setEigene] = useState("");
  const istVorschlag = ROLLEN_VORSCHLAEGE.includes(rolle);
  return (
    <span className="rollen-leiste">
      <strong>Unterschriftsfeld für:</strong>
      {ROLLEN_VORSCHLAEGE.map((r) => (
        <button key={r} type="button" className={`umschalter${r === rolle ? " an" : ""}`} aria-pressed={r === rolle} onClick={() => setzen({ signaturRolle: r })}>
          {r}
        </button>
      ))}
      <input
        className="zahl breit"
        value={istVorschlag ? eigene : rolle}
        placeholder="andere Rolle …"
        aria-label="Andere Rolle"
        onChange={(e) => {
          setEigene(e.target.value);
          if (e.target.value.trim()) setzen({ signaturRolle: e.target.value.trim() });
        }}
      />
      <span className="leise">Feld aufziehen · gleiche Rolle = dieselbe Person (eigener Link je Rolle) · Esc = fertig</span>
    </span>
  );
}
