// Startseite (kein Dokument offen): Öffnen, zuletzt geöffnet, Favoriten-Ordner.

import { ArrowUp, Clock, FileText, Folder, FolderOpen, Layers, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { oeffnenDialog, pfadOeffnen } from "../zustand/aktionen";
import { zusammenfuehrenOeffnen } from "../zustand/konvertieren";
import { melden, useZustand } from "../zustand/store";
import type { OrdnerInhalt, ZuletztEintrag } from "../typen";

function zeitText(iso: string): string {
  const d = new Date(iso);
  const heute = new Date();
  const gleicherTag = d.toDateString() === heute.toDateString();
  return gleicherTag
    ? `heute, ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function Startseite() {
  const desktop = useZustand((z) => z.desktop);
  const [zuletzt, setZuletzt] = useState<ZuletztEintrag[]>([]);
  const [favoriten, setFavoriten] = useState<string[]>([]);
  const [ordner, setOrdner] = useState<OrdnerInhalt | null>(null);
  const [neuerFavorit, setNeuerFavorit] = useState("");

  useEffect(() => {
    api.zuletzt().then(setZuletzt).catch(() => undefined);
    api.favoriten().then(setFavoriten).catch(() => undefined);
  }, []);

  const ordnerOeffnen = (pfad: string) =>
    api
      .ordner(pfad)
      .then(setOrdner)
      .catch((e) => melden(e.message, "fehler"));

  const favoritHinzufuegen = async () => {
    const pfad = neuerFavorit.trim().replace(/^"|"$/g, "");
    if (!pfad) return;
    try {
      await api.ordner(pfad); // prüfen, ob es den Ordner gibt
      setFavoriten(await api.favoritenSetzen([...favoriten, pfad]));
      setNeuerFavorit("");
    } catch (e) {
      melden((e as Error).message, "fehler");
    }
  };

  return (
    <div className="startseite">
      <section className="start-kopf">
        <h1>Ergo4You PDF</h1>
        <p>Datei öffnen oder hierher ziehen – PDF, Scans, Bilder, Word, Excel und E-Mails.</p>
        <div className="start-knoepfe">
          <button className="primaer gross" onClick={() => void oeffnenDialog()}>
            <FolderOpen size={20} /> Datei öffnen …
          </button>
          <button className="zweitrangig gross" onClick={() => zusammenfuehrenOeffnen([])}>
            <Layers size={20} /> Dateien zusammenführen …
          </button>
        </div>
        <p className="hinweis">
          Tipp: <kbd>Strg</kbd>+<kbd>K</kbd> findet jede Funktion per Stichwort.
        </p>
      </section>

      <div className="start-spalten">
        <section className="karte">
          <h2>
            <Clock size={16} /> Zuletzt geöffnet
          </h2>
          {!zuletzt.length && <p className="leer-hinweis">Noch keine Dateien geöffnet.</p>}
          <ul className="dateiliste">
            {zuletzt.map((z) => (
              <li key={z.pfad} className={z.vorhanden ? "" : "fehlt"}>
                <button
                  className="datei"
                  disabled={!z.vorhanden}
                  onClick={() => void pfadOeffnen(z.pfad)}
                  title={z.vorhanden ? z.pfad : `Nicht mehr vorhanden: ${z.pfad}`}
                >
                  <FileText size={18} />
                  <span className="datei-name">{z.titel}</span>
                  <span className="datei-info">
                    {z.vorhanden ? `${z.seiten} S. · ${zeitText(z.zeit)}` : "nicht gefunden"}
                  </span>
                </button>
                <button
                  className="symbol"
                  aria-label="Aus Liste entfernen"
                  title="Aus Liste entfernen"
                  onClick={async () => {
                    await api.zuletztEntfernen(z.pfad);
                    setZuletzt((l) => l.filter((x) => x.pfad !== z.pfad));
                  }}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="karte">
          <h2>
            <Star size={16} /> Favoriten-Ordner
          </h2>
          {ordner ? (
            <>
              <div className="ordner-kopf">
                <button className="symbol" aria-label="Übergeordneter Ordner" onClick={() => ordnerOeffnen(ordner.eltern)}>
                  <ArrowUp size={16} />
                </button>
                <span className="ordner-pfad" title={ordner.pfad}>
                  {ordner.pfad}
                </span>
                <button className="symbol" aria-label="Ordneransicht schließen" onClick={() => setOrdner(null)}>
                  <X size={16} />
                </button>
              </div>
              <ul className="dateiliste">
                {ordner.ordner.map((o) => (
                  <li key={o.pfad}>
                    <button className="datei" onClick={() => ordnerOeffnen(o.pfad)}>
                      <Folder size={18} />
                      <span className="datei-name">{o.name}</span>
                    </button>
                  </li>
                ))}
                {ordner.dateien.map((d) => (
                  <li key={d.pfad}>
                    <button className="datei" onClick={() => void pfadOeffnen(d.pfad)}>
                      <FileText size={18} />
                      <span className="datei-name">{d.name}</span>
                      <span className="datei-info">{new Date(d.geaendert * 1000).toLocaleDateString("de-DE")}</span>
                    </button>
                  </li>
                ))}
                {!ordner.ordner.length && !ordner.dateien.length && <p className="leer-hinweis">Ordner ist leer.</p>}
              </ul>
            </>
          ) : (
            <>
              <ul className="dateiliste">
                {favoriten.map((f) => (
                  <li key={f}>
                    <button className="datei" onClick={() => ordnerOeffnen(f)} title={f}>
                      <Folder size={18} />
                      <span className="datei-name">{f.split(/[\\/]/).filter(Boolean).pop() ?? f}</span>
                      <span className="datei-info">{f}</span>
                    </button>
                    <button
                      className="symbol"
                      aria-label="Favorit entfernen"
                      title="Favorit entfernen"
                      onClick={async () => setFavoriten(await api.favoritenSetzen(favoriten.filter((x) => x !== f)))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <form
                className="favorit-neu"
                onSubmit={(e) => {
                  e.preventDefault();
                  void favoritHinzufuegen();
                }}
              >
                <input
                  value={neuerFavorit}
                  onChange={(e) => setNeuerFavorit(e.target.value)}
                  placeholder={desktop ? "Ordnerpfad, z. B. Z:\\Scans" : "Ordnerpfad auf diesem PC"}
                  aria-label="Ordnerpfad"
                />
                <button type="submit" title="Als Favorit hinzufügen">
                  <Plus size={16} /> Hinzufügen
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
