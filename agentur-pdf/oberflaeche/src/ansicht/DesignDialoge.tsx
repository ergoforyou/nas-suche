// Dialoge im Register „Design“: Objekt freistellen, Briefpapier, Deckblatt,
// Hausfarben.

import { FileUp, ImagePlus, LayoutTemplate, Palette, Scissors, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Rechteck } from "../typen";
import { anwenden } from "../zustand/seitenaktionen";
import { bildWaehlen } from "../zustand/ausgabe";
import { holen, melden, setzen, springen, useZustand, werkzeugWaehlen } from "../zustand/store";
import { Rahmen, SeitenWahl, seitenErmitteln, type Bereich } from "./WerkzeugDialoge";

const schliessen = () => setzen({ dialog: null });

// ============================================================ Freistellen
const ARTEN: [string, string, string][] = [
  ["motiv", "Motiv (Foto)", "Person, Gegenstand, Gebäude – Hintergrund wird erkannt und entfernt"],
  ["weiss", "Logo / Grafik auf Weiß", "Weißer Hintergrund wird durchsichtig"],
  ["keiner", "Ausschnitt ohne Freistellen", "Rechteckiger Ausschnitt als verschiebbares Bild"],
];

export function FreistellenDialog({ dokId, seite, rechteck }: { dokId: string; seite: number; rechteck: Rechteck }) {
  const [modus, setModus] = useState("motiv");
  const [staerke, setStaerke] = useState(50);
  const [abdecken, setAbdecken] = useState(true);
  const [vorschau, setVorschau] = useState<{ bild_id: string; bild: string; rechteck: Rechteck } | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => {
    let aktuell = true;
    setVorschau(null);
    const t = window.setTimeout(() => {
      api
        .freistellen(dokId, seite, rechteck, modus, staerke)
        .then((v) => aktuell && setVorschau(v))
        .catch((e: Error) => aktuell && melden(e.message, "fehler"));
    }, 200);
    return () => {
      aktuell = false;
      window.clearTimeout(t);
    };
  }, [dokId, seite, rechteck, modus, staerke]);

  const einsetzen = async () => {
    if (!vorschau) return;
    setLaeuft(true);
    try {
      const r = await api.freistellenEinsetzen(dokId, seite, vorschau.bild_id, vorschau.rechteck, abdecken ? rechteck : null);
      anwenden(r, dokId);
      setzen({ dialog: null, werkzeug: "hand", anmAuswahl: { dokId, seite, id: r.id }, rechtsOffen: true });
      melden("Objekt eingesetzt – jetzt mit der Maus verschieben, an den Ecken skalieren, im Register Design drehen oder anordnen.");
    } catch (e) {
      melden((e as Error).message, "fehler");
    }
    setLaeuft(false);
  };

  return (
    <Rahmen titel="Objekt freistellen" icon={<Scissors size={18} />} breit="sehr-breit" label="Objekt freistellen" onSubmit={() => void einsetzen()}>
      <div className="fs-bereich">
        <div className="fs-optionen">
          {ARTEN.map(([id, titel, text]) => (
            <label key={id} className={`fs-art${modus === id ? " gewaehlt" : ""}`}>
              <input type="radio" name="fs-art" checked={modus === id} onChange={() => setModus(id)} />
              <span>
                <strong>{titel}</strong>
                <small className="leise">{text}</small>
              </span>
            </label>
          ))}
          {modus !== "keiner" && (
            <label className="regler">
              {modus === "motiv" ? "Kante weich" : "Stärke"}
              <input type="range" min={0} max={100} value={staerke} onChange={(e) => setStaerke(Number(e.target.value))} aria-label="Stärke" />
            </label>
          )}
          <label className="schalter-zeile">
            <input type="checkbox" checked={abdecken} onChange={(e) => setAbdecken(e.target.checked)} /> Ursprünglichen Bereich weiß abdecken
          </label>
          <p className="leise klein">Tipp: Rahmen eng um das Motiv ziehen – der Rand gilt als Hintergrund.</p>
        </div>
        <div className="fs-vorschau schachbrett">{vorschau ? <img src={vorschau.bild} alt="Freigestellt" /> : <span className="leise">wird berechnet …</span>}</div>
      </div>
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer" disabled={!vorschau || laeuft}>
          Einsetzen
        </button>
      </div>
    </Rahmen>
  );
}

// ============================================================ Briefpapier
export function BriefpapierDialog({ dokId }: { dokId: string }) {
  const [liste, setListe] = useState<{ name: string; groesse: number }[] | null>(null);
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [bereich, setBereich] = useState<Bereich>("alle");
  const [eigene, setEigene] = useState("");
  const laden = () =>
    api
      .briefpapierListe()
      .then((l) => {
        setListe(l);
        setGewaehlt((g) => (g && l.some((x) => x.name === g) ? g : l[0]?.name ?? null));
      })
      .catch((e: Error) => melden(e.message, "fehler"));
  useEffect(() => {
    void laden();
  }, []);
  const hochladen = async () => {
    const auswahl = document.createElement("input");
    auswahl.type = "file";
    auswahl.accept = "application/pdf,.pdf";
    auswahl.onchange = async () => {
      const f = auswahl.files?.[0];
      if (!f) return;
      try {
        const r = await api.briefpapierHochladen(f, f.name);
        await laden();
        setGewaehlt(r.name);
        melden(`Briefpapier „${r.name}“ gespeichert${r.seiten > 1 ? " (Seite 1 = erste Seite, Seite 2 = Folgeseiten)" : ""}.`);
      } catch (e) {
        melden((e as Error).message, "fehler");
      }
    };
    auswahl.click();
  };
  return (
    <Rahmen
      titel="Briefpapier unterlegen"
      icon={<LayoutTemplate size={18} />}
      breit="sehr-breit"
      label="Briefpapier"
      onSubmit={async () => {
        if (!gewaehlt) return;
        const seiten = seitenErmitteln(dokId, bereich, eigene);
        if (seiten === undefined) return;
        try {
          const r = await api.briefpapierAnwenden(dokId, gewaehlt, seiten);
          anwenden(r, dokId);
          schliessen();
          melden(`Briefpapier unter ${r.anzahl} Seite(n) gelegt – Ebene „Briefpapier“ (ausblendbar). Strg+Z macht es rückgängig.`);
        } catch (e) {
          melden((e as Error).message, "fehler");
        }
      }}
    >
      <p className="leise">
        Briefbogen als PDF (z. B. aus Word „Als PDF speichern“). Hat er zwei Seiten, gilt Seite 1 für die erste und Seite 2 für alle weiteren Seiten. Liegt
        im gemeinsamen Ordner – für alle Arbeitsplätze.
      </p>
      <div className="bp-liste" role="radiogroup" aria-label="Briefpapier">
        {liste?.map((b) => (
          <div key={b.name} className={`bp-karte${gewaehlt === b.name ? " gewaehlt" : ""}`}>
            <button type="button" role="radio" aria-checked={gewaehlt === b.name} onClick={() => setGewaehlt(b.name)} title={b.name}>
              <img src={api.briefpapierVorschau(b.name)} alt="" />
              <span>{b.name.replace(/\.pdf$/i, "")}</span>
            </button>
            <button
              type="button"
              className="bp-loeschen"
              aria-label={`${b.name} löschen`}
              onClick={async () => {
                await api.briefpapierLoeschen(b.name).catch(() => undefined);
                void laden();
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button type="button" className="bp-karte bp-neu" onClick={() => void hochladen()}>
          <FileUp size={22} />
          <span>Briefpapier hinzufügen …</span>
        </button>
      </div>
      <SeitenWahl dokId={dokId} bereich={bereich} setBereich={setBereich} eigene={eigene} setEigene={setEigene} />
      <p className="leise klein">Hinweis: Bei Scans liegt das Briefpapier unsichtbar unter dem deckenden Scanbild.</p>
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer" disabled={!gewaehlt}>
          Unterlegen
        </button>
      </div>
    </Rahmen>
  );
}

// ============================================================== Deckblatt
const LAYOUTS: [string, string][] = [
  ["band", "Farbband"],
  ["seitenleiste", "Seitenleiste"],
  ["zentriert", "Zentriert"],
];

export function DeckblattDialog({ dokId }: { dokId: string }) {
  const e = useZustand((z) => z.einstellungen);
  const [titel, setTitel] = useState("Ihr persönliches Angebot");
  const [untertitel, setUntertitel] = useState("");
  const [kunde, setKunde] = useState("");
  const [verfasser, setVerfasser] = useState(e?.kuerzel ?? "");
  const [datum, setDatum] = useState(new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }));
  const [layout, setLayout] = useState("band");
  const [farbe, setFarbe] = useState(e?.hausfarben?.[0] ?? "#B5121B");
  const [logo, setLogo] = useState<{ id: string; bild: string } | null>(null);
  const [verzeichnis, setVerzeichnis] = useState(false);
  return (
    <Rahmen
      titel="Deckblatt erstellen"
      icon={<LayoutTemplate size={18} />}
      breit="sehr-breit"
      label="Deckblatt"
      onSubmit={async () => {
        try {
          let r = await api.deckblatt(dokId, { titel, untertitel, kunde, verfasser, datum, layout, farbe, logo_id: logo?.id });
          if (verzeichnis) {
            try {
              r = await api.inhaltsverzeichnis(dokId, 1, "Inhalt", farbe);
            } catch (err) {
              melden((err as Error).message, "fehler");
            }
          }
          anwenden(r, dokId);
          springen(dokId, 0);
          schliessen();
          melden("Deckblatt eingefügt – Strg+Z macht es rückgängig.");
        } catch (err) {
          melden((err as Error).message, "fehler");
        }
      }}
    >
      <div className="db-raster">
        <div className="db-felder">
          <label className="feld">
            Titel
            <input value={titel} onChange={(ev) => setTitel(ev.target.value)} aria-label="Titel" />
          </label>
          <label className="feld">
            Untertitel
            <input value={untertitel} onChange={(ev) => setUntertitel(ev.target.value)} placeholder="z. B. Hausrat- und Haftpflichtversicherung" aria-label="Untertitel" />
          </label>
          <label className="feld">
            Für (Kunde)
            <input value={kunde} onChange={(ev) => setKunde(ev.target.value)} placeholder="z. B. Familie Muster" aria-label="Kunde" />
          </label>
          <div className="db-zwei">
            <label className="feld">
              Datum
              <input value={datum} onChange={(ev) => setDatum(ev.target.value)} aria-label="Datum" />
            </label>
            <label className="feld">
              Ansprechpartner
              <input value={verfasser} onChange={(ev) => setVerfasser(ev.target.value)} aria-label="Ansprechpartner" />
            </label>
          </div>
          <div className="auswahl-zeile">
            Farbe
            {[...(e?.hausfarben ?? []), "#B5121B", "#1E3A8A", "#1F7A4D", "#3B4A5A"].slice(0, 6).map((f) => (
              <button key={f} type="button" className={`farbe${farbe.toUpperCase() === f.toUpperCase() ? " gewaehlt" : ""}`} style={{ background: f }} aria-label={`Farbe ${f}`} onClick={() => setFarbe(f)} />
            ))}
            <input type="color" value={farbe} onChange={(ev) => setFarbe(ev.target.value.toUpperCase())} aria-label="Farbe frei wählen" />
          </div>
          <div className="auswahl-zeile">
            <button
              type="button"
              className="umschalter"
              onClick={async () => {
                const f = await bildWaehlen();
                if (!f) return;
                try {
                  const b = await api.bildHochladen(f, false);
                  setLogo({ id: b.id, bild: b.bild });
                } catch (err) {
                  melden((err as Error).message, "fehler");
                }
              }}
            >
              <ImagePlus size={14} /> {logo ? "Anderes Logo …" : "Logo wählen …"}
            </button>
            {logo && <img className="db-logo" src={logo.bild} alt="Logo" />}
          </div>
          <label className="schalter-zeile">
            <input type="checkbox" checked={verzeichnis} onChange={(ev) => setVerzeichnis(ev.target.checked)} /> Inhaltsverzeichnis dahinter (aus den Lesezeichen)
          </label>
        </div>
        <div className="db-layouts" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map(([id, name]) => (
            <button key={id} type="button" role="radio" aria-checked={layout === id} className={`db-layout${layout === id ? " gewaehlt" : ""}`} onClick={() => setLayout(id)}>
              <DeckblattSkizze layout={id} farbe={farbe} />
              <span>{name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer" disabled={!titel.trim()}>
          Deckblatt einfügen
        </button>
      </div>
    </Rahmen>
  );
}

function DeckblattSkizze({ layout, farbe }: { layout: string; farbe: string }) {
  return (
    <svg viewBox="0 0 70 99" className="db-skizze" aria-hidden>
      <rect x="0" y="0" width="70" height="99" fill="#fff" stroke="#ccc" />
      {layout === "band" && (
        <>
          <rect x="0" y="0" width="70" height="36" fill={farbe} />
          <rect x="7" y="17" width="40" height="5" fill="#fff" />
          <rect x="7" y="41" width="30" height="3" fill="#999" />
        </>
      )}
      {layout === "seitenleiste" && (
        <>
          <rect x="0" y="0" width="5" height="99" fill={farbe} />
          <rect x="9" y="30" width="1.5" height="15" fill={farbe} />
          <rect x="13" y="31" width="40" height="5" fill="#333" />
          <rect x="13" y="40" width="28" height="3" fill="#999" />
        </>
      )}
      {layout === "zentriert" && (
        <>
          <rect x="7" y="29" width="56" height="0.8" fill={farbe} />
          <rect x="7" y="51" width="56" height="0.8" fill={farbe} />
          <rect x="15" y="35" width="40" height="5" fill="#333" />
          <rect x="22" y="44" width="26" height="3" fill="#999" />
        </>
      )}
      <rect x="7" y="76" width="22" height="2" fill={farbe} />
      <rect x="7" y="80" width="30" height="3" fill="#666" />
    </svg>
  );
}

// ============================================================= Hausfarben
export function HausfarbenDialog() {
  const e = useZustand((z) => z.einstellungen);
  const [farben, setFarben] = useState<string[]>(() => {
    const f = [...(e?.hausfarben ?? [])];
    while (f.length < 6) f.push("");
    return f.slice(0, 6);
  });
  return (
    <Rahmen
      titel="Hausfarben der Agentur"
      icon={<Palette size={18} />}
      breit="breit"
      label="Hausfarben"
      onSubmit={async () => {
        try {
          const neu = await api.einstellungenSetzen({ hausfarben: farben.filter(Boolean).map((f) => f.toUpperCase()) });
          setzen({ einstellungen: neu, dialog: null });
          melden("Hausfarben gespeichert – sie stehen jetzt in allen Farbauswahlen vorne.");
        } catch (err) {
          melden((err as Error).message, "fehler");
        }
      }}
    >
      <p className="leise">
        Bis zu sechs Farben aus dem Firmenauftritt. Die erste ist die Akzentfarbe für Deckblätter, Überschriften und Preisboxen. Mit gemeinsamem Ordner gelten sie
        an allen PCs.
      </p>
      <div className="hf-liste">
        {farben.map((f, i) => (
          <label key={i} className="hf-farbe">
            <input
              type="color"
              value={f || "#FFFFFF"}
              onChange={(ev) => setFarben(farben.map((x, j) => (j === i ? ev.target.value.toUpperCase() : x)))}
              aria-label={`Hausfarbe ${i + 1}`}
            />
            <input
              className="zahl breit"
              value={f}
              placeholder="#RRGGBB"
              onChange={(ev) => setFarben(farben.map((x, j) => (j === i ? ev.target.value : x)))}
              aria-label={`Hausfarbe ${i + 1} als Code`}
            />
            {f && (
              <button type="button" aria-label="Farbe entfernen" onClick={() => setFarben(farben.map((x, j) => (j === i ? "" : x)))}>
                <Trash2 size={13} />
              </button>
            )}
          </label>
        ))}
      </div>
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer">
          Speichern
        </button>
      </div>
    </Rahmen>
  );
}

/** Werkzeug „Objekt freistellen“ starten (Bereich aufziehen) */
export function freistellenStarten(): void {
  if (!holen().aktiv) return;
  werkzeugWaehlen("freistellen");
  melden("Rahmen eng um das Motiv auf der Seite ziehen.");
}

