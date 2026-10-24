// Online-Unterschrift über „Ergoforyou Sign“ auf dem NAS: Senden-Dialog
// (Vorschau der Felder, eine Person je Rolle, HubSpot-Kontakt, Zugangscode,
// Links), Übersicht und Verbindung in den Einstellungen.

import {
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileSignature,
  Link2,
  ListOrdered,
  Lock,
  Mail,
  MessageCircle,
  PenLine,
  RefreshCw,
  Search,
  Unlock,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, bildUrl, mitToken } from "../api";
import type { HubSpotKontakt, SignaturAuftrag, SignaturFeld, SignaturPerson, SignaturStatus, SignaturStatusWert } from "../typen";
import { dokumentHinzufuegen, holen, melden, setzen, useZustand } from "../zustand/store";

const zu = () => setzen({ dialog: null });

function fehlerText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const STATUS_TEXT: Record<SignaturStatusWert, string> = {
  offen: "Versendet",
  geoeffnet: "Geöffnet",
  teilweise: "Teilweise unterschrieben",
  unterschrieben: "Unterschrieben",
  abgelaufen: "Abgelaufen",
  widerrufen: "Zurückgezogen",
};

/** Farben der Rollen – in Vorschau, Formular-Editor und Übersicht gleich */
export const ROLLEN_FARBEN = ["#B5121B", "#1E4FA8", "#1F7A3A", "#C27C00", "#6B3FA0", "#0E7C86", "#8A5A00", "#555555"];
/** Vorschläge für die Rolle eines Unterschriftsfelds */
export const ROLLEN_VORSCHLAEGE = ["Kunde", "Ehepartner", "Mitversicherte Person", "Kontoinhaber", "Makler"];

function datum(iso: string, mitZeit = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  return mitZeit
    ? d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

async function kopieren(text: string, was: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    melden(`${was} kopiert.`);
  } catch {
    melden("Kopieren nicht möglich – bitte markieren und Strg+C.", "fehler");
  }
}

async function extern(url: string): Promise<void> {
  try {
    if (holen().desktop) await api.linkOeffnen(url);
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    melden(fehlerText(e), "fehler");
  }
}

function emailText(a: SignaturAuftrag, p: SignaturPerson, mitCode: boolean): string {
  const anrede = p.name ? `Hallo ${p.name},` : "Hallo,";
  const andere = a.personen.length > 1 ? ` Das Dokument unterschreiben insgesamt ${a.personen.length} Personen – jede mit eigenem Link.` : "";
  return [
    anrede,
    "",
    `bitte unterschreiben Sie „${a.titel}“ online über diesen persönlichen Link:`,
    p.link ?? "",
    "",
    `Der Link ist gültig bis ${datum(a.gueltig_bis, false)}.${andere} Sobald alle unterschrieben haben, können Sie sich über denselben Link die fertige PDF herunterladen.`,
    ...(mitCode ? ["Den Zugangscode erhalten Sie separat von uns."] : []),
    "",
    "Viele Grüße",
    "Ihr Ergoforyou-Team",
  ].join("\n");
}

function zufallsCode(): string {
  const z = new Uint32Array(1);
  crypto.getRandomValues(z);
  return String(100000 + (z[0] % 900000));
}

function whatsapp(telefon: string, text: string): string {
  const nummer = telefon.replace(/[^\d+]/g, "").replace(/^00/, "+").replace(/^0/, "+49").replace(/^\+/, "");
  return `https://wa.me/${nummer}?text=${encodeURIComponent(text)}`;
}

// ------------------------------------------------------------ Verbindung
function VerbindenFeld({ fertig }: { fertig: (s: SignaturStatus) => void }) {
  const [code, setCode] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  return (
    <div className="sig-verbinden">
      <label className="feld">
        Verbindungscode von der Einrichtungsseite des NAS (http://&lt;NAS&gt;:8481)
        <textarea rows={2} value={code} onChange={(e) => setCode(e.target.value)} placeholder="EFY-SIGN:…" spellCheck={false} aria-label="Verbindungscode" />
      </label>
      <button
        type="button"
        className="umschalter"
        disabled={laeuft || !code.trim()}
        onClick={async () => {
          setLaeuft(true);
          try {
            const s = await api.signaturVerbinden(code);
            const e = await api.einstellungen();
            setzen({ einstellungen: e });
            melden("Mit Ergoforyou Sign verbunden.");
            fertig(s);
          } catch (e) {
            melden(fehlerText(e), "fehler");
          } finally {
            setLaeuft(false);
          }
        }}
      >
        <Link2 size={14} /> {laeuft ? "Verbinde …" : "Verbinden"}
      </button>
    </div>
  );
}

export function SignaturBereich() {
  const [s, setS] = useState<SignaturStatus | null>(null);
  useEffect(() => {
    api.signaturStatus().then(setS).catch(() => undefined);
  }, []);
  return (
    <fieldset className="gruppe">
      <legend>
        <FileSignature size={13} /> Online-Unterschrift (Ergoforyou Sign)
      </legend>
      <p className="leise">
        Dokumente per Link online unterschreiben lassen – der Dienst läuft auf dem NAS, unterschriebene PDFs landen dort und in HubSpot. Ist der gemeinsame
        Ordner eingerichtet, gilt die Verbindung für alle PCs.
      </p>
      {s?.eingerichtet ? (
        <>
          <p className={s.erreichbar ? "leise" : "warnung"}>
            {s.erreichbar
              ? `Verbunden mit ${s.url} · HubSpot ${s.hubspot ? "verbunden" : "nicht verbunden"} · ${s.oeffentliche_adresse ? `Kundenseite ${s.oeffentliche_adresse}` : "öffentliche Adresse fehlt noch"}`
              : s.fehler}
          </p>
          <div className="auswahl-zeile">
            <button
              type="button"
              className="umschalter"
              onClick={async () => {
                setS(await api.signaturTrennen());
                setzen({ einstellungen: await api.einstellungen() });
              }}
            >
              Verbindung trennen
            </button>
          </div>
        </>
      ) : (
        s && <VerbindenFeld fertig={setS} />
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------- Kontaktsuche
function KontaktSuche({ wert, aendern, label }: { wert: HubSpotKontakt | null; aendern: (k: HubSpotKontakt | null) => void; label: string }) {
  const [suche, setSuche] = useState("");
  const [treffer, setTreffer] = useState<HubSpotKontakt[]>([]);
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState("");
  useEffect(() => {
    if (wert || suche.trim().length < 2) {
      setTreffer([]);
      return;
    }
    const abbruch = new AbortController();
    const t = setTimeout(async () => {
      setLaeuft(true);
      try {
        setTreffer((await api.signaturKontakte(suche.trim(), abbruch.signal)).kontakte);
        setFehler("");
      } catch (e) {
        if (!abbruch.signal.aborted) setFehler(fehlerText(e));
      } finally {
        setLaeuft(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      abbruch.abort();
    };
  }, [suche, wert]);

  if (wert) {
    return (
      <div className="sig-kontakt">
        <span>
          <strong>{wert.name}</strong>
          <small>{[wert.email, wert.firma, wert.telefon].filter(Boolean).join(" · ")}</small>
        </span>
        <button type="button" className="symbol" onClick={() => aendern(null)} aria-label="Anderen Kontakt wählen" title="Anderen Kontakt wählen">
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="sig-suche">
      <span className="sig-suchfeld">
        <Search size={14} />
        <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="In HubSpot suchen (optional) …" aria-label={label} />
      </span>
      {laeuft && <p className="leise klein">Suche …</p>}
      {fehler && <p className="warnung">{fehler}</p>}
      {treffer.length > 0 && (
        <ul className="sig-treffer" role="listbox" aria-label="HubSpot-Kontakte">
          {treffer.map((k) => (
            <li key={k.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => aendern(k)}>
                <strong>{k.name}</strong>
                <small>{[k.email, k.firma].filter(Boolean).join(" · ")}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!laeuft && !fehler && suche.trim().length >= 2 && treffer.length === 0 && <p className="leise klein">Kein Kontakt gefunden.</p>}
    </div>
  );
}

// ------------------------------------------------------------- Vorschau
function FeldVorschau({ dokId, felder, rollen }: { dokId: string; felder: SignaturFeld[]; rollen: string[] }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  if (!dok) return null;
  const seiten = [...new Set(felder.map((f) => f.seite))].sort((a, b) => a - b);
  if (!seiten.length) {
    return (
      <div className="sig-vorschau leer">
        <p className="hinweis-box">
          Kein Unterschriftsfeld im Dokument – der Kunde unterschreibt dann nur auf dem Prüfprotokoll. Besser: Feld dort aufziehen, wo unterschrieben werden
          soll.
        </p>
        <button
          type="button"
          className="umschalter"
          onClick={() => {
            setzen({ dialog: null, werkzeug: "formular", formularTyp: "unterschrift", anmAuswahl: null, rechtsOffen: true });
            melden("Unterschriftsfeld aufziehen – danach wieder „Zur Unterschrift senden“.");
          }}
        >
          <PenLine size={14} /> Unterschriftsfeld jetzt setzen
        </button>
      </div>
    );
  }
  return (
    <div className="sig-vorschau" aria-label="Vorschau der Unterschriftsfelder">
      {seiten.map((s) => {
        const info = dok.seiten[s];
        const verhaeltnis = info ? info.breite / info.hoehe : 0.707;
        return (
          <figure key={s} className="sig-vorschau-seite">
            <div className="sig-vorschau-blatt" style={{ aspectRatio: String(verhaeltnis) }}>
              <img src={mitToken(bildUrl({ dokId, seite: s, kennung: dok.kennungen[s], skala: 0.4, drehung: 0 }))} alt={`Seite ${s + 1}`} />
              {felder
                .filter((f) => f.seite === s)
                .map((f, i) => {
                  const farbe = ROLLEN_FARBEN[Math.max(0, rollen.indexOf(f.rolle)) % ROLLEN_FARBEN.length];
                  const [x0, y0, x1, y1] = f.rechteck;
                  return (
                    <span
                      key={i}
                      className="sig-vorschau-feld"
                      title={f.name}
                      style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%`, borderColor: farbe, background: `${farbe}22`, color: farbe }}
                    >
                      {f.rolle}
                    </span>
                  );
                })}
            </div>
            <figcaption>Seite {s + 1}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------- Senden
interface PersonEingabe {
  name: string;
  kontakt: HubSpotKontakt | null;
  mitCode: boolean;
  code: string;
}

const LEER: PersonEingabe = { name: "", kontakt: null, mitCode: false, code: "" };

export function SignaturSendenDialog({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const [status, setStatus] = useState<SignaturStatus | null>(null);
  const [felder, setFelder] = useState<SignaturFeld[] | null>(null);
  const [rollen, setRollen] = useState<string[]>(["Kunde"]);
  const [titel, setTitel] = useState(() => (dok?.titel ?? "").replace(/\.pdf$/i, ""));
  const [personen, setPersonen] = useState<Record<string, PersonEingabe>>({});
  const [reihenfolge, setReihenfolge] = useState(false);
  const [deals, setDeals] = useState<{ id: string; name: string }[]>([]);
  const [deal, setDeal] = useState("");
  const [tage, setTage] = useState(14);
  const [nachricht, setNachricht] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<SignaturAuftrag | null>(null);

  useEffect(() => {
    api.signaturStatus().then(setStatus).catch((e) => setStatus({ eingerichtet: false, fehler: fehlerText(e) }));
    api
      .signaturFelder(dokId)
      .then((r) => {
        setFelder(r.felder);
        setRollen(r.rollen.length ? r.rollen : ["Kunde"]);
      })
      .catch(() => setFelder([]));
  }, [dokId]);

  const person = (rolle: string): PersonEingabe => personen[rolle] ?? LEER;
  const aendern = (rolle: string, neu: Partial<PersonEingabe>) => setPersonen((alt) => ({ ...alt, [rolle]: { ...(alt[rolle] ?? LEER), ...neu } }));

  // Deals des ersten Kontakts (Kunde) zur Auswahl
  const hauptKontakt = rollen.map((r) => personen[r]?.kontakt).find(Boolean) ?? null;
  useEffect(() => {
    setDeal("");
    setDeals([]);
    if (!hauptKontakt) return;
    api
      .signaturDeals(hauptKontakt.id)
      .then((r) => {
        setDeals(r.deals);
        if (r.deals.length === 1) setDeal(r.deals[0].id);
      })
      .catch(() => undefined);
  }, [hauptKontakt?.id]);

  const fehlend = useMemo(() => rollen.filter((r) => !person(r).name.trim() && !person(r).kontakt), [rollen, personen]);

  if (!dok) return null;
  const bereit = status?.eingerichtet && status.erreichbar;
  const mehrere = rollen.length > 1;

  const senden = async () => {
    for (const r of rollen) {
      const p = person(r);
      if (p.mitCode && p.code.trim().length < 4) {
        melden(`Der Zugangscode für „${r}“ braucht mindestens 4 Zeichen.`, "fehler");
        return;
      }
    }
    setLaeuft(true);
    try {
      const a = await api.signaturSenden(dokId, {
        titel: titel.trim(),
        kontakt: hauptKontakt,
        deal_id: deal,
        personen: rollen.map((r) => {
          const p = person(r);
          return {
            rolle: r,
            name: p.name.trim() || p.kontakt?.name || "",
            email: p.kontakt?.email ?? "",
            telefon: p.kontakt?.telefon ?? "",
            code: p.mitCode ? p.code.trim() : "",
            hubspot_kontakt_id: p.kontakt?.id ?? "",
          };
        }),
        reihenfolge: mehrere && reihenfolge,
        gueltig_tage: tage,
        nachricht: nachricht.trim(),
      });
      setErgebnis(a);
      if (a.personen.length === 1 && a.personen[0].link) void navigator.clipboard?.writeText(a.personen[0].link).catch(() => undefined);
    } catch (e) {
      melden(fehlerText(e), "fehler");
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="dialog-hintergrund" onMouseDown={zu}>
      <form
        className={`dialog sig-dialog${bereit && !ergebnis ? " sig-mit-vorschau" : ""}`}
        role="dialog"
        aria-label="Zur Unterschrift senden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && zu()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ergebnis) void senden();
        }}
      >
        <h2>
          <FileSignature size={18} /> Zur Unterschrift senden
        </h2>
        {!status && <p className="leise">Verbindung wird geprüft …</p>}
        {status && !status.eingerichtet && (
          <>
            <p className="leise">Einmalig mit „Ergoforyou Sign“ auf dem NAS verbinden:</p>
            <VerbindenFeld fertig={setStatus} />
          </>
        )}
        {status?.eingerichtet && !status.erreichbar && <p className="warnung">{status.fehler}</p>}
        {bereit && !status.oeffentliche_adresse && (
          <p className="warnung">Auf dem NAS ist noch keine öffentliche Adresse eingetragen – Kunden könnten den Link nicht öffnen.</p>
        )}

        {bereit && !ergebnis && (
          <div className="sig-spalten">
            {felder ? <FeldVorschau dokId={dokId} felder={felder} rollen={rollen} /> : <div className="sig-vorschau leise">Vorschau lädt …</div>}
            <div className="sig-formular">
              <label className="feld">
                Titel (sieht der Kunde)
                <input value={titel} onChange={(e) => setTitel(e.target.value)} aria-label="Titel" />
              </label>
              {rollen.map((r, i) => {
                const p = person(r);
                const farbe = ROLLEN_FARBEN[i % ROLLEN_FARBEN.length];
                return (
                  <fieldset key={r} className="sig-person" style={{ borderLeftColor: farbe }} aria-label={`Unterzeichner ${r}`}>
                    <legend style={{ color: farbe }}>
                      {mehrere && reihenfolge ? `${i + 1}. ` : ""}
                      {r}
                    </legend>
                    {status.hubspot && (
                      <KontaktSuche
                        wert={p.kontakt}
                        label={`HubSpot-Kontakt ${r}`}
                        aendern={(k) => aendern(r, { kontakt: k, name: k && !p.name.trim() ? k.name : p.name })}
                      />
                    )}
                    <input value={p.name} onChange={(e) => aendern(r, { name: e.target.value })} placeholder="Name, z. B. Max Muster" aria-label={`Name ${r}`} />
                    <div className="sig-zeile">
                      <label className="auswahl-zeile">
                        <input
                          type="checkbox"
                          checked={p.mitCode}
                          onChange={(e) => aendern(r, { mitCode: e.target.checked, code: e.target.checked && !p.code ? zufallsCode() : p.code })}
                          aria-label={`Zugangscode ${r} verlangen`}
                        />
                        Zugangscode
                      </label>
                      {p.mitCode && <input className="zahl breit" value={p.code} onChange={(e) => aendern(r, { code: e.target.value })} aria-label={`Zugangscode ${r}`} maxLength={32} />}
                    </div>
                  </fieldset>
                );
              })}
              {mehrere && (
                <label className="auswahl-zeile">
                  <input type="checkbox" checked={reihenfolge} onChange={(e) => setReihenfolge(e.target.checked)} />
                  <ListOrdered size={14} /> Der Reihe nach unterschreiben (wie oben aufgeführt)
                </label>
              )}
              {!status.hubspot && <p className="leise klein">HubSpot ist auf dem NAS noch nicht verbunden – das Ergebnis wird nur auf dem NAS abgelegt.</p>}
              {hauptKontakt && deals.length > 0 && (
                <label className="feld">
                  Deal in HubSpot (optional)
                  <select value={deal} onChange={(e) => setDeal(e.target.value)} aria-label="Deal">
                    <option value="">– nur an den Kontakten ablegen –</option>
                    {deals.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="sig-zeile">
                <label className="feld">
                  Link gültig
                  <select value={tage} onChange={(e) => setTage(Number(e.target.value))} aria-label="Gültigkeit">
                    {[3, 7, 14, 30, 60].map((t) => (
                      <option key={t} value={t}>
                        {t} Tage
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="feld">
                Nachricht (optional, steht über dem Dokument)
                <textarea rows={2} value={nachricht} onChange={(e) => setNachricht(e.target.value)} aria-label="Nachricht" />
              </label>
              {felder && felder.length > 0 && (
                <p className="leise klein">
                  <PenLine size={12} /> {felder.length} Unterschriftsfeld{felder.length === 1 ? "" : "er"}
                  {mehrere ? ` für ${rollen.length} Personen` : ""}. Rolle ändern: Feld anklicken → rechts „Unterzeichner“. Ausgefüllte Formularfelder werden fest
                  eingebrannt.
                </p>
              )}
            </div>
          </div>
        )}

        {ergebnis && (
          <div className="sig-ergebnis">
            <p>
              <CheckCircle2 size={16} className="ok" /> {ergebnis.personen.length === 1 ? "Link erstellt – er ist bereits in der Zwischenablage." : `${ergebnis.personen.length} persönliche Links erstellt.`}
              {ergebnis.hubspot.kontakt_id ? " In HubSpot vermerkt." : ""}
              {ergebnis.reihenfolge ? " Es wird der Reihe nach unterschrieben." : ""}
            </p>
            {ergebnis.personen.map((p, i) => {
              const eingabe = person(p.rolle);
              const farbe = ROLLEN_FARBEN[i % ROLLEN_FARBEN.length];
              return (
                <div key={p.nr} className="sig-link-block" style={{ borderLeftColor: farbe }}>
                  <strong style={{ color: farbe }}>
                    {ergebnis.personen.length > 1 ? `${p.rolle}: ` : ""}
                    {p.name || "ohne Namen"}
                  </strong>
                  <div className="sig-link">
                    <input readOnly value={p.link ?? ""} aria-label={`Link für ${p.rolle}`} onFocus={(e) => e.target.select()} />
                    <button type="button" className="umschalter" onClick={() => void kopieren(p.link ?? "", "Link")}>
                      <Copy size={14} /> Kopieren
                    </button>
                  </div>
                  {p.mit_code && (
                    <p className="leise">
                      <Lock size={13} /> Zugangscode: <strong>{eingabe.code}</strong> – bitte separat mitteilen.
                    </p>
                  )}
                  <div className="sig-knoepfe">
                    <button type="button" className="umschalter" onClick={() => void kopieren(emailText(ergebnis, p, p.mit_code), "E-Mail-Text")}>
                      <Copy size={14} /> E-Mail-Text
                    </button>
                    {(p.email || eingabe.kontakt?.email) && (
                      <button
                        type="button"
                        className="umschalter"
                        onClick={() =>
                          void extern(
                            `mailto:${encodeURIComponent(p.email || eingabe.kontakt?.email || "")}?subject=${encodeURIComponent(`Bitte unterschreiben: ${ergebnis.titel}`)}&body=${encodeURIComponent(emailText(ergebnis, p, p.mit_code))}`,
                          )
                        }
                      >
                        <Mail size={14} /> E-Mail öffnen
                      </button>
                    )}
                    <button type="button" className="umschalter" onClick={() => void extern(whatsapp(eingabe.kontakt?.telefon ?? "", emailText(ergebnis, p, p.mit_code)))}>
                      <MessageCircle size={14} /> WhatsApp
                    </button>
                    {p.hubspot_url && (
                      <button type="button" className="umschalter" onClick={() => void extern(p.hubspot_url!)}>
                        <ExternalLink size={14} /> HubSpot
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="dialog-knoepfe">
          {ergebnis ? (
            <>
              <button type="button" onClick={() => setzen({ dialog: { art: "signaturen" } })}>
                Zur Übersicht
              </button>
              <button type="button" className="primaer" onClick={zu}>
                Fertig
              </button>
            </>
          ) : (
            <>
              {bereit && fehlend.length > 0 && <span className="leise klein sig-fehlt">Name fehlt: {fehlend.join(", ")}</span>}
              <button type="button" onClick={zu}>
                Abbrechen
              </button>
              <button type="submit" className="primaer" disabled={!bereit || laeuft || !titel.trim() || fehlend.length > 0}>
                {laeuft ? "Wird erstellt …" : rollen.length > 1 ? "Links erstellen" : "Link erstellen"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------- Übersicht
const VERLAUF_TEXT: Record<string, string> = {
  erstellt: "Bereitgestellt",
  geoeffnet: "Link geöffnet",
  code_ok: "Zugangscode bestätigt",
  code_falsch: "Falscher Zugangscode",
  gesperrt: "Gesperrt (Fehlversuche)",
  entsperrt: "Wieder freigegeben",
  unterschrieben: "Unterschrieben",
  abgeschlossen: "Alle Unterschriften vollständig",
  kopie: "Kopie heruntergeladen",
  widerrufen: "Zurückgezogen",
};

const PERSON_STATUS: Record<SignaturPerson["status"], string> = { offen: "Noch nicht geöffnet", geoeffnet: "Geöffnet", unterschrieben: "Unterschrieben" };

function StatusChip({ status }: { status: SignaturStatusWert }) {
  const Icon = status === "unterschrieben" ? CheckCircle2 : status === "abgelaufen" || status === "widerrufen" ? XCircle : status === "offen" ? Clock : Eye;
  return (
    <span className={`sig-status sig-${status}`}>
      <Icon size={12} /> {STATUS_TEXT[status] ?? status}
    </span>
  );
}

function AuftragDetail({ id, aktualisieren }: { id: string; aktualisieren: () => void }) {
  const [a, setA] = useState<SignaturAuftrag | null>(null);
  useEffect(() => {
    api
      .signaturAuftrag(id)
      .then(setA)
      .catch((e) => melden(fehlerText(e), "fehler"));
  }, [id]);
  if (!a) return <div className="sig-detail leise">Lädt …</div>;
  const aktion = async (art: "widerrufen" | "entsperren" | "hubspot", nr = 0) => {
    try {
      setA(await api.signaturAktion(a.id, art, nr));
      aktualisieren();
    } catch (e) {
      melden(fehlerText(e), "fehler");
    }
  };
  const offen = a.status === "offen" || a.status === "geoeffnet" || a.status === "teilweise";
  const namen = Object.fromEntries(a.personen.map((p) => [p.nr, p.unterschrieben_als || p.name || p.rolle]));
  return (
    <div className="sig-detail">
      <ul className="sig-personen">
        {a.personen.map((p, i) => (
          <li key={p.nr} style={{ borderLeftColor: ROLLEN_FARBEN[i % ROLLEN_FARBEN.length] }}>
            <span className="sig-titel">
              <strong>
                {a.personen.length > 1 ? `${a.reihenfolge ? `${p.nr}. ` : ""}${p.rolle}: ` : ""}
                {p.unterschrieben_als || p.name || "ohne Namen"}
              </strong>
              <small>
                {p.status === "unterschrieben" ? `Unterschrieben ${datum(p.unterschrieben)}` : PERSON_STATUS[p.status]}
                {p.mit_code ? " · mit Code" : ""}
                {p.gesperrt ? " · gesperrt" : ""}
              </small>
            </span>
            <span className="sig-knoepfe">
              {offen && p.status !== "unterschrieben" && (
                <button type="button" className="umschalter" onClick={() => void kopieren(p.link ?? "", "Link")} aria-label={`Link ${p.rolle} kopieren`}>
                  <Copy size={14} /> Link
                </button>
              )}
              {offen && p.gesperrt && (
                <button type="button" className="umschalter" onClick={() => void aktion("entsperren", p.nr)}>
                  <Unlock size={14} /> Freigeben
                </button>
              )}
              {p.hubspot_url && (
                <button type="button" className="symbol" onClick={() => void extern(p.hubspot_url!)} title="In HubSpot öffnen" aria-label="In HubSpot öffnen">
                  <ExternalLink size={14} />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="sig-knoepfe">
        {a.status === "unterschrieben" && (
          <button
            type="button"
            className="umschalter"
            onClick={async () => {
              try {
                dokumentHinzufuegen(await api.signaturOeffnen(a.id));
                zu();
              } catch (e) {
                melden(fehlerText(e), "fehler");
              }
            }}
          >
            <FileSignature size={14} /> Unterschriebene PDF öffnen
          </button>
        )}
        {offen && (
          <button type="button" className="umschalter" onClick={() => void aktion("widerrufen")}>
            <Undo2 size={14} /> Zurückziehen
          </button>
        )}
        {a.ablage.hubspot_fehler && (
          <button type="button" className="umschalter" onClick={() => void aktion("hubspot")}>
            <RefreshCw size={14} /> Erneut an HubSpot
          </button>
        )}
      </div>
      {a.ablage.hubspot_fehler && <p className="warnung">HubSpot: {a.ablage.hubspot_fehler}</p>}
      <ol className="sig-verlauf">
        {(a.verlauf ?? []).map((e, i) => (
          <li key={i}>
            <time>{datum(e.zeit)}</time> <span>{VERLAUF_TEXT[e.art] ?? e.art}</span>
            {e.nr && a.personen.length > 1 ? <small>{namen[e.nr]}</small> : null}
            {e.ip && <small>{e.ip}</small>}
            {e.text && <small>{e.text}</small>}
          </li>
        ))}
      </ol>
      {a.sha_ergebnis && <p className="leise klein">Prüfsumme der unterschriebenen PDF: {a.sha_ergebnis}</p>}
    </div>
  );
}

export function SignaturUebersichtDialog() {
  const [liste, setListe] = useState<SignaturAuftrag[] | null>(null);
  const [fehler, setFehler] = useState("");
  const [filter, setFilter] = useState<"alle" | "offen" | "unterschrieben">("alle");
  const [suche, setSuche] = useState("");
  const [offen, setOffen] = useState<string | null>(null);
  const timer = useRef<number>();
  const laden = () =>
    api
      .signaturAuftraege()
      .then((r) => {
        setListe(r.auftraege);
        setFehler("");
      })
      .catch((e) => setFehler(fehlerText(e)));
  useEffect(() => {
    void laden();
    timer.current = window.setInterval(() => void laden(), 30000);
    return () => window.clearInterval(timer.current);
  }, []);
  const q = suche.trim().toLowerCase();
  const sichtbar = (liste ?? []).filter((a) => {
    const istOffen = a.status === "offen" || a.status === "geoeffnet" || a.status === "teilweise";
    if (filter === "offen" && !istOffen) return false;
    if (filter === "unterschrieben" && a.status !== "unterschrieben") return false;
    return !q || [a.titel, a.hubspot.kontakt_name, a.erstellt_von, ...a.personen.map((p) => `${p.name} ${p.rolle}`)].join(" ").toLowerCase().includes(q);
  });
  return (
    <div className="dialog-hintergrund" onMouseDown={zu}>
      <div className="dialog breit sig-dialog sig-uebersicht" role="dialog" aria-label="Unterschriften" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && zu()}>
        <h2>
          <FileSignature size={18} /> Unterschriften
        </h2>
        {fehler ? (
          <>
            <p className="warnung">{fehler}</p>
            {/nicht eingerichtet/.test(fehler) && <VerbindenFeld fertig={() => void laden()} />}
          </>
        ) : (
          <div className="sig-filter">
            {(["alle", "offen", "unterschrieben"] as const).map((f) => (
              <button key={f} type="button" className={`umschalter${filter === f ? " an" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "alle" ? "Alle" : f === "offen" ? "Offen" : "Unterschrieben"}
              </button>
            ))}
            <span className="sig-suchfeld">
              <Search size={14} />
              <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Suchen …" aria-label="Unterschriften durchsuchen" />
            </span>
            <button type="button" className="symbol" onClick={() => void laden()} title="Aktualisieren" aria-label="Aktualisieren">
              <RefreshCw size={14} />
            </button>
          </div>
        )}
        {liste && (
          <ul className="sig-liste">
            {sichtbar.length === 0 && <li className="leise">Noch nichts hier.</li>}
            {sichtbar.map((a) => {
              const fertig = a.personen.filter((p) => p.status === "unterschrieben").length;
              return (
                <li key={a.id} className={offen === a.id ? "offen" : ""}>
                  <button type="button" className="sig-eintrag" onClick={() => setOffen(offen === a.id ? null : a.id)} aria-expanded={offen === a.id}>
                    <span className="sig-titel">
                      <strong>{a.titel}</strong>
                      <small>
                        {a.personen.map((p) => p.name || p.rolle).join(", ") || "ohne Empfänger"} · {datum(a.erstellt)}
                        {a.erstellt_von ? ` · ${a.erstellt_von}` : ""}
                      </small>
                    </span>
                    <span className="sig-rechts">
                      <StatusChip status={a.status} />
                      <small>
                        {a.status === "unterschrieben"
                          ? datum(a.fertig)
                          : a.personen.length > 1 && a.status !== "abgelaufen" && a.status !== "widerrufen"
                            ? `${fertig} von ${a.personen.length} · bis ${datum(a.gueltig_bis, false)}`
                            : a.status === "offen" || a.status === "geoeffnet"
                              ? `bis ${datum(a.gueltig_bis, false)}`
                              : ""}
                      </small>
                    </span>
                  </button>
                  {offen === a.id && <AuftragDetail id={a.id} aktualisieren={() => void laden()} />}
                </li>
              );
            })}
          </ul>
        )}
        <div className="dialog-knoepfe">
          <button type="button" className="primaer" onClick={zu}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
