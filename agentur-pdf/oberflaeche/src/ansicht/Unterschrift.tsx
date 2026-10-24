// Online-Unterschrift über „Ergoforyou Sign“ auf dem NAS: Senden-Dialog
// (HubSpot-Kontakt, Zugangscode, Link), Übersicht und Verbindung in den
// Einstellungen.

import {
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileSignature,
  Link2,
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
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { HubSpotKontakt, SignaturAuftrag, SignaturStatus, SignaturStatusWert } from "../typen";
import { dokumentHinzufuegen, holen, melden, setzen, useZustand } from "../zustand/store";

const zu = () => setzen({ dialog: null });

function fehlerText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const STATUS_TEXT: Record<SignaturStatusWert, string> = {
  offen: "Versendet",
  geoeffnet: "Geöffnet",
  unterschrieben: "Unterschrieben",
  abgelaufen: "Abgelaufen",
  widerrufen: "Zurückgezogen",
};

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

function emailText(a: SignaturAuftrag, mitCode: boolean): string {
  const anrede = a.empfaenger.name ? `Hallo ${a.empfaenger.name},` : "Hallo,";
  return [
    anrede,
    "",
    `bitte unterschreiben Sie „${a.titel}“ online über diesen persönlichen Link:`,
    a.link ?? "",
    "",
    `Der Link ist gültig bis ${datum(a.gueltig_bis, false)}. Nach der Unterschrift können Sie sich sofort eine Kopie herunterladen.`,
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
function KontaktSuche({ wert, aendern }: { wert: HubSpotKontakt | null; aendern: (k: HubSpotKontakt | null) => void }) {
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
        <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Name, E-Mail oder Firma in HubSpot suchen …" aria-label="HubSpot-Kontakt suchen" />
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

// ----------------------------------------------------------- Senden
export function SignaturSendenDialog({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId));
  const [status, setStatus] = useState<SignaturStatus | null>(null);
  const [felder, setFelder] = useState<{ seite: number; name: string }[] | null>(null);
  const [titel, setTitel] = useState(() => (dok?.titel ?? "").replace(/\.pdf$/i, ""));
  const [kontakt, setKontakt] = useState<HubSpotKontakt | null>(null);
  const [deals, setDeals] = useState<{ id: string; name: string }[]>([]);
  const [deal, setDeal] = useState("");
  const [name, setName] = useState("");
  const [mitCode, setMitCode] = useState(false);
  const [code, setCode] = useState("");
  const [tage, setTage] = useState(14);
  const [nachricht, setNachricht] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<SignaturAuftrag | null>(null);

  useEffect(() => {
    api.signaturStatus().then(setStatus).catch((e) => setStatus({ eingerichtet: false, fehler: fehlerText(e) }));
    api
      .signaturFelder(dokId)
      .then((r) => setFelder(r.felder))
      .catch(() => setFelder([]));
  }, [dokId]);

  useEffect(() => {
    setDeal("");
    setDeals([]);
    if (!kontakt) return;
    if (!name.trim()) setName(kontakt.name);
    api
      .signaturDeals(kontakt.id)
      .then((r) => {
        setDeals(r.deals);
        if (r.deals.length === 1) setDeal(r.deals[0].id);
      })
      .catch(() => undefined);
  }, [kontakt?.id]);

  if (!dok) return null;
  const bereit = status?.eingerichtet && status.erreichbar;

  const senden = async () => {
    if (mitCode && code.trim().length < 4) {
      melden("Der Zugangscode braucht mindestens 4 Zeichen.", "fehler");
      return;
    }
    setLaeuft(true);
    try {
      const a = await api.signaturSenden(dokId, {
        titel: titel.trim(),
        kontakt,
        deal_id: deal,
        empfaenger_name: name.trim(),
        code: mitCode ? code.trim() : "",
        gueltig_tage: tage,
        nachricht: nachricht.trim(),
      });
      setErgebnis(a);
      if (a.link) void navigator.clipboard?.writeText(a.link).catch(() => undefined);
    } catch (e) {
      melden(fehlerText(e), "fehler");
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="dialog-hintergrund" onMouseDown={zu}>
      <form
        className="dialog breit sig-dialog"
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
          <>
            <label className="feld">
              Titel (sieht der Kunde)
              <input value={titel} onChange={(e) => setTitel(e.target.value)} aria-label="Titel" />
            </label>
            {status.hubspot ? (
              <div className="feld">
                <span>Kontakt in HubSpot (optional – dort wird das Ergebnis abgelegt)</span>
                <KontaktSuche wert={kontakt} aendern={setKontakt} />
              </div>
            ) : (
              <p className="leise">HubSpot ist auf dem NAS noch nicht verbunden – das Ergebnis wird nur auf dem NAS abgelegt.</p>
            )}
            {kontakt && deals.length > 0 && (
              <label className="feld">
                Deal (optional)
                <select value={deal} onChange={(e) => setDeal(e.target.value)} aria-label="Deal">
                  <option value="">– nur am Kontakt ablegen –</option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="feld">
              Name des Unterzeichners (vorausgefüllt, der Kunde kann ihn ändern)
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Max Muster" aria-label="Name des Unterzeichners" />
            </label>
            <div className="sig-zeile">
              <label className="auswahl-zeile">
                <input
                  type="checkbox"
                  checked={mitCode}
                  onChange={(e) => {
                    setMitCode(e.target.checked);
                    if (e.target.checked && !code) setCode(zufallsCode());
                  }}
                />
                Zugangscode verlangen
              </label>
              {mitCode && (
                <>
                  <input className="zahl breit" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Zugangscode" maxLength={32} />
                  <span className="leise klein">dem Kunden separat nennen (z. B. am Telefon)</span>
                </>
              )}
            </div>
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
            <label className="feld">
              Nachricht an den Kunden (optional, steht über dem Dokument)
              <textarea rows={2} value={nachricht} onChange={(e) => setNachricht(e.target.value)} aria-label="Nachricht" />
            </label>
            {felder && (
              <p className={felder.length ? "leise" : "hinweis-box"}>
                {felder.length ? (
                  <>
                    <PenLine size={13} /> {felder.length} Unterschriftsfeld{felder.length === 1 ? "" : "er"} im Dokument (Seite{" "}
                    {[...new Set(felder.map((f) => f.seite + 1))].join(", ")}). Ausgefüllte Formularfelder werden fest eingebrannt.
                  </>
                ) : (
                  <>
                    Kein Unterschriftsfeld im Dokument – der Kunde unterschreibt dann nur auf dem Prüfprotokoll. Tipp: <strong>Schützen → Unterschriftsfeld</strong>{" "}
                    aufziehen, wo unterschrieben werden soll.
                  </>
                )}
              </p>
            )}
          </>
        )}

        {ergebnis && (
          <div className="sig-ergebnis">
            <p>
              <CheckCircle2 size={16} className="ok" /> Link erstellt{ergebnis.hubspot.kontakt_id ? " – in HubSpot vermerkt" : ""}. Er ist bereits in der
              Zwischenablage.
            </p>
            <div className="sig-link">
              <input readOnly value={ergebnis.link ?? ""} aria-label="Link für den Kunden" onFocus={(e) => e.target.select()} />
              <button type="button" className="umschalter" onClick={() => void kopieren(ergebnis.link ?? "", "Link")}>
                <Copy size={14} /> Kopieren
              </button>
            </div>
            {mitCode && (
              <p className="leise">
                <Lock size={13} /> Zugangscode: <strong>{code}</strong> – bitte separat mitteilen.
              </p>
            )}
            <div className="sig-knoepfe">
              <button type="button" className="umschalter" onClick={() => void kopieren(emailText(ergebnis, mitCode), "E-Mail-Text")}>
                <Copy size={14} /> E-Mail-Text kopieren
              </button>
              {kontakt?.email && (
                <button
                  type="button"
                  className="umschalter"
                  onClick={() =>
                    void extern(
                      `mailto:${encodeURIComponent(kontakt.email)}?subject=${encodeURIComponent(`Bitte unterschreiben: ${ergebnis.titel}`)}&body=${encodeURIComponent(emailText(ergebnis, mitCode))}`,
                    )
                  }
                >
                  <Mail size={14} /> E-Mail öffnen
                </button>
              )}
              <button
                type="button"
                className="umschalter"
                onClick={() => {
                  const nummer = (kontakt?.telefon ?? "").replace(/[^\d+]/g, "").replace(/^00/, "+").replace(/^0/, "+49").replace(/^\+/, "");
                  void extern(`https://wa.me/${nummer}?text=${encodeURIComponent(emailText(ergebnis, mitCode))}`);
                }}
              >
                <MessageCircle size={14} /> WhatsApp
              </button>
              {ergebnis.hubspot_url && (
                <button type="button" className="umschalter" onClick={() => void extern(ergebnis.hubspot_url!)}>
                  <ExternalLink size={14} /> In HubSpot öffnen
                </button>
              )}
            </div>
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
              <button type="button" onClick={zu}>
                Abbrechen
              </button>
              <button type="submit" className="primaer" disabled={!bereit || laeuft || !titel.trim()}>
                {laeuft ? "Wird erstellt …" : "Link erstellen"}
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
  kopie: "Kopie heruntergeladen",
  widerrufen: "Zurückgezogen",
};

function StatusChip({ status }: { status: SignaturStatusWert }) {
  const Icon = status === "unterschrieben" ? CheckCircle2 : status === "abgelaufen" || status === "widerrufen" ? XCircle : status === "geoeffnet" ? Eye : Clock;
  return (
    <span className={`sig-status sig-${status}`}>
      <Icon size={12} /> {STATUS_TEXT[status]}
    </span>
  );
}

function AuftragDetail({ id, aktualisieren }: { id: string; aktualisieren: () => void }) {
  const [a, setA] = useState<SignaturAuftrag | null>(null);
  const laden = () =>
    api
      .signaturAuftrag(id)
      .then(setA)
      .catch((e) => melden(fehlerText(e), "fehler"));
  useEffect(() => {
    void laden();
  }, [id]);
  if (!a) return <div className="sig-detail leise">Lädt …</div>;
  const aktion = async (art: "widerrufen" | "entsperren" | "hubspot") => {
    try {
      setA(await api.signaturAktion(a.id, art));
      aktualisieren();
    } catch (e) {
      melden(fehlerText(e), "fehler");
    }
  };
  const offen = a.status === "offen" || a.status === "geoeffnet";
  return (
    <div className="sig-detail">
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
          <button type="button" className="umschalter" onClick={() => void kopieren(a.link ?? "", "Link")}>
            <Copy size={14} /> Link kopieren
          </button>
        )}
        {offen && a.code_gesperrt && (
          <button type="button" className="umschalter" onClick={() => void aktion("entsperren")}>
            <Unlock size={14} /> Wieder freigeben
          </button>
        )}
        {offen && (
          <button type="button" className="umschalter" onClick={() => void aktion("widerrufen")}>
            <Undo2 size={14} /> Zurückziehen
          </button>
        )}
        {a.hubspot_url && (
          <button type="button" className="umschalter" onClick={() => void extern(a.hubspot_url!)}>
            <ExternalLink size={14} /> HubSpot
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
    if (filter === "offen" && !(a.status === "offen" || a.status === "geoeffnet")) return false;
    if (filter === "unterschrieben" && a.status !== "unterschrieben") return false;
    return !q || [a.titel, a.empfaenger.name, a.hubspot.kontakt_name, a.erstellt_von].join(" ").toLowerCase().includes(q);
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
            {sichtbar.map((a) => (
              <li key={a.id} className={offen === a.id ? "offen" : ""}>
                <button type="button" className="sig-eintrag" onClick={() => setOffen(offen === a.id ? null : a.id)} aria-expanded={offen === a.id}>
                  <span className="sig-titel">
                    <strong>{a.titel}</strong>
                    <small>
                      {a.empfaenger.name || a.hubspot.kontakt_name || "ohne Empfänger"} · {datum(a.erstellt)}
                      {a.erstellt_von ? ` · ${a.erstellt_von}` : ""}
                      {a.mit_code ? " · mit Code" : ""}
                    </small>
                  </span>
                  <span className="sig-rechts">
                    <StatusChip status={a.status} />
                    <small>
                      {a.status === "unterschrieben"
                        ? datum(a.unterzeichnet)
                        : a.status === "offen" || a.status === "geoeffnet"
                          ? `bis ${datum(a.gueltig_bis, false)}`
                          : ""}
                    </small>
                  </span>
                </button>
                {offen === a.id && <AuftragDetail id={a.id} aktualisieren={() => void laden()} />}
              </li>
            ))}
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
