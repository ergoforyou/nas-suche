// Rechter Bereich „Eigenschaften“ (wie in PDF-XChange): zeigt zur
// ausgewählten Anmerkung Inhalt, Autor, Darstellung und Lage – sonst die
// Werkzeugeinstellungen bzw. Angaben zum Dokument.

import { Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Anmerkung, Stil } from "../typen";
import {
  anmerkungAendern,
  anmerkungenLoeschen,
  anmerkungFinden,
  ART_NAMEN,
  FARBEN,
  GRUPPEN_NAMEN,
  stilAendern,
  stilFuer,
} from "../zustand/anmerkungen";
import { aktivesDokument, setzen, useZustand } from "../zustand/store";

const WERKZEUG_NAMEN: Record<string, string> = {
  hand: "Hand",
  lassozoom: "Bereich zoomen",
  lupe: "Lupe",
  textbereich: "Text aus Bereich",
  textauswahl: "Text auswählen",
  platzieren: "Bild platzieren",
  schwaerzen: "Schwärzen",
  ...ART_NAMEN,
  schreibmaschine: "Text eintragen",
};

/** Welche Einstellungen eine Anmerkungsart hat */
const FELDER: Record<string, (keyof Stil)[]> = {
  hervorheben: ["farbe"],
  unterstreichen: ["farbe", "deckkraft"],
  durchstreichen: ["farbe", "deckkraft"],
  wellenlinie: ["farbe", "deckkraft"],
  notiz: ["farbe"],
  textfeld: ["farbe", "fuellung", "breite", "schriftgroesse"],
  schreibmaschine: ["farbe", "schriftgroesse"],
  rechteck: ["farbe", "fuellung", "breite", "deckkraft"],
  ellipse: ["farbe", "fuellung", "breite", "deckkraft"],
  linie: ["farbe", "breite", "deckkraft"],
  pfeil: ["farbe", "breite", "deckkraft"],
  freihand: ["farbe", "breite", "deckkraft"],
  stempel: ["schriftgroesse"],
  bild: ["deckkraft"],
  unterschrift: ["deckkraft"],
};

function Zeile({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <div className="eig-zeile">
      <span className="eig-titel">{titel}</span>
      <div className="eig-wert">{children}</div>
    </div>
  );
}

function Farbe({ wert, aendern, leer }: { wert: string | null; aendern: (f: string | null) => void; leer?: boolean }) {
  return (
    <div className="eig-farben">
      {leer && <button className={`farbe keine${wert === null ? " gewaehlt" : ""}`} title="Keine" aria-label="Keine" onClick={() => aendern(null)} />}
      {FARBEN.map((f) => (
        <button key={f} className={`farbe${wert?.toUpperCase() === f ? " gewaehlt" : ""}`} style={{ background: f }} aria-label={`Farbe ${f}`} onClick={() => aendern(f)} />
      ))}
      <input type="color" value={wert ?? "#ffffff"} aria-label="Farbe frei wählen" onChange={(e) => aendern(e.target.value.toUpperCase())} />
    </div>
  );
}

function Darstellung({ art, stil }: { art: string; stil: Stil }) {
  const felder = FELDER[art] ?? [];
  if (!felder.length) return null;
  return (
    <section className="eig-abschnitt">
      <h4>Darstellung</h4>
      {felder.includes("farbe") && (
        <Zeile titel={art === "schreibmaschine" || art === "textfeld" ? "Textfarbe" : "Farbe"}>
          <Farbe wert={stil.farbe} aendern={(f) => f && stilAendern({ farbe: f })} />
        </Zeile>
      )}
      {felder.includes("fuellung") && (
        <Zeile titel="Füllung">
          <Farbe wert={stil.fuellung} leer aendern={(f) => stilAendern({ fuellung: f })} />
        </Zeile>
      )}
      {felder.includes("breite") && (
        <Zeile titel="Linienbreite">
          <select value={stil.breite} onChange={(e) => stilAendern({ breite: Number(e.target.value) })} aria-label="Linienbreite">
            {[0, 0.5, 1, 1.5, 2, 3, 4, 6, 8].map((b) => (
              <option key={b} value={b}>
                {b === 0 ? "ohne" : `${String(b).replace(".", ",")} pt`}
              </option>
            ))}
          </select>
        </Zeile>
      )}
      {felder.includes("schriftgroesse") && (
        <Zeile titel="Schriftgröße">
          <select value={stil.schriftgroesse} onChange={(e) => stilAendern({ schriftgroesse: Number(e.target.value) })} aria-label="Schriftgröße">
            {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48].map((g) => (
              <option key={g} value={g}>
                {g} pt
              </option>
            ))}
          </select>
        </Zeile>
      )}
      {felder.includes("deckkraft") && (
        <Zeile titel="Deckkraft">
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(stil.deckkraft * 100)}
            onChange={(e) => stilAendern({ deckkraft: Number(e.target.value) / 100 })}
            aria-label="Deckkraft"
          />
          <span className="eig-zahl">{Math.round(stil.deckkraft * 100)} %</span>
        </Zeile>
      )}
    </section>
  );
}

function AnmerkungsEigenschaften({ dokId, anm }: { dokId: string; anm: Anmerkung }) {
  const [inhalt, setInhalt] = useState(anm.art === "schreibmaschine" || anm.art === "textfeld" ? anm.text ?? anm.inhalt : anm.inhalt);
  const [autor, setAutor] = useState(anm.autor);
  useEffect(() => {
    setInhalt(anm.art === "schreibmaschine" || anm.art === "textfeld" ? anm.text ?? anm.inhalt : anm.inhalt);
    setAutor(anm.autor);
  }, [anm.id, anm.v, anm.art, anm.text, anm.inhalt, anm.autor]);
  const istText = anm.art === "schreibmaschine" || anm.art === "textfeld" || anm.art === "stempel";
  const stil: Stil = {
    farbe: (anm.art === "schreibmaschine" ? anm.textfarbe : anm.farbe) ?? "#000000",
    fuellung: anm.fuellung,
    breite: anm.breite,
    deckkraft: anm.deckkraft,
    schriftgroesse: anm.schriftgroesse ?? 11,
  };
  const d = useZustand((z) => z.dokumente.find((x) => x.id === dokId));
  const s = d?.seiten[anm.seite];
  const mm = (anteil: number, pt: number) => `${Math.round(((anteil * pt) / 72) * 254) / 10} mm`;
  const speichern = (daten: Record<string, unknown>) => void anmerkungAendern(dokId, anm.seite, anm.id, daten);
  return (
    <>
      <section className="eig-abschnitt">
        <h4>{ART_NAMEN[anm.art] ?? anm.art}</h4>
        <Zeile titel="Gruppe">{GRUPPEN_NAMEN[anm.gruppe]}</Zeile>
        <Zeile titel="Seite">{anm.seite + 1}</Zeile>
        <Zeile titel="Autor">
          <input
            value={autor}
            onChange={(e) => setAutor(e.target.value)}
            onBlur={() => autor !== anm.autor && speichern({ autor })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Autor"
          />
        </Zeile>
        {anm.datum && <Zeile titel="Geändert">{new Date(anm.datum).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</Zeile>}
      </section>
      {anm.art !== "bild" && anm.art !== "unterschrift" && anm.art !== "schwaerzung" && (
        <section className="eig-abschnitt">
          <h4>{istText ? "Text" : "Kommentar"}</h4>
          <textarea
            className="eig-inhalt"
            value={inhalt}
            rows={istText ? 3 : 4}
            placeholder={istText ? "" : "Kommentar zu dieser Anmerkung …"}
            onChange={(e) => setInhalt(e.target.value)}
            onBlur={() => {
              const alt = istText ? anm.text ?? anm.inhalt : anm.inhalt;
              if (inhalt !== alt) speichern(istText ? { text: inhalt } : { inhalt });
            }}
            aria-label={istText ? "Text" : "Kommentar"}
          />
          {anm.text_darunter && <p className="leise klein">Markierter Text: „{anm.text_darunter}“</p>}
        </section>
      )}
      <Darstellung art={anm.art} stil={stil} />
      {s && (
        <section className="eig-abschnitt">
          <h4>Lage</h4>
          <Zeile titel="Links / Oben">
            {mm(anm.rechteck[0], s.breite)} / {mm(anm.rechteck[1], s.hoehe)}
          </Zeile>
          <Zeile titel="Breite × Höhe">
            {mm(anm.rechteck[2] - anm.rechteck[0], s.breite)} × {mm(anm.rechteck[3] - anm.rechteck[1], s.hoehe)}
          </Zeile>
          <p className="leise klein">Pfeiltasten verschieben um 1 pt, mit Umschalt um 10 pt.</p>
        </section>
      )}
      <div className="eig-knoepfe">
        <button className="umschalter" onClick={() => void anmerkungenLoeschen(dokId, [{ seite: anm.seite, id: anm.id }])}>
          <Trash2 size={14} /> Löschen
        </button>
      </div>
    </>
  );
}

export function EigenschaftenBereich() {
  const auswahl = useZustand((z) => z.anmAuswahl);
  useZustand((z) => (z.anmAuswahl ? z.anmerkungen[z.anmAuswahl.dokId] : null)); // neu zeichnen nach Änderungen
  useZustand((z) => z.stile);
  const editor = useZustand((z) => z.editor);
  const werkzeug = useZustand((z) => z.werkzeug);
  const dok = useZustand((z) => aktivesDokument(z));
  const anm = auswahl ? anmerkungFinden(auswahl.dokId, auswahl.seite, auswahl.id) : undefined;
  const werkzeugArt = editor?.art ?? werkzeug;

  return (
    <aside className="eigenschaften-bereich" aria-label="Eigenschaften">
      <div className="bereich-kopf">
        <span>Eigenschaften</span>
        <button aria-label="Eigenschaften schließen" title="Bereich schließen" onClick={() => setzen({ rechtsOffen: false })}>
          <X size={14} />
        </button>
      </div>
      <div className="eig-inhalt-bereich">
        {anm && auswahl ? (
          <AnmerkungsEigenschaften key={anm.id} dokId={auswahl.dokId} anm={anm} />
        ) : FELDER[werkzeugArt] ? (
          <>
            <section className="eig-abschnitt">
              <h4>Werkzeug: {WERKZEUG_NAMEN[werkzeugArt] ?? werkzeugArt}</h4>
              <p className="leise klein">Einstellungen gelten für die nächsten Eintragungen und werden gemerkt.</p>
            </section>
            <Darstellung art={werkzeugArt} stil={editor?.stil ?? stilFuer(werkzeugArt)} />
          </>
        ) : dok ? (
          <section className="eig-abschnitt">
            <h4>Dokument</h4>
            <Zeile titel="Datei">{dok.titel}</Zeile>
            {dok.pfad && (
              <Zeile titel="Ordner">
                <span className="eig-pfad" title={dok.pfad}>
                  {dok.pfad.replace(/[^\\/]+$/, "")}
                </span>
              </Zeile>
            )}
            <Zeile titel="Seiten">{dok.seitenanzahl}</Zeile>
            <Zeile titel="Schutz">{dok.schutz === "kennwort" ? "Kennwort" : dok.schutz === "rechte" ? "Rechte eingeschränkt" : "keiner"}</Zeile>
            <Zeile titel="Status">{dok.geaendert ? "Ungespeicherte Änderungen" : "Gespeichert"}</Zeile>
            <p className="leise klein">Anmerkung anklicken, um ihre Eigenschaften hier zu sehen und zu ändern.</p>
          </section>
        ) : (
          <p className="leise klein">Kein Dokument geöffnet.</p>
        )}
      </div>
    </aside>
  );
}
