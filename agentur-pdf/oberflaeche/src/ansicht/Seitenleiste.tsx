// Linke Seitenleiste: Miniaturen (Standard), Lesezeichen, Suche.

import { ChevronDown, ChevronRight, Files, Bookmark, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Miniaturen } from "./Miniaturen";
import { naechsterTreffer, suchen } from "../zustand/aktionen";
import { aktivesDokument, setzen, springen, useZustand } from "../zustand/store";
import type { Dokument, Lesezeichen, Seitenleistenpanel } from "../typen";

const PANELS: { id: Seitenleistenpanel; titel: string; icon: typeof Files }[] = [
  { id: "miniaturen", titel: "Seiten", icon: Files },
  { id: "lesezeichen", titel: "Lesezeichen", icon: Bookmark },
  { id: "suche", titel: "Suche", icon: Search },
];

export function Seitenleiste() {
  const leiste = useZustand((z) => z.seitenleiste);
  const dok = useZustand((z) => aktivesDokument(z));
  // Nebeneinander: jeder Bereich hat seine eigene Miniaturleiste
  const geteilt = useZustand((z) => z.bereiche.length > 1);
  const panels = geteilt ? PANELS.filter((p) => p.id !== "miniaturen") : PANELS;
  if (geteilt && leiste.panel === "miniaturen") return null;

  return (
    <aside className="seitenleiste" style={{ width: leiste.breite }} aria-label="Seitenleiste">
      <div className="seitenleiste-reiter" role="tablist">
        {panels.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={leiste.panel === p.id}
            className={leiste.panel === p.id ? "gewaehlt" : ""}
            onClick={() => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, panel: p.id } }))}
            title={p.titel}
          >
            <p.icon size={16} />
            <span>{p.titel}</span>
          </button>
        ))}
      </div>
      <div className="seitenleiste-inhalt">
        {leiste.panel === "miniaturen" && dok && <Miniaturen dok={dok} groesse={leiste.miniGroesse} />}
        {leiste.panel === "lesezeichen" && dok && <LesezeichenPanel dok={dok} />}
        {leiste.panel === "suche" && <SuchePanel />}
        {!dok && leiste.panel !== "suche" && <p className="leer-hinweis">Kein Dokument geöffnet.</p>}
      </div>
      {leiste.panel === "miniaturen" && dok && (
        <div className="seitenleiste-fuss">
          <label title="Größe der Miniaturen">
            <span>Größe</span>
            <input
              type="range"
              min={60}
              max={260}
              value={leiste.miniGroesse}
              onChange={(e) => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, miniGroesse: Number(e.target.value) } }))}
              onMouseUp={() => api.einstellungenSetzen({ miniatur_groesse: leiste.miniGroesse }).catch(() => undefined)}
            />
          </label>
        </div>
      )}
    </aside>
  );
}

// ----------------------------------------------------------- Lesezeichen
function LesezeichenPanel({ dok }: { dok: Dokument }) {
  const [liste, setListe] = useState<Lesezeichen[] | null>(null);
  const [zu, setZu] = useState<Set<number>>(new Set());
  useEffect(() => {
    setListe(null);
    api.lesezeichen(dok.id).then(setListe).catch(() => setListe([]));
  }, [dok.id, dok.version]);

  if (!liste) return <p className="leer-hinweis">Lade …</p>;
  if (!liste.length) return <p className="leer-hinweis">Dieses Dokument hat keine Lesezeichen.</p>;

  const hatKinder = (i: number) => liste[i + 1]?.ebene > liste[i].ebene;
  const sichtbar: number[] = [];
  let versteckenAb: number | null = null;
  liste.forEach((l, i) => {
    if (versteckenAb !== null && l.ebene > versteckenAb) return;
    versteckenAb = null;
    sichtbar.push(i);
    if (zu.has(i) && hatKinder(i)) versteckenAb = l.ebene;
  });

  return (
    <ul className="lesezeichen">
      {sichtbar.map((i) => {
        const l = liste[i];
        return (
          <li key={i} style={{ paddingLeft: (l.ebene - 1) * 14 }}>
            {hatKinder(i) ? (
              <button
                className="aufklappen"
                aria-label={zu.has(i) ? "Aufklappen" : "Zuklappen"}
                onClick={() =>
                  setZu((s) => {
                    const n = new Set(s);
                    if (n.has(i)) n.delete(i);
                    else n.add(i);
                    return n;
                  })
                }
              >
                {zu.has(i) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
            ) : (
              <span className="aufklappen-platz" />
            )}
            <button className={l.seite === dok.ansicht.seite ? "eintrag aktiv" : "eintrag"} onClick={() => springen(dok.id, l.seite)}>
              {l.titel}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ Suche
function SuchePanel() {
  const suche = useZustand((z) => z.suche);
  const dokumente = useZustand((z) => z.dokumente);
  const [eingabe, setEingabe] = useState(suche.begriff);
  const eingabeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    eingabeRef.current?.focus();
    eingabeRef.current?.select();
  }, []);

  const titel = (id: string) => dokumente.find((d) => d.id === id)?.titel ?? "";
  const mehrereDokumente = new Set(suche.treffer.map((t) => t.dokId)).size > 1;

  return (
    <div className="suche-panel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (eingabe.trim() === suche.begriff && suche.treffer.length) naechsterTreffer(1);
          else void suchen(eingabe);
        }}
      >
        <div className="suchfeld">
          <Search size={15} />
          <input
            ref={eingabeRef}
            id="suchfeld"
            value={eingabe}
            placeholder="Im Dokument suchen …"
            onChange={(e) => setEingabe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                naechsterTreffer(-1);
              }
            }}
          />
          {eingabe && (
            <button type="button" aria-label="Suche leeren" onClick={() => (setEingabe(""), void suchen(""))}>
              <X size={14} />
            </button>
          )}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={suche.alleDokumente}
            onChange={(e) => {
              setzen((z) => ({ suche: { ...z.suche, alleDokumente: e.target.checked } }));
              if (eingabe.trim()) void suchen(eingabe, e.target.checked);
            }}
          />
          In allen geöffneten Dokumenten
        </label>
      </form>
      <div className="suche-status">
        {suche.laeuft
          ? "Suche läuft …"
          : suche.begriff
            ? `${suche.treffer.length} Treffer${suche.treffer.length ? ` – ${suche.aktiv + 1} von ${suche.treffer.length}` : ""}`
            : "Enter = nächster Treffer, Umschalt+Enter = vorheriger"}
      </div>
      <ol className="trefferliste">
        {suche.treffer.map((t, i) => (
          <li key={i}>
            <button
              className={i === suche.aktiv ? "aktiv" : ""}
              onClick={() => {
                setzen((z) => ({ suche: { ...z.suche, aktiv: i } }));
                springen(t.dokId, t.seite, t.rechteck);
              }}
            >
              <span className="treffer-ort">
                {mehrereDokumente ? `${titel(t.dokId)} · ` : ""}Seite {t.seite + 1}
              </span>
              <span className="treffer-text">{hervorheben(t.ausschnitt, suche.begriff)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function hervorheben(text: string, begriff: string) {
  const i = text.toLowerCase().indexOf(begriff.toLowerCase());
  if (i < 0 || !begriff) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + begriff.length)}</mark>
      {text.slice(i + begriff.length)}
    </>
  );
}
