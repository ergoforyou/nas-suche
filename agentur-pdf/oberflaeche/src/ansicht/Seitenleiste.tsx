// Linke Seitenleiste: Miniaturen (Standard), Lesezeichen, Suche, Kommentare, Ebenen.

import { ChevronDown, ChevronRight, Files, Bookmark, Layers3, MessageSquare, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Miniaturen } from "./Miniaturen";
import { naechsterTreffer, suchen } from "../zustand/aktionen";
import { aktivesDokument, setzen, springen, useZustand } from "../zustand/store";
import type { Dokument, Ebene, Gruppe, Lesezeichen, Seitenleistenpanel } from "../typen";
import { ART_NAMEN, GRUPPEN_NAMEN, alleAnmerkungen, anmerkungenLoeschen, gruppeUmschalten } from "../zustand/anmerkungen";
import { anwenden } from "../zustand/seitenaktionen";

const PANELS: { id: Seitenleistenpanel; titel: string; icon: typeof Files }[] = [
  { id: "miniaturen", titel: "Seitenminiaturen", icon: Files },
  { id: "lesezeichen", titel: "Lesezeichen", icon: Bookmark },
  { id: "suche", titel: "Suche", icon: Search },
  { id: "kommentare", titel: "Kommentare", icon: MessageSquare },
  { id: "ebenen", titel: "Ebenen", icon: Layers3 },
];

/** Senkrechte Leiste ganz links: Bereiche ein-/ausblenden */
export function Panelleiste() {
  const leiste = useZustand((z) => z.seitenleiste);
  const geteilt = useZustand((z) => z.bereiche.length > 1);
  const anzahlKommentare = useZustand((z) => (z.aktiv ? Object.values(z.anmerkungen[z.aktiv]?.seiten ?? {}).reduce((n, l) => n + l.length, 0) : 0));
  const panels = geteilt ? PANELS.filter((p) => p.id !== "miniaturen") : PANELS;
  return (
    <nav className="panelleiste" aria-label="Bereiche">
      {panels.map((p) => {
        const an = leiste.offen && leiste.panel === p.id;
        return (
          <button
            key={p.id}
            className={an ? "gewaehlt" : ""}
            aria-pressed={an}
            title={p.titel}
            aria-label={p.titel}
            onClick={() => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, offen: !an, panel: p.id } }))}
          >
            <p.icon size={18} strokeWidth={1.7} />
            {p.id === "kommentare" && anzahlKommentare > 0 && <span className="panel-zahl">{anzahlKommentare}</span>}
          </button>
        );
      })}
    </nav>
  );
}

export function Seitenleiste() {
  const leiste = useZustand((z) => z.seitenleiste);
  const dok = useZustand((z) => aktivesDokument(z));
  // Nebeneinander: jeder Bereich hat seine eigene Miniaturleiste
  const geteilt = useZustand((z) => z.bereiche.length > 1);
  if (geteilt && leiste.panel === "miniaturen") return null;
  const titel = PANELS.find((p) => p.id === leiste.panel)?.titel ?? "";

  return (
    <aside className="seitenleiste" style={{ width: leiste.breite }} aria-label="Seitenleiste">
      <div className="bereich-kopf">
        <span>{titel}</span>
        <button aria-label="Bereich schließen" title="Bereich schließen" onClick={() => setzen((z) => ({ seitenleiste: { ...z.seitenleiste, offen: false } }))}>
          <X size={14} />
        </button>
      </div>
      <div className="seitenleiste-inhalt">
        {leiste.panel === "miniaturen" && dok && <Miniaturen dok={dok} groesse={leiste.miniGroesse} />}
        {leiste.panel === "lesezeichen" && dok && <LesezeichenPanel dok={dok} />}
        {leiste.panel === "suche" && <SuchePanel />}
        {leiste.panel === "kommentare" && dok && <KommentarPanel dok={dok} />}
        {leiste.panel === "ebenen" && dok && <EbenenPanel dok={dok} />}
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

// ------------------------------------------------------------ Kommentare
function KommentarPanel({ dok }: { dok: Dokument }) {
  useZustand((z) => z.anmerkungen[dok.id]);
  const auswahl = useZustand((z) => z.anmAuswahl);
  const [filter, setFilter] = useState<Gruppe | "alle">("alle");
  const liste = alleAnmerkungen(dok.id).filter((a) => filter === "alle" || a.gruppe === filter);
  return (
    <div className="kommentar-panel">
      <select value={filter} onChange={(e) => setFilter(e.target.value as Gruppe | "alle")} aria-label="Filter">
        <option value="alle">Alle Anmerkungen</option>
        {(Object.keys(GRUPPEN_NAMEN) as Gruppe[]).map((g) => (
          <option key={g} value={g}>
            {GRUPPEN_NAMEN[g]}
          </option>
        ))}
      </select>
      {!liste.length && <p className="leer-hinweis">Keine Anmerkungen. Werkzeuge unter „Kommentieren“ und „Bearbeiten“.</p>}
      <ul>
        {liste.map((a) => {
          const text = a.art === "schreibmaschine" || a.art === "textfeld" || a.art === "stempel" ? a.text ?? a.inhalt : a.inhalt || a.text_darunter || "";
          const gewaehlt = auswahl?.dokId === dok.id && auswahl.id === a.id;
          return (
            <li key={`${a.seite}-${a.id}`} className={gewaehlt ? "gewaehlt" : ""}>
              <button
                className="kommentar-eintrag"
                onClick={() => {
                  springen(dok.id, a.seite, a.rechteck);
                  setzen({ werkzeug: "hand", anmAuswahl: { dokId: dok.id, seite: a.seite, id: a.id } });
                }}
              >
                <span className="kommentar-kopf">
                  <span className={`kommentar-farbe gruppe-${a.gruppe}`} style={{ background: a.farbe ?? a.textfarbe ?? undefined }} />
                  <strong>{ART_NAMEN[a.art] ?? a.art}</strong>
                  <span className="leise">S. {a.seite + 1}</span>
                  <span className="abstand" />
                  <span className="leise">{a.autor}</span>
                </span>
                {text && <span className="kommentar-text">{text}</span>}
                {a.datum && <span className="leise klein">{new Date(a.datum).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>}
              </button>
              <button className="kommentar-loeschen" aria-label="Löschen" title="Löschen" onClick={() => void anmerkungenLoeschen(dok.id, [{ seite: a.seite, id: a.id }])}>
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Ebenen
function EbenenPanel({ dok }: { dok: Dokument }) {
  const ausblenden = useZustand((z) => z.ausblenden);
  const [ebenen, setEbenen] = useState<Ebene[] | null>(null);
  useEffect(() => {
    api.ebenen(dok.id).then(setEbenen).catch(() => setEbenen([]));
  }, [dok.id, dok.version]);
  return (
    <div className="ebenen-panel">
      <h3>Anmerkungen</h3>
      {(Object.keys(GRUPPEN_NAMEN) as Gruppe[]).map((g) => (
        <label key={g} className="auswahl-zeile">
          <input type="checkbox" checked={!ausblenden.includes(g)} onChange={() => gruppeUmschalten(g)} /> {GRUPPEN_NAMEN[g]}
        </label>
      ))}
      <p className="leise klein">Gilt nur für die Anzeige. Beim Drucken und Exportieren wird extra gefragt.</p>
      <h3>Ebenen im Dokument</h3>
      {ebenen === null && <p className="leer-hinweis">Lade …</p>}
      {ebenen?.length === 0 && <p className="leer-hinweis">Keine Ebenen. (Nach der Texterkennung gibt es die Ebene „OCR-Text“.)</p>}
      {ebenen?.map((e) => (
        <label key={e.id} className="auswahl-zeile">
          <input
            type="checkbox"
            checked={e.an}
            onChange={async (ev) => {
              try {
                anwenden(await api.ebeneSchalten(dok.id, e.id, ev.target.checked));
              } catch {
                /* Meldung nicht nötig – Liste lädt neu */
              }
            }}
          />{" "}
          {e.name || "(ohne Namen)"}
        </label>
      ))}
    </div>
  );
}
