// Dialoge für Bearbeiten, Schützen und Ausgabe: Drucken/Exportieren,
// Kennwort, Schwärzen, Komprimieren, Eigenschaften, Bild/Unterschrift,
// Foto aufbereiten, Stempel verwalten, Seiten als Bilder.

import {
  Droplet,
  PanelTop,
  Camera,
  Crop,
  Eraser,
  FileArchive,
  FileImage,
  ImagePlus,
  Info,
  KeyRound,
  Maximize,
  Plus,
  Printer,
  RotateCcw,
  RotateCw,
  ScanLine,
  Search,
  Signature,
  Spline,
  Stamp,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, mitToken } from "../api";
import type { BildDaten, Ebene, StempelVorlage, Unterschrift } from "../typen";
import {
  aenderungAnwenden,
  ausgabeSpeichern,
  bildWaehlen,
  exportName,
  fehlerMelden,
  groesseText,
  platzierenStarten,
  seitenbereich,
} from "../zustand/ausgabe";
import { anwenden, namensvorschlag } from "../zustand/seitenaktionen";
import { ocrStarten } from "../zustand/ocr";
import { holen, melden, setzen, springen, useZustand, zielseiten } from "../zustand/store";
import { GRUPPEN_NAMEN } from "../zustand/anmerkungen";

const schliessen = () => setzen({ dialog: null });

export function Rahmen(p: { titel: ReactNode; icon: ReactNode; breit?: "breit" | "sehr-breit"; children: ReactNode; label: string; onSubmit?: () => void }) {
  return (
    <div className="dialog-hintergrund" onMouseDown={schliessen}>
      <form
        className={`dialog ${p.breit ?? ""}`}
        role="dialog"
        aria-label={p.label}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") schliessen();
        }}
      >
        <h2>
          {p.icon} {p.titel}
        </h2>
        {p.children}
      </form>
    </div>
  );
}

// =================================================================== Seiten
export type Bereich = "alle" | "aktuell" | "markiert" | "eigene";

export function SeitenWahl(p: { dokId: string; bereich: Bereich; setBereich: (b: Bereich) => void; eigene: string; setEigene: (s: string) => void }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === p.dokId));
  if (!dok) return null;
  return (
    <fieldset className="feldgruppe">
      <legend>Seiten</legend>
      <label className="auswahl-zeile">
        <input type="radio" checked={p.bereich === "alle"} onChange={() => p.setBereich("alle")} /> Alle ({dok.seitenanzahl})
      </label>
      <label className="auswahl-zeile">
        <input type="radio" checked={p.bereich === "aktuell"} onChange={() => p.setBereich("aktuell")} /> Aktuelle Seite ({dok.ansicht.seite + 1})
      </label>
      {dok.auswahl.length > 0 && (
        <label className="auswahl-zeile">
          <input type="radio" checked={p.bereich === "markiert"} onChange={() => p.setBereich("markiert")} /> Markierte Seiten ({dok.auswahl.length})
        </label>
      )}
      <label className="auswahl-zeile">
        <input type="radio" checked={p.bereich === "eigene"} onChange={() => p.setBereich("eigene")} /> Seiten
        <input
          className="zahl breit"
          value={p.eigene}
          placeholder="z. B. 1-3, 5"
          onFocus={() => p.setBereich("eigene")}
          onChange={(e) => p.setEigene(e.target.value)}
          aria-label="Seitenbereich"
        />
      </label>
    </fieldset>
  );
}

export function seitenErmitteln(dokId: string, bereich: Bereich, eigene: string): number[] | null | undefined {
  const d = holen().dokumente.find((x) => x.id === dokId);
  if (!d) return undefined;
  if (bereich === "alle") return null;
  if (bereich === "aktuell") return [d.ansicht.seite];
  if (bereich === "markiert") return zielseiten(d);
  const s = seitenbereich(eigene, d.seitenanzahl);
  if (!s) {
    melden("Ungültiger Seitenbereich – Beispiel: 1-3, 5", "fehler");
    return undefined;
  }
  return s;
}

// ================================================================== Drucken
export function DruckDialog(p: { dokId: string; alsExport: boolean; startBereich?: Bereich; startSeite?: number }) {
  const { dokId, alsExport } = p;
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const ausblenden = useZustand((z) => z.ausblenden);
  // Rechtsklick auf eine Seite: genau diese Seite vorbelegen
  const [bereich, setBereich] = useState<Bereich>(p.startSeite !== undefined ? "eigene" : (p.startBereich ?? "alle"));
  const [eigene, setEigene] = useState(p.startSeite !== undefined ? String(p.startSeite + 1) : "");
  const [mit, setMit] = useState({ kommentar: !ausblenden.includes("kommentar"), eintragung: true, stempel: true });
  const [ebenen, setEbenen] = useState<Ebene[]>([]);
  const [ebenenEntfernen, setEbenenEntfernen] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [vorschau, setVorschau] = useState<string | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api.ebenen(dokId).then(setEbenen).catch(() => undefined);
  }, [dokId]);

  if (!dok) return null;
  const optionen = (pfad: string | null) => {
    const seiten = seitenErmitteln(dokId, bereich, eigene);
    if (seiten === undefined) throw new Error("Ungültiger Seitenbereich.");
    return {
      seiten,
      gruppen_weg: (Object.keys(mit) as (keyof typeof mit)[]).filter((k) => !mit[k]),
      ebenen_aus: ebenen.filter((e) => !e.an).map((e) => e.id),
      ebenen_entfernen: ebenenEntfernen,
      pfad,
    };
  };

  const ausfuehren = async () => {
    setLaeuft(true);
    try {
      if (alsExport) {
        const ok = await ausgabeSpeichern(exportName(dok, ""), (pfad) => api.ausgabe(dokId, optionen(pfad)));
        if (ok) schliessen();
      } else {
        const r = await api.ausgabe(dokId, optionen(null));
        if (r.url) setVorschau(mitToken(r.url));
      }
    } catch (e) {
      fehlerMelden(e);
    }
    setLaeuft(false);
  };

  if (vorschau) {
    return (
      <Rahmen titel="Druckvorschau" icon={<Printer size={18} />} breit="sehr-breit" label="Druckvorschau">
        <iframe
          ref={iframe}
          className="druck-vorschau"
          src={vorschau}
          title="Druckvorschau"
          onLoad={() =>
            window.setTimeout(() => {
              try {
                iframe.current?.contentWindow?.print();
              } catch {
                /* Druck über die Schaltfläche in der Vorschau */
              }
            }, 600)
          }
        />
        <p className="leise">Falls das Druckfenster nicht erscheint: In der Vorschau oben rechts auf das Drucker-Symbol klicken.</p>
        <div className="dialog-knoepfe">
          <button type="button" onClick={schliessen}>
            Schließen
          </button>
          <button
            type="button"
            className="primaer"
            onClick={() => {
              try {
                iframe.current?.contentWindow?.print();
              } catch (e) {
                fehlerMelden(e);
              }
            }}
          >
            <Printer size={15} /> Drucken
          </button>
        </div>
      </Rahmen>
    );
  }

  return (
    <Rahmen
      titel={alsExport ? "Exportieren" : "Drucken"}
      icon={alsExport ? <FileArchive size={18} /> : <Printer size={18} />}
      breit="breit"
      label={alsExport ? "Exportieren" : "Drucken"}
      onSubmit={() => void ausfuehren()}
    >
      <p>
        „{dok.titel}“ {alsExport ? "als PDF-Kopie speichern – das Original bleibt unverändert." : "drucken."}
      </p>
      <SeitenWahl dokId={dokId} bereich={bereich} setBereich={setBereich} eigene={eigene} setEigene={setEigene} />
      <fieldset className="feldgruppe">
        <legend>Mit ausgeben</legend>
        {(Object.keys(mit) as (keyof typeof mit)[]).map((g) => (
          <label key={g} className="auswahl-zeile">
            <input type="checkbox" checked={mit[g]} onChange={(e) => setMit({ ...mit, [g]: e.target.checked })} /> {GRUPPEN_NAMEN[g]}
          </label>
        ))}
        <span className="leise">Vorgemerkte Schwärzungen werden nie mit ausgegeben – erst „Schwärzungen anwenden“.</span>
      </fieldset>
      {ebenen.length > 0 && (
        <fieldset className="feldgruppe">
          <legend>Ebenen</legend>
          {ebenen.map((e) => (
            <label key={e.id} className="auswahl-zeile">
              <input type="checkbox" checked={e.an} onChange={(ev) => setEbenen(ebenen.map((x) => (x.id === e.id ? { ...x, an: ev.target.checked } : x)))} />{" "}
              {e.name || "(ohne Namen)"}
            </label>
          ))}
          {alsExport && ebenen.some((e) => !e.an) && (
            <label className="auswahl-zeile">
              <input type="checkbox" checked={ebenenEntfernen} onChange={(e) => setEbenenEntfernen(e.target.checked)} /> Ausgeblendete Ebenen ganz entfernen
            </label>
          )}
        </fieldset>
      )}
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer" disabled={laeuft}>
          {laeuft ? "Bitte warten …" : alsExport ? "Exportieren …" : "Weiter zum Drucken"}
        </button>
      </div>
    </Rahmen>
  );
}

// ================================================================= Kennwort
export function KennwortDialog({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const [kennwort, setKennwort] = useState("");
  const [wiederholung, setWiederholung] = useState("");
  const [rechteEinschraenken, setRechteEinschraenken] = useState(false);
  const [rechte, setRechte] = useState({ drucken: true, kopieren: true, aendern: true, kommentieren: true });
  const [rechteKennwort, setRechteKennwort] = useState("");
  const [vorhanden, setVorhanden] = useState(false);
  useEffect(() => {
    api
      .schutz(dokId)
      .then((s) => {
        setVorhanden(s.verschluesselt || s.kennwort_oeffnen || s.rechte_kennwort);
        setRechte({ drucken: s.rechte.drucken, kopieren: s.rechte.kopieren, aendern: s.rechte.aendern, kommentieren: s.rechte.kommentieren });
      })
      .catch(() => undefined);
  }, [dokId]);
  if (!dok) return null;

  const uebernehmen = async () => {
    if (kennwort !== wiederholung) {
      melden("Die Kennwörter stimmen nicht überein.", "fehler");
      return;
    }
    if (!kennwort && !rechteEinschraenken) {
      melden("Bitte ein Kennwort eingeben oder Rechte einschränken.", "fehler");
      return;
    }
    if (rechteEinschraenken && !rechteKennwort && !kennwort) {
      melden("Für eingeschränkte Rechte wird ein Rechte-Kennwort benötigt.", "fehler");
      return;
    }
    const r = await aenderungAnwenden(
      api.schutzSetzen(dokId, { benutzer: kennwort, besitzer: rechteEinschraenken ? rechteKennwort || kennwort : kennwort, ...(rechteEinschraenken ? rechte : {}) }),
    );
    if (r) {
      schliessen();
      melden("Kennwortschutz wird beim nächsten Speichern angewendet (AES-256).");
    }
  };

  return (
    <Rahmen titel="Kennwortschutz" icon={<KeyRound size={18} />} breit="breit" label="Kennwortschutz" onSubmit={() => void uebernehmen()}>
      <p>„{dok.titel}“ beim Speichern mit AES-256 verschlüsseln.</p>
      <label className="feld">
        Kennwort zum Öffnen
        <input type="password" value={kennwort} onChange={(e) => setKennwort(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="feld">
        Kennwort wiederholen
        <input type="password" value={wiederholung} onChange={(e) => setWiederholung(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="auswahl-zeile">
        <input type="checkbox" checked={rechteEinschraenken} onChange={(e) => setRechteEinschraenken(e.target.checked)} /> Rechte einschränken
      </label>
      {rechteEinschraenken && (
        <fieldset className="feldgruppe">
          <legend>Erlaubt</legend>
          {(
            [
              ["drucken", "Drucken"],
              ["kopieren", "Text kopieren"],
              ["aendern", "Seiten ändern"],
              ["kommentieren", "Kommentieren & Formulare"],
            ] as const
          ).map(([k, t]) => (
            <label key={k} className="auswahl-zeile">
              <input type="checkbox" checked={rechte[k]} onChange={(e) => setRechte({ ...rechte, [k]: e.target.checked })} /> {t}
            </label>
          ))}
          <label className="feld">
            Rechte-Kennwort (zum späteren Ändern)
            <input type="password" value={rechteKennwort} onChange={(e) => setRechteKennwort(e.target.value)} autoComplete="new-password" />
          </label>
        </fieldset>
      )}
      <div className="dialog-knoepfe">
        {vorhanden && (
          <button
            type="button"
            className="gefahr-text"
            onClick={async () => {
              if (await aenderungAnwenden(api.schutzSetzen(dokId, { aus: true }))) {
                schliessen();
                melden("Kennwortschutz wird beim nächsten Speichern entfernt.");
              }
            }}
          >
            Schutz entfernen
          </button>
        )}
        <span className="abstand" />
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer">
          Übernehmen
        </button>
      </div>
    </Rahmen>
  );
}

// ================================================================ Schwärzen
const MUSTER: [string, string][] = [
  ["iban", "IBAN / Kontonummer"],
  ["email", "E-Mail-Adressen"],
  ["telefon", "Telefonnummern"],
  ["datum", "Datumsangaben (z. B. Geburtsdatum)"],
  ["begriff", "Eigener Begriff"],
];

export function SchwaerzenDialog({ dokId }: { dokId: string }) {
  const [muster, setMuster] = useState("iban");
  const [begriff, setBegriff] = useState("");
  const [funde, setFunde] = useState<{ seite: number; text: string; rechteck: [number, number, number, number]; an: boolean }[] | null>(null);
  const [vorgemerkt, setVorgemerkt] = useState(false);
  const [metadaten, setMetadaten] = useState(true);
  const vorhanden = useZustand((z) => Object.values(z.anmerkungen[dokId]?.seiten ?? {}).some((l) => l.some((a) => a.art === "schwaerzung")));

  const suchen = async () => {
    try {
      const r = await api.schwaerzenSuchen(dokId, muster, begriff);
      setFunde(r.map((f) => ({ ...f, an: true })));
    } catch (e) {
      fehlerMelden(e);
    }
  };

  return (
    <Rahmen titel="Schwärzen" icon={<Eraser size={18} />} breit="sehr-breit" label="Schwärzen" onSubmit={() => void suchen()}>
      <p>
        Gefundene Stellen werden <strong>vorgemerkt</strong> (rot umrandet). Erst „Schwärzungen anwenden“ entfernt Text, Bildpunkte und OCR-Text darunter
        endgültig.
      </p>
      <fieldset className="feldgruppe">
        <legend>Suchen nach</legend>
        {MUSTER.map(([id, titel]) => (
          <label key={id} className="auswahl-zeile">
            <input type="radio" checked={muster === id} onChange={() => setMuster(id)} /> {titel}
            {id === "begriff" && (
              <input
                className="zahl breit"
                value={begriff}
                onFocus={() => setMuster("begriff")}
                onChange={(e) => setBegriff(e.target.value)}
                aria-label="Suchbegriff"
                placeholder="Name, Nummer …"
              />
            )}
          </label>
        ))}
        <div>
          <button type="submit" className="umschalter">
            <Search size={14} /> Suchen
          </button>
        </div>
      </fieldset>
      {funde && (
        <div className="fundliste">
          {funde.length === 0 && <p>Nichts gefunden.</p>}
          {funde.map((f, i) => (
            <label key={i} className="auswahl-zeile">
              <input type="checkbox" checked={f.an} onChange={(e) => setFunde(funde.map((x, j) => (j === i ? { ...x, an: e.target.checked } : x)))} />
              <span className="leise">S. {f.seite + 1}</span>
              <button type="button" className="link" onClick={() => springen(dokId, f.seite, f.rechteck)}>
                {f.text}
              </button>
            </label>
          ))}
          {funde.some((f) => f.an) && (
            <button
              type="button"
              className="umschalter"
              onClick={async () => {
                const auswahl = funde.filter((f) => f.an);
                if (await aenderungAnwenden(api.schwaerzenVormerken(dokId, auswahl))) {
                  setVorgemerkt(true);
                  setFunde(null);
                  melden(`${auswahl.length} Stelle(n) zum Schwärzen vorgemerkt.`);
                }
              }}
            >
              <Eraser size={14} /> {funde.filter((f) => f.an).length} Stelle(n) vormerken
            </button>
          )}
        </div>
      )}
      {(vorgemerkt || vorhanden) && (
        <fieldset className="feldgruppe warnung-rahmen">
          <legend>Endgültig schwärzen</legend>
          <label className="auswahl-zeile">
            <input type="checkbox" checked={metadaten} onChange={(e) => setMetadaten(e.target.checked)} /> Auch Metadaten (Autor, Titel …) entfernen
          </label>
          <button
            type="button"
            className="primaer"
            onClick={async () => {
              const r = await aenderungAnwenden(api.schwaerzenAnwenden(dokId, metadaten));
              if (r) {
                schliessen();
                melden(`Schwärzungen auf ${r.seiten?.length ?? 0} Seite(n) angewendet. Speichern nicht vergessen – Strg+Z macht es rückgängig.`);
              }
            }}
          >
            Schwärzungen anwenden
          </button>
        </fieldset>
      )}
      <div className="dialog-knoepfe">
        <button
          type="button"
          onClick={() => {
            schliessen();
            setzen({ werkzeug: "schwaerzen" });
          }}
        >
          Bereich von Hand markieren
        </button>
        <button type="button" onClick={schliessen}>
          Schließen
        </button>
      </div>
    </Rahmen>
  );
}

// ============================================================= Komprimieren
const STUFEN: [string, string, string][] = [
  ["gering", "Gering", "Bilder über 220 dpi auf 200 dpi – Druckqualität"],
  ["mittel", "Mittel", "150 dpi – gut lesbar, deutlich kleiner"],
  ["stark", "Stark", "100 dpi – für E-Mail-Anhänge"],
  ["maximal", "Maximal", "72 dpi – nur Bildschirm"],
];

export function KomprimierenDialog({ dokId }: { dokId: string }) {
  const [stufe, setStufe] = useState("mittel");
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<string | null>(null);
  return (
    <Rahmen
      titel="Komprimieren"
      icon={<FileArchive size={18} />}
      breit="breit"
      label="Komprimieren"
      onSubmit={async () => {
        setLaeuft(true);
        const r = await aenderungAnwenden(api.komprimieren(dokId, stufe));
        setLaeuft(false);
        if (r)
          setErgebnis(
            r.geaendert
              ? `${groesseText(r.vorher ?? 0)} → ${groesseText(r.nachher ?? 0)} (−${Math.round((1 - (r.nachher ?? 0) / Math.max(1, r.vorher ?? 1)) * 100)} %). Speichern nicht vergessen.`
              : `Keine nennenswerte Verkleinerung möglich (${groesseText(r.vorher ?? 0)}).`,
          );
      }}
    >
      <p>Bilder werden verkleinert, Schriften auf genutzte Zeichen reduziert. Text und Anmerkungen bleiben unverändert.</p>
      {STUFEN.map(([id, titel, text]) => (
        <label key={id} className="auswahl-zeile">
          <input type="radio" checked={stufe === id} onChange={() => setStufe(id)} /> <strong>{titel}</strong> <span className="leise">{text}</span>
        </label>
      ))}
      {ergebnis && <p className="erfolg">{ergebnis}</p>}
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          {ergebnis ? "Schließen" : "Abbrechen"}
        </button>
        <button type="submit" className="primaer" disabled={laeuft}>
          {laeuft ? "Komprimiere …" : "Komprimieren"}
        </button>
      </div>
    </Rahmen>
  );
}

// ============================================================ Eigenschaften
export function EigenschaftenDialog({ dokId }: { dokId: string }) {
  const [werte, setWerte] = useState<Record<string, string | number | null> | null>(null);
  const laden = () => api.eigenschaften(dokId).then(setWerte).catch(fehlerMelden);
  useEffect(() => {
    void laden();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dokId]);
  if (!werte) return null;
  const feld = (k: string, t: string) => (
    <label className="feld">
      {t}
      <input value={String(werte[k] ?? "")} onChange={(e) => setWerte({ ...werte, [k]: e.target.value })} />
    </label>
  );
  return (
    <Rahmen
      titel="Dokumenteigenschaften"
      icon={<Info size={18} />}
      breit="breit"
      label="Dokumenteigenschaften"
      onSubmit={async () => {
        const r = await aenderungAnwenden(
          api.eigenschaftenSetzen(dokId, {
            titel: String(werte.titel ?? ""),
            autor: String(werte.autor ?? ""),
            betreff: String(werte.betreff ?? ""),
            stichwoerter: String(werte.stichwoerter ?? ""),
          }),
        );
        if (r) schliessen();
      }}
    >
      {feld("titel", "Titel")}
      {feld("autor", "Autor")}
      {feld("betreff", "Betreff")}
      {feld("stichwoerter", "Stichwörter")}
      <dl className="infoliste">
        <dt>Datei</dt>
        <dd>{werte.pfad ?? "(noch nicht gespeichert)"}</dd>
        <dt>Größe</dt>
        <dd>{typeof werte.dateigroesse === "number" ? groesseText(werte.dateigroesse) : "–"}</dd>
        <dt>Seiten</dt>
        <dd>{werte.seiten}</dd>
        <dt>Erstellt mit</dt>
        <dd>{[werte.ersteller, werte.produzent].filter(Boolean).join(" · ") || "–"}</dd>
        <dt>Format</dt>
        <dd>{werte.pdf_version || "–"}</dd>
      </dl>
      <div className="dialog-knoepfe">
        <button
          type="button"
          onClick={async () => {
            if (await aenderungAnwenden(api.metadatenEntfernen(dokId))) {
              melden("Metadaten entfernt.");
              void laden();
            }
          }}
        >
          Metadaten entfernen
        </button>
        <span className="abstand" />
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer">
          Übernehmen
        </button>
      </div>
    </Rahmen>
  );
}

// ======================================================= Bild & Unterschrift
export function BildDialog({ unterschrift }: { dokId: string; unterschrift: boolean }) {
  const [bibliothek, setBibliothek] = useState<Unterschrift[]>([]);
  const [bild, setBild] = useState<BildDaten | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [freistellen, setFreistellen] = useState(unterschrift);
  const [staerke, setStaerke] = useState(50);
  const [speichern, setSpeichern] = useState(unterschrift);
  const [name, setName] = useState(holen().einstellungen?.kuerzel || "Unterschrift");
  const [laeuft, setLaeuft] = useState(false);
  const datei = useRef<Blob | null>(null);

  const bibliothekLaden = () => api.unterschriften().then(setBibliothek).catch(() => undefined);
  useEffect(() => {
    void bibliothekLaden();
  }, []);

  const hochladen = async (f: Blob, frei = freistellen) => {
    setLaeuft(true);
    datei.current = f;
    try {
      const r = await api.bildHochladen(f, frei, staerke);
      setBild(r);
      setOriginal(r.original_id ?? r.id);
    } catch (e) {
      fehlerMelden(e);
    }
    setLaeuft(false);
  };

  // Freistellung neu berechnen (verzögert beim Schieben)
  useEffect(() => {
    if (!original) return;
    const t = window.setTimeout(async () => {
      try {
        if (freistellen) setBild(await api.bildFreistellen(original, staerke));
        else if (datei.current) setBild(await api.bildHochladen(datei.current, false));
      } catch (e) {
        fehlerMelden(e);
      }
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freistellen, staerke]);

  const platzieren = async () => {
    if (!bild) return;
    let id: string | undefined;
    if (speichern) {
      try {
        id = (await api.unterschriftSpeichern(bild.id, name || "Unterschrift")).id;
      } catch (e) {
        fehlerMelden(e);
      }
    }
    platzierenStarten(unterschrift ? "unterschrift" : "bild", bild, id);
  };

  return (
    <Rahmen
      titel={unterschrift ? "Unterschrift einfügen" : "Bild einfügen"}
      icon={unterschrift ? <Signature size={18} /> : <ImagePlus size={18} />}
      breit="sehr-breit"
      label={unterschrift ? "Unterschrift einfügen" : "Bild einfügen"}
      onSubmit={() => void platzieren()}
    >
      {bibliothek.length > 0 && (
        <div className="bibliothek">
          <span className="leise">Gespeicherte {unterschrift ? "Unterschriften" : "Bilder & Unterschriften"} – anklicken zum Platzieren:</span>
          <div className="bibliothek-liste">
            {bibliothek.map((u) => (
              <div key={u.id} className="bibliothek-eintrag">
                <button type="button" className="schachbrett" onClick={() => platzierenStarten("unterschrift", u, u.id)} title={u.name}>
                  <img src={u.bild} alt={u.name} />
                  <span>{u.name}</span>
                </button>
                <button
                  type="button"
                  className="entfernen"
                  aria-label={`${u.name} löschen`}
                  onClick={async () => {
                    await api.unterschriftEntfernen(u.id);
                    void bibliothekLaden();
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        className="bild-ablage schachbrett"
        tabIndex={0}
        onPaste={(e) => {
          const f = e.clipboardData.files[0];
          if (f) {
            e.preventDefault();
            void hochladen(f);
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const f = e.dataTransfer.files[0];
          if (f) void hochladen(f);
        }}
      >
        {bild ? (
          <img src={bild.bild} alt="Vorschau" />
        ) : (
          <div className="leise">
            {laeuft ? "Wird geladen …" : "Bild hierher ziehen, mit Strg+V einfügen oder"}
            <br />
            <button
              type="button"
              className="umschalter"
              onClick={async () => {
                const f = await bildWaehlen();
                if (f) void hochladen(f);
              }}
            >
              <ImagePlus size={14} /> Datei wählen …
            </button>
          </div>
        )}
      </div>
      {bild && (
        <>
          <label className="auswahl-zeile">
            <input type="checkbox" checked={freistellen} onChange={(e) => setFreistellen(e.target.checked)} /> Weißen Hintergrund entfernen (freistellen)
          </label>
          {freistellen && (
            <label className="auswahl-zeile">
              Stärke
              <input type="range" min={0} max={100} value={staerke} onChange={(e) => setStaerke(Number(e.target.value))} aria-label="Stärke der Freistellung" />
              <span className="leise">{staerke < 40 ? "nur Weiß" : staerke > 70 ? "auch Grautöne" : "normal"}</span>
            </label>
          )}
          <label className="auswahl-zeile">
            <input type="checkbox" checked={speichern} onChange={(e) => setSpeichern(e.target.checked)} /> Für später speichern als
            <input className="zahl breit" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          </label>
          <button
            type="button"
            className="link"
            onClick={async () => {
              const f = await bildWaehlen();
              if (f) void hochladen(f);
            }}
          >
            Anderes Bild wählen …
          </button>
        </>
      )}
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer" disabled={!bild}>
          Platzieren
        </button>
      </div>
    </Rahmen>
  );
}

// ========================================================== Foto aufbereiten
type Punkt = [number, number];
type Rechteck = [number, number, number, number]; // x0, y0, x1, y1 (Anteile 0..1)
type Format = "a4hoch" | "a4quer" | "frei";
type Ziehen =
  | { art: "ecke"; anker: Punkt }
  | { art: "kante"; kante: 0 | 1 | 2 | 3 }
  | { art: "schieben"; start: Punkt; r: Rechteck }
  | { art: "punkt"; i: number };

const FORMATE: [Format, string][] = [
  ["a4hoch", "DIN A4 hoch"],
  ["a4quer", "DIN A4 quer"],
  ["frei", "Freies Format"],
];
const A4 = 210 / 297;
const MIN = 0.03;
const klemmen = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Seitenverhältnis Breite/Höhe des Ergebnisses (null = frei) – vor der Drehung gemessen */
function verhaeltnis(format: Format, drehung: number): number | null {
  if (format === "frei") return null;
  const r = format === "a4hoch" ? A4 : 1 / A4;
  return drehung % 180 ? 1 / r : r;
}

/** Rechteck auf das Seitenverhältnis bringen (umschließend), im Bild halten */
function passend(r: Rechteck, ziel: number | null, bb: number, bh: number): Rechteck {
  if (!ziel) return r;
  const cx = (r[0] + r[2]) / 2;
  const cy = (r[1] + r[3]) / 2;
  let w = r[2] - r[0];
  let h = r[3] - r[1];
  const hAusW = (w * bb) / (ziel * bh);
  if (hAusW >= h) h = hAusW;
  else w = (h * ziel * bh) / bb;
  if (w > 1) {
    h /= w;
    w = 1;
  }
  if (h > 1) {
    w /= h;
    h = 1;
  }
  const x0 = klemmen(cx - w / 2, 0, 1 - w);
  const y0 = klemmen(cy - h / 2, 0, 1 - h);
  return [x0, y0, x0 + w, y0 + h];
}

function umriss(ecken: Punkt[]): Rechteck {
  const xs = ecken.map((p) => p[0]);
  const ys = ecken.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const alsEcken = (r: Rechteck): Punkt[] => [
  [r[0], r[1]],
  [r[2], r[1]],
  [r[2], r[3]],
  [r[0], r[3]],
];

const GANZ: Rechteck = [0, 0, 1, 1];

/**
 * Seite, Screenshot oder Foto aufbereiten: zuschneiden (Rechteck, auf
 * Wunsch im DIN-A4-Format) oder frei transformieren (vier Ecken – rückt
 * schräg aufgenommene Blätter gerade), Licht & Schatten automatisch
 * ausgleichen, Farben erhalten. Danach läuft die Texterkennung.
 */
export function FotoDialog({ dokId, seite, bild }: { dokId: string | null; seite: number | null; bild?: BildDaten }) {
  const istFoto = seite === null && !bild;
  const [quelle, setQuelle] = useState<BildDaten | null>(null);
  const [form, setForm] = useState<"rechteck" | "frei">(istFoto ? "frei" : "rechteck");
  const [format, setFormat] = useState<Format>("a4hoch");
  const [rechteck, setRechteck] = useState<Rechteck>(GANZ);
  const [ecken, setEcken] = useState<Punkt[]>(alsEcken(GANZ));
  const [erkannt, setErkannt] = useState<Punkt[] | null>(null);
  const [ausgleich, setAusgleich] = useState(true);
  const [farbmodus, setFarbmodus] = useState<"farbig" | "grau" | "sw">("farbig");
  const [helligkeit, setHelligkeit] = useState(0);
  const [kontrast, setKontrast] = useState(0);
  const [drehung, setDrehung] = useState(0);
  const [ergebnis, setErgebnis] = useState<(BildDaten & { format: string }) | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [ziehe, setZiehe] = useState<Ziehen | null>(null);
  const flaeche = useRef<HTMLDivElement>(null);
  const dok = useZustand((z) => (dokId ? z.dokumente.find((d) => d.id === dokId) : undefined));

  const bb = quelle?.breite ?? 1;
  const bh = quelle?.hoehe ?? 1;
  const ziel = verhaeltnis(format, drehung);
  const filter = farbmodus === "sw" ? "sw" : farbmodus === "grau" ? (ausgleich ? "dokument" : "grau") : ausgleich ? "farbe" : "original";
  const zuschnitt = form === "rechteck" ? alsEcken(rechteck) : ecken;

  const laden = async (b: BildDaten) => {
    setQuelle(b);
    setErgebnis(null);
    let gefunden: Punkt[] | null = null;
    let inhalt: Rechteck | null = null;
    try {
      const r = await api.fotoEcken(b.id);
      if (r.gefunden) gefunden = r.ecken;
      inhalt = r.inhalt;
    } catch {
      /* ohne Erkennung weiter */
    }
    setErkannt(gefunden);
    if (istFoto) {
      setEcken(gefunden ?? alsEcken(GANZ));
      if (!gefunden) melden("Blattkanten nicht sicher erkannt – Ecken bitte von Hand setzen.");
      return;
    }
    // Rechteck: erkanntes Blatt bzw. Beleg im Screenshot (sonst fast ganzes Bild) im passenden A4-Format
    const basis = gefunden ? umriss(gefunden) : inhalt ?? ([0.02, 0.02, 0.98, 0.98] as Rechteck);
    const f: Format = (basis[2] - basis[0]) * b.breite > (basis[3] - basis[1]) * b.hoehe ? "a4quer" : "a4hoch";
    setFormat(f);
    setRechteck(passend(basis, verhaeltnis(f, 0), b.breite, b.hoehe));
  };

  useEffect(() => {
    if (bild) void laden(bild);
    else if (dokId !== null && seite !== null) api.seiteAlsBild(dokId, seite).then(laden).catch(fehlerMelden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dokId, seite, bild]);

  // Ergebnis-Vorschau (verzögert, nicht während des Ziehens)
  const zuschnittText = JSON.stringify(zuschnitt);
  useEffect(() => {
    if (!quelle || ziehe !== null) return;
    const t = window.setTimeout(() => {
      api
        .fotoEntzerren(quelle.id, JSON.parse(zuschnittText) as Punkt[], filter, drehung, helligkeit, kontrast)
        .then(setErgebnis)
        .catch(fehlerMelden);
    }, 300);
    return () => window.clearTimeout(t);
  }, [quelle, zuschnittText, filter, drehung, helligkeit, kontrast, ziehe]);

  const punktAus = (e: { clientX: number; clientY: number }): Punkt => {
    const r = flaeche.current!.getBoundingClientRect();
    return [klemmen((e.clientX - r.left) / r.width, 0, 1), klemmen((e.clientY - r.top) / r.height, 0, 1)];
  };

  useEffect(() => {
    if (ziehe === null) return;
    const bewegen = (e: MouseEvent) => {
      if (!flaeche.current) return;
      const [mx, my] = punktAus(e);
      if (ziehe.art === "punkt") {
        setEcken((alt) => alt.map((p, i) => (i === ziehe.i ? [mx, my] : p)));
        return;
      }
      if (ziehe.art === "schieben") {
        const [w, h] = [ziehe.r[2] - ziehe.r[0], ziehe.r[3] - ziehe.r[1]];
        const x0 = klemmen(ziehe.r[0] + mx - ziehe.start[0], 0, 1 - w);
        const y0 = klemmen(ziehe.r[1] + my - ziehe.start[1], 0, 1 - h);
        setRechteck([x0, y0, x0 + w, y0 + h]);
        return;
      }
      if (ziehe.art === "kante") {
        setRechteck((r) => {
          const n: Rechteck = [...r];
          if (ziehe.kante === 0) n[1] = Math.min(my, r[3] - MIN);
          if (ziehe.kante === 1) n[2] = Math.max(mx, r[0] + MIN);
          if (ziehe.kante === 2) n[3] = Math.max(my, r[1] + MIN);
          if (ziehe.kante === 3) n[0] = Math.min(mx, r[2] - MIN);
          return n;
        });
        return;
      }
      // Ecke: gegenüberliegende Ecke bleibt stehen
      const [ax, ay] = ziehe.anker;
      let w = Math.max(MIN, Math.abs(mx - ax));
      let h = Math.max(MIN, Math.abs(my - ay));
      if (ziel) {
        const hAusW = (w * bb) / (ziel * bh);
        if (hAusW >= h) h = hAusW;
        else w = (h * ziel * bh) / bb;
        const maxW = mx >= ax ? 1 - ax : ax;
        const maxH = my >= ay ? 1 - ay : ay;
        const s = Math.min(1, maxW / w, maxH / h);
        w *= s;
        h *= s;
      }
      const x0 = mx >= ax ? ax : ax - w;
      const y0 = my >= ay ? ay : ay - h;
      setRechteck([x0, y0, x0 + w, y0 + h]);
    };
    const los = () => setZiehe(null);
    window.addEventListener("mousemove", bewegen);
    window.addEventListener("mouseup", los);
    return () => {
      window.removeEventListener("mousemove", bewegen);
      window.removeEventListener("mouseup", los);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ziehe, ziel, bb, bh]);

  const formatWaehlen = (f: Format) => {
    setFormat(f);
    setRechteck((r) => passend(r, verhaeltnis(f, drehung), bb, bh));
  };
  const drehen = (um: number) => {
    const neu = (drehung + um + 360) % 360;
    setDrehung(neu);
    if (form === "rechteck") setRechteck((r) => passend(r, verhaeltnis(format, neu), bb, bh));
  };
  const formUmschalten = () => {
    if (form === "rechteck") {
      setEcken(alsEcken(rechteck));
      setForm("frei");
    } else {
      setRechteck(passend(umriss(ecken), ziel, bb, bh));
      setForm("rechteck");
    }
  };

  const fertig = async (aktion: "neu" | "einfuegen" | "ersetzen") => {
    if (!ergebnis) return;
    setLaeuft(true);
    try {
      if (aktion === "neu") {
        const r = await api.bildAlsDokument(ergebnis.id, (bild ? "Screenshot " : "Foto ") + new Date().toLocaleDateString("de-DE"));
        anwenden(r);
        const neu = r.neu[0];
        if (neu) void ocrStarten(neu.id, { erzwingen: false, ausrichten: true, entzerren: false });
      } else if (dokId) {
        const position = aktion === "ersetzen" && seite !== null ? seite : (seite ?? dok?.ansicht.seite ?? 0) + 1;
        const r = await api.bildEinsetzen(dokId, ergebnis.id, position, aktion === "ersetzen");
        anwenden(r, dokId);
        springen(dokId, position);
        void ocrStarten(dokId, { seiten: [position], erzwingen: false, ausrichten: true, entzerren: false });
      }
      schliessen();
    } catch (e) {
      fehlerMelden(e);
    }
    setLaeuft(false);
  };

  const titel = seite !== null ? `Seite ${seite + 1} zuschneiden & aufhellen` : bild ? "Screenshot zuschneiden & aufhellen" : "Foto aufbereiten";
  const [x0, y0, x1, y1] = rechteck;
  const pz = (v: number) => `${v * 100}%`;

  return (
    <Rahmen titel={titel} icon={istFoto ? <Camera size={18} /> : <Crop size={18} />} breit="sehr-breit" label={istFoto ? "Foto aufbereiten" : "Seite aufbereiten"}>
      {!quelle ? (
        istFoto ? (
          <div className="bild-ablage">
            <p>Abfotografiertes Dokument wählen – Kanten werden erkannt, das Blatt gerade gerückt und Schatten entfernt.</p>
            <button
              type="button"
              className="umschalter"
              onClick={async () => {
                const f = await bildWaehlen();
                if (!f) return;
                try {
                  await laden(await api.bildHochladen(f, false));
                } catch (e) {
                  fehlerMelden(e);
                }
              }}
            >
              <ImagePlus size={14} /> Foto wählen …
            </button>
          </div>
        ) : (
          <p className="leise">Seite wird vorbereitet …</p>
        )
      ) : (
        <>
          <div className="zuschnitt-leiste">
            {form === "rechteck" ? (
              <div className="segment" role="radiogroup" aria-label="Format">
                {FORMATE.map(([f, t]) => (
                  <button key={f} type="button" role="radio" aria-checked={format === f} className={format === f ? "an" : ""} onClick={() => formatWaehlen(f)}>
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <span className="leise">Ecken einzeln ziehen – schräge Blätter werden gerade gerückt.</span>
            )}
            <button type="button" className={`umschalter${form === "frei" ? " an" : ""}`} aria-pressed={form === "frei"} onClick={formUmschalten} title="Vier Ecken einzeln verschieben (Trapez ausgleichen)">
              <Spline size={14} /> Frei transformieren
            </button>
            {form === "frei" && erkannt && (
              <button type="button" className="umschalter" onClick={() => setEcken(erkannt)}>
                <ScanLine size={14} /> Blatt erkennen
              </button>
            )}
            <button
              type="button"
              className="umschalter"
              onClick={() => (form === "rechteck" ? setRechteck(passend(GANZ, ziel, bb, bh)) : setEcken(alsEcken(GANZ)))}
            >
              <Maximize size={14} /> Ganzes Bild
            </button>
            <span className="abstand" />
            <button type="button" className="umschalter" title="Links drehen" aria-label="Links drehen" onClick={() => drehen(270)}>
              <RotateCcw size={14} />
            </button>
            <button type="button" className="umschalter" title="Rechts drehen" aria-label="Rechts drehen" onClick={() => drehen(90)}>
              <RotateCw size={14} />
            </button>
          </div>
          <div className="foto-bereich">
            <div className="foto-quelle">
              <div
                ref={flaeche}
                className={`foto-flaeche ${form}`}
                onMouseDown={(e) => {
                  if (form !== "rechteck" || e.button !== 0) return;
                  e.preventDefault();
                  // neues Rechteck aufziehen
                  const p = punktAus(e);
                  setRechteck([p[0], p[1], p[0] + MIN, p[1] + MIN]);
                  setZiehe({ art: "ecke", anker: p });
                }}
              >
                <img src={quelle.bild} alt="Vorlage" draggable={false} />
                <svg viewBox="0 0 1000 1000" preserveAspectRatio="none">
                  <path
                    className="zuschnitt-abdunkeln"
                    fillRule="evenodd"
                    d={`M0 0H1000V1000H0Z M${zuschnitt.map(([x, y]) => `${x * 1000} ${y * 1000}`).join(" L")} Z`}
                  />
                  <polygon points={zuschnitt.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")} />
                  {form === "rechteck" &&
                    [1, 2].map((i) => (
                      <g key={i} className="zuschnitt-raster">
                        <line x1={(x0 + ((x1 - x0) * i) / 3) * 1000} x2={(x0 + ((x1 - x0) * i) / 3) * 1000} y1={y0 * 1000} y2={y1 * 1000} />
                        <line y1={(y0 + ((y1 - y0) * i) / 3) * 1000} y2={(y0 + ((y1 - y0) * i) / 3) * 1000} x1={x0 * 1000} x2={x1 * 1000} />
                      </g>
                    ))}
                </svg>
                {form === "rechteck" ? (
                  <>
                    <div
                      className="zuschnitt-rahmen"
                      style={{ left: pz(x0), top: pz(y0), width: pz(x1 - x0), height: pz(y1 - y0) }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setZiehe({ art: "schieben", start: punktAus(e), r: rechteck });
                      }}
                      aria-label="Zuschnitt verschieben"
                    />
                    {alsEcken(rechteck).map(([x, y], i) => (
                      <div
                        key={i}
                        className={`foto-ecke ecke-${i}`}
                        style={{ left: pz(x), top: pz(y) }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setZiehe({ art: "ecke", anker: alsEcken(rechteck)[(i + 2) % 4] });
                        }}
                        aria-label={`Ecke ${i + 1}`}
                      />
                    ))}
                    {!ziel &&
                      ([
                        [(x0 + x1) / 2, y0],
                        [x1, (y0 + y1) / 2],
                        [(x0 + x1) / 2, y1],
                        [x0, (y0 + y1) / 2],
                      ] as Punkt[]).map(([x, y], i) => (
                        <div
                          key={`k${i}`}
                          className={`foto-kante kante-${i}`}
                          style={{ left: pz(x), top: pz(y) }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setZiehe({ art: "kante", kante: i as 0 | 1 | 2 | 3 });
                          }}
                          aria-label={`Kante ${i + 1}`}
                        />
                      ))}
                  </>
                ) : (
                  ecken.map(([x, y], i) => (
                    <div
                      key={i}
                      className="foto-ecke"
                      style={{ left: pz(x), top: pz(y) }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setZiehe({ art: "punkt", i });
                      }}
                      aria-label={`Ecke ${i + 1}`}
                    />
                  ))
                )}
              </div>
              <span className="leise klein">
                {form === "rechteck"
                  ? "Rahmen verschieben, an den Ecken größer/kleiner ziehen oder neu aufziehen."
                  : "Ecken auf die Blattecken ziehen."}
              </span>
            </div>
            <div className="foto-ergebnis">{ergebnis ? <img src={ergebnis.bild} alt="Ergebnis" /> : <span className="leise">Vorschau wird berechnet …</span>}</div>
          </div>
          <div className="aufbereiten-optionen">
            <label className="schalter-zeile">
              <input type="checkbox" checked={ausgleich} disabled={farbmodus === "sw"} onChange={(e) => setAusgleich(e.target.checked)} />
              <Sun size={14} /> Licht & Schatten automatisch ausgleichen
            </label>
            <div className="segment" role="radiogroup" aria-label="Farbe">
              {(
                [
                  ["farbig", "Farbe"],
                  ["grau", "Graustufen"],
                  ["sw", "Schwarz-Weiß"],
                ] as const
              ).map(([m, t]) => (
                <button key={m} type="button" role="radio" aria-checked={farbmodus === m} className={farbmodus === m ? "an" : ""} onClick={() => setFarbmodus(m)}>
                  {t}
                </button>
              ))}
            </div>
            <label className="regler">
              Helligkeit
              <input type="range" min={-50} max={50} value={helligkeit} onChange={(e) => setHelligkeit(Number(e.target.value))} aria-label="Helligkeit" />
            </label>
            <label className="regler">
              Kontrast
              <input type="range" min={-50} max={50} value={kontrast} disabled={farbmodus === "sw"} onChange={(e) => setKontrast(Number(e.target.value))} aria-label="Kontrast" />
            </label>
            {(helligkeit !== 0 || kontrast !== 0) && (
              <button
                type="button"
                className="umschalter"
                onClick={() => {
                  setHelligkeit(0);
                  setKontrast(0);
                }}
              >
                Zurücksetzen
              </button>
            )}
          </div>
        </>
      )}
      <div className="dialog-knoepfe">
        {quelle && dokId && <span className="leise klein abstand-links">Die Texterkennung läuft danach automatisch.</span>}
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="button" disabled={!ergebnis || laeuft} onClick={() => void fertig("neu")}>
          Als neues Dokument
        </button>
        {dokId && seite === null && (
          <button type="button" className="primaer" disabled={!ergebnis || laeuft} onClick={() => void fertig("einfuegen")}>
            Als Seite einfügen
          </button>
        )}
        {dokId && seite !== null && (
          <button type="button" className="primaer" disabled={!ergebnis || laeuft} onClick={() => void fertig("ersetzen")}>
            Seite {seite + 1} ersetzen
          </button>
        )}
      </div>
    </Rahmen>
  );
}

// ============================================================ Stempel
export function StempelDialog() {
  const e = useZustand((z) => z.einstellungen);
  const [liste, setListe] = useState<StempelVorlage[]>(e?.stempel ?? []);
  return (
    <Rahmen
      titel="Stempel verwalten"
      icon={<Stamp size={18} />}
      breit="breit"
      label="Stempel verwalten"
      onSubmit={async () => {
        try {
          setzen({ einstellungen: await api.einstellungenSetzen({ stempel: liste.filter((s) => s.text.trim()) }), dialog: null });
        } catch (err) {
          fehlerMelden(err);
        }
      }}
    >
      <p className="leise">Platzhalter: {"{datum}"}, {"{zeit}"}, {"{kuerzel}"} (Kürzel aus den Einstellungen). Neue Zeile = Zeilenumbruch.</p>
      <div className="stempel-liste">
        {liste.map((s, i) => (
          <div key={i} className="stempel-zeile">
            <textarea
              value={s.text}
              rows={2}
              aria-label={`Stempeltext ${i + 1}`}
              onChange={(ev) => setListe(liste.map((x, j) => (j === i ? { ...x, text: ev.target.value } : x)))}
              style={{ color: s.farbe, borderColor: s.farbe }}
            />
            <input
              type="color"
              value={s.farbe}
              aria-label="Farbe"
              onChange={(ev) => setListe(liste.map((x, j) => (j === i ? { ...x, farbe: ev.target.value } : x)))}
            />
            <button type="button" aria-label="Stempel entfernen" onClick={() => setListe(liste.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="umschalter" onClick={() => setListe([...liste, { text: "NEU\n{datum}", farbe: "#C0262D" }])}>
        <Plus size={14} /> Stempel hinzufügen
      </button>
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

// ======================================================= Seiten als Bilder
export function BilderExportDialog({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const [bereich, setBereich] = useState<Bereich>("aktuell");
  const [eigene, setEigene] = useState("");
  const [format, setFormat] = useState("png");
  const [dpi, setDpi] = useState(200);
  const vorschlag = useMemo(() => (dok ? namensvorschlag(dok).replace(/\.pdf$/i, "") : "Seiten"), [dok]);
  if (!dok) return null;
  return (
    <Rahmen
      titel="Seiten als Bilder"
      icon={<FileImage size={18} />}
      breit="breit"
      label="Seiten als Bilder"
      onSubmit={async () => {
        const seiten = seitenErmitteln(dokId, bereich, eigene) ?? (bereich === "alle" ? [...Array(dok.seitenanzahl).keys()] : undefined);
        if (!seiten) return;
        const name = seiten.length === 1 ? `${vorschlag}_Seite${seiten[0] + 1}.${format}` : `${vorschlag}_Seiten.zip`;
        const ok = await ausgabeSpeichern(name, (pfad) => api.bilderExport(dokId, seiten, dpi, format, pfad));
        if (ok) schliessen();
      }}
    >
      <SeitenWahl dokId={dokId} bereich={bereich} setBereich={setBereich} eigene={eigene} setEigene={setEigene} />
      <label className="auswahl-zeile">
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="png">PNG (verlustfrei)</option>
          <option value="jpg">JPG (kleiner)</option>
        </select>
        Auflösung
        <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
          {[100, 150, 200, 300].map((d) => (
            <option key={d} value={d}>
              {d} dpi
            </option>
          ))}
        </select>
      </label>
      <span className="leise">Mehrere Seiten werden als ZIP-Datei gespeichert.</span>
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer">
          Speichern …
        </button>
      </div>
    </Rahmen>
  );
}

// ============================================================ Wasserzeichen
export function WasserzeichenDialog({ dokId }: { dokId: string }) {
  const [text, setText] = useState("KOPIE");
  const [farbe, setFarbe] = useState("#C0262D");
  const [deckkraft, setDeckkraft] = useState(20);
  const [winkel, setWinkel] = useState(45);
  const [bereich, setBereich] = useState<Bereich>("alle");
  const [eigene, setEigene] = useState("");
  return (
    <Rahmen
      titel="Wasserzeichen"
      icon={<Droplet size={18} />}
      breit="breit"
      label="Wasserzeichen"
      onSubmit={async () => {
        const seiten = seitenErmitteln(dokId, bereich, eigene);
        if (seiten === undefined) return;
        const r = await aenderungAnwenden(api.wasserzeichen(dokId, { text, farbe, deckkraft: deckkraft / 100, winkel, seiten }));
        if (r) {
          schliessen();
          melden(`Wasserzeichen auf ${r.anzahl} Seite(n) – Ebene „Wasserzeichen“ (ausblendbar). Strg+Z macht es rückgängig.`);
        }
      }}
    >
      <label className="feld">
        Text
        <input value={text} onChange={(e) => setText(e.target.value)} list="wz-vorschlaege" />
        <datalist id="wz-vorschlaege">
          {["KOPIE", "ENTWURF", "VERTRAULICH", "MUSTER", "ORIGINAL", "STORNIERT"].map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </label>
      <div className="auswahl-zeile">
        Farbe <input type="color" value={farbe} onChange={(e) => setFarbe(e.target.value)} aria-label="Farbe" />
        Deckkraft
        <input type="range" min={5} max={100} value={deckkraft} onChange={(e) => setDeckkraft(Number(e.target.value))} aria-label="Deckkraft" />
        <span className="leise">{deckkraft} %</span>
      </div>
      <div className="auswahl-zeile">
        Ausrichtung
        <select value={winkel} onChange={(e) => setWinkel(Number(e.target.value))} aria-label="Ausrichtung">
          <option value={45}>Diagonal</option>
          <option value={0}>Waagerecht</option>
          <option value={90}>Senkrecht</option>
        </select>
      </div>
      <div className="wz-vorschau" aria-hidden>
        <span style={{ color: farbe, opacity: deckkraft / 100, transform: `rotate(${-winkel}deg)` }}>{text}</span>
      </div>
      <SeitenWahl dokId={dokId} bereich={bereich} setBereich={setBereich} eigene={eigene} setEigene={setEigene} />
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer" disabled={!text.trim()}>
          Einfügen
        </button>
      </div>
    </Rahmen>
  );
}

// ========================================================= Kopf-/Fußzeile
const POSITIONEN = [
  ["oben_links", "Oben links"],
  ["oben_mitte", "Oben Mitte"],
  ["oben_rechts", "Oben rechts"],
  ["unten_links", "Unten links"],
  ["unten_mitte", "Unten Mitte"],
  ["unten_rechts", "Unten rechts"],
] as const;

export function KopfFussDialog({ dokId }: { dokId: string }) {
  const [felder, setFelder] = useState<Record<string, string>>({ unten_mitte: "Seite {seite} von {seiten}" });
  const [schriftgroesse, setSchriftgroesse] = useState(9);
  const [rand, setRand] = useState(10);
  const [ersteNummer, setErsteNummer] = useState(1);
  const [bereich, setBereich] = useState<Bereich>("alle");
  const [eigene, setEigene] = useState("");
  return (
    <Rahmen
      titel="Kopf- und Fußzeile, Seitenzahlen"
      icon={<PanelTop size={18} />}
      breit="sehr-breit"
      label="Kopf- und Fußzeile"
      onSubmit={async () => {
        const seiten = seitenErmitteln(dokId, bereich, eigene);
        if (seiten === undefined) return;
        const r = await aenderungAnwenden(api.kopfFuss(dokId, { felder, schriftgroesse, rand_mm: rand, erste_nummer: ersteNummer, seiten }));
        if (r) {
          schliessen();
          melden(`Kopf-/Fußzeile auf ${r.anzahl} Seite(n) – Ebene „Kopf- und Fußzeilen“. Strg+Z macht es rückgängig.`);
        }
      }}
    >
      <p className="leise">
        Platzhalter: {"{seite}"}, {"{seiten}"}, {"{datum}"}, {"{zeit}"}, {"{datei}"}
      </p>
      <div className="kf-raster">
        {POSITIONEN.map(([id, titel]) => (
          <label key={id} className="feld">
            {titel}
            <input value={felder[id] ?? ""} onChange={(e) => setFelder({ ...felder, [id]: e.target.value })} placeholder="–" />
          </label>
        ))}
      </div>
      <div className="auswahl-zeile">
        Schrift
        <select value={schriftgroesse} onChange={(e) => setSchriftgroesse(Number(e.target.value))} aria-label="Schriftgröße">
          {[7, 8, 9, 10, 11, 12, 14].map((g) => (
            <option key={g} value={g}>
              {g} pt
            </option>
          ))}
        </select>
        Abstand zum Rand
        <select value={rand} onChange={(e) => setRand(Number(e.target.value))} aria-label="Randabstand">
          {[5, 8, 10, 12, 15, 20].map((m) => (
            <option key={m} value={m}>
              {m} mm
            </option>
          ))}
        </select>
        Erste Seitenzahl
        <input className="zahl" type="number" min={0} value={ersteNummer} onChange={(e) => setErsteNummer(Number(e.target.value))} aria-label="Erste Seitenzahl" />
      </div>
      <SeitenWahl dokId={dokId} bereich={bereich} setBereich={setBereich} eigene={eigene} setEigene={setEigene} />
      <div className="dialog-knoepfe">
        <button type="button" onClick={schliessen}>
          Abbrechen
        </button>
        <button type="submit" className="primaer">
          Einfügen
        </button>
      </div>
    </Rahmen>
  );
}
