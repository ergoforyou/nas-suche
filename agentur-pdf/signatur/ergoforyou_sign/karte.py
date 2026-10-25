"""HubSpot-Karte „Ergoforyou Sign“ (rechte Seitenleiste an Kontakt und Deal).

Ablauf:
1. Die Karte in HubSpot ruft ``/hs/karte`` über ``hubspot.fetch`` auf. HubSpot
   unterschreibt jede dieser Anfragen mit dem Client-Secret der App
   (Kopf ``X-HubSpot-Signature-v3``). Ohne gültige Unterschrift gibt es nichts.
2. Die Antwort enthält die Aufträge zum Datensatz und einen kurzlebigen
   Schlüssel (``t``), der nur für diesen Kontakt/Deal gilt.
3. „Neue Unterschrift anfordern“ öffnet ``/hs/studio?t=…`` als Fenster in
   HubSpot: PDF wählen, Felder setzen, Unterzeichner, senden.

Alles läuft über die öffentliche Adresse (Tunnel) – die Einrichtungsseite und
die Schnittstelle für Ergoforyou PDF bleiben weiter nur im Büronetz.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .auftraege import OFFEN, AuftragFehler, dateiname, ortszeit
from .hubspot import HubSpotFehler

STATISCH = Path(__file__).parent / "statisch"
SCHLUESSEL_S = 8 * 3600  # so lange gilt der Schlüssel aus der Karte
ENTWURF_S = 2 * 86400  # liegengebliebene Entwürfe danach löschen
MAX_ZEITVERSATZ_MS = 5 * 60 * 1000
HUBSPOT_PARAMETER = ("userId", "portalId", "userEmail", "appId")
OBJEKTE = {"0-1": "contacts", "0-3": "deals", "contacts": "contacts", "deals": "deals", "contact": "contacts", "deal": "deals"}
STATUS_TEXT = {
    "offen": "Versendet",
    "geoeffnet": "Geöffnet",
    "teilweise": "Teilweise unterschrieben",
    "unterschrieben": "Unterschrieben",
    "abgelaufen": "Abgelaufen",
    "widerrufen": "Zurückgezogen",
}
# HubSpot dekodiert diese Zeichen in der Adresse, bevor es unterschreibt.
_DEKODIEREN = {"%3A": ":", "%2F": "/", "%3F": "?", "%40": "@", "%21": "!", "%24": "$", "%27": "'", "%28": "(", "%29": ")", "%2A": "*", "%2C": ",", "%3B": ";"}
CSP_STUDIO = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; "
    "frame-ancestors https://app.hubspot.com https://app-eu1.hubspot.com https://*.hubspot.com; base-uri 'none'; form-action 'none'"
)


# ------------------------------------------------------------- Signatur
def _hubspot_dekodiert(adresse: str) -> str:
    return re.sub(r"%[0-9A-Fa-f]{2}", lambda m: _DEKODIEREN.get(m.group(0).upper(), m.group(0)), adresse)


def _ohne_hubspot_parameter(adresse: str) -> str:
    if "?" not in adresse:
        return adresse
    pfad, abfrage = adresse.split("?", 1)
    teile = [t for t in abfrage.split("&") if t and unquote(t.split("=", 1)[0]) not in HUBSPOT_PARAMETER]
    return f"{pfad}?{'&'.join(teile)}" if teile else pfad


def adressen_kandidaten(basen: list[str], pfad_mit_abfrage: str) -> list[str]:
    """Mögliche Schreibweisen der aufgerufenen Adresse (Tunnel-Name, mit/ohne
    die von HubSpot angehängten Parameter, HubSpot-Dekodierung)."""
    ergebnis: list[str] = []
    for basis in basen:
        if not basis:
            continue
        voll = basis.rstrip("/") + pfad_mit_abfrage
        for a in (voll, _ohne_hubspot_parameter(voll)):
            for b in (a, _hubspot_dekodiert(a), unquote(a)):
                if b not in ergebnis:
                    ergebnis.append(b)
    return ergebnis


def signatur_v3(geheimnis: str, methode: str, adresse: str, inhalt: str, zeitstempel: str) -> str:
    quelle = f"{methode.upper()}{adresse}{inhalt}{zeitstempel}"
    return base64.b64encode(hmac.new(geheimnis.encode(), quelle.encode(), hashlib.sha256).digest()).decode()


def signatur_pruefen(geheimnis: str, methode: str, adressen: list[str], inhalt: str, zeitstempel: str, signatur: str, jetzt_ms: int | None = None) -> str:
    """Leerer Text = in Ordnung, sonst der Grund (für die Einrichtungsseite)."""
    if not geheimnis:
        return "Auf dem NAS ist das Client-Secret der HubSpot-App noch nicht eingetragen (Einrichtung → HubSpot-Karte)."
    if not signatur or not zeitstempel:
        return "Anfrage kommt nicht von HubSpot (Unterschrift fehlt)."
    try:
        zeit = int(zeitstempel)
    except ValueError:
        return "Anfrage kommt nicht von HubSpot (Zeitstempel ungültig)."
    jetzt_ms = int(time.time() * 1000) if jetzt_ms is None else jetzt_ms
    if abs(jetzt_ms - zeit) > MAX_ZEITVERSATZ_MS:
        return "Zeitstempel zu alt – stimmt die Uhrzeit des NAS?"
    for adresse in adressen:
        if hmac.compare_digest(signatur_v3(geheimnis, methode, adresse, inhalt, zeitstempel), signatur):
            return ""
    return "Unterschrift von HubSpot passt nicht – ist auf dem NAS das richtige Client-Secret eingetragen?"


# ------------------------------------------------------------ Schlüssel
def schluessel_erzeugen(signieren: Callable[[str], str], daten: dict, dauer_s: int = SCHLUESSEL_S) -> str:
    inhalt = base64.urlsafe_b64encode(json.dumps({**daten, "x": int(time.time()) + dauer_s}, separators=(",", ":")).encode()).decode().rstrip("=")
    return f"{inhalt}.{signieren('karte:' + inhalt)[:43]}"


def schluessel_lesen(signieren: Callable[[str], str], wert: str) -> dict:
    try:
        inhalt, unterschrift = (wert or "").split(".", 1)
        if not hmac.compare_digest(unterschrift, signieren("karte:" + inhalt)[:43]):
            raise ValueError
        daten = json.loads(base64.urlsafe_b64decode(inhalt + "=" * (-len(inhalt) % 4)))
    except (ValueError, TypeError):
        raise AuftragFehler("Sitzung ungültig – bitte die Karte in HubSpot neu laden.", 401) from None
    if int(daten.get("x", 0)) < time.time():
        raise AuftragFehler("Sitzung abgelaufen – bitte die Karte in HubSpot neu laden.", 401)
    return daten


def gehoert_zu(a: dict, objekt: str, objekt_id: str) -> bool:
    hs = a.get("hubspot") or {}
    if objekt == "deals":
        return hs.get("deal_id") == objekt_id
    return hs.get("kontakt_id") == objekt_id or any(p.get("hubspot_kontakt_id") == objekt_id for p in a.get("personen", []))


# ================================================================ Routen
def karte_routen(app: FastAPI, dienst) -> None:
    konfig, auftraege = dienst.konfig, dienst.auftraege
    entwuerfe = dienst.ordner / "entwuerfe"
    entwuerfe.mkdir(exist_ok=True)

    def basis() -> str:
        return konfig.oeffentliche_adresse

    def sitzung(request: Request) -> dict:
        wert = request.headers.get("x-karte") or request.query_params.get("t") or ""
        return schluessel_lesen(konfig.signieren, wert)

    def sitzungs_auftrag(s: dict, auftrag_id: str) -> dict:
        a = auftraege.laden(auftrag_id)
        if not gehoert_zu(a, s["o"], s["i"]):
            raise AuftragFehler("Dieser Auftrag gehört nicht zu diesem Datensatz.", 404)
        return a

    def kurz(a: dict, t: str) -> dict:
        d = dienst.detail(a)
        offen = a["status"] in OFFEN
        return {
            "id": a["id"],
            "titel": a["titel"],
            "status": a["status"],
            "status_text": STATUS_TEXT.get(a["status"], a["status"]),
            "erstellt": ortszeit(a["erstellt"], False),
            "erstellt_von": a["erstellt_von"],
            "fertig": ortszeit(a["fertig"], False) if a.get("fertig") else "",
            "anzahl": len(a["personen"]),
            "unterschrieben": sum(p["status"] == "unterschrieben" for p in a["personen"]),
            "personen": [
                {
                    "rolle": p["rolle"],
                    "name": p["name"],
                    "status": p["status"],
                    "link": p["link"] if offen and p["status"] != "unterschrieben" else "",
                }
                for p in d["personen"]
            ],
            "pdf": f"{basis()}/hs/pdf/{a['id']}?t={t}" if a["status"] == "unterschrieben" else "",
            "hubspot_fehler": a["ablage"].get("hubspot_fehler", ""),
        }

    # ------------------------------------------------- Aufruf aus der Karte
    @app.get("/hs/karte")
    async def karte(request: Request, objekt: str = "", id: str = "", von: str = ""):
        inhalt = (await request.body()).decode("utf-8", "replace")
        roh = request.scope.get("raw_path", request.url.path.encode()).decode("latin-1")
        abfrage = request.scope.get("query_string", b"").decode("latin-1")
        pfad = roh + (f"?{abfrage}" if abfrage else "")
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        grund = signatur_pruefen(
            str(konfig.get("hubspot_app_geheimnis") or ""),
            request.method,
            adressen_kandidaten([basis(), f"https://{host}" if host else ""], pfad),
            inhalt,
            request.headers.get("x-hubspot-request-timestamp", ""),
            request.headers.get("x-hubspot-signature-v3", ""),
        )
        portal = str(request.query_params.get("portalId") or "")
        if not grund and portal and konfig.get("hubspot_portal") and portal != str(konfig.get("hubspot_portal")):
            grund = f"Die Karte gehört zu einem anderen HubSpot-Konto ({portal})."
        if grund:
            if request.headers.get("x-hubspot-signature-v3"):  # nur echte Versuche aus HubSpot anzeigen
                konfig.setzen(karte_fehler=grund, karte_fehler_zeit=int(time.time()))
            print(f"[Karte] abgelehnt: {grund}", flush=True)
            return JSONResponse({"fehler": grund}, status_code=401)
        art = OBJEKTE.get(objekt)
        if not art or not id.isdigit():
            raise AuftragFehler("Diese Karte gibt es nur an Kontakten und Deals.")
        if konfig.get("karte_fehler") or time.time() - float(konfig.get("karte_kontakt") or 0) > 300:
            konfig.setzen(karte_kontakt=int(time.time()), karte_fehler="")
        wer = " ".join(von.split())[:100] or str(request.query_params.get("userEmail") or "")[:100]
        t = schluessel_erzeugen(konfig.signieren, {"o": art, "i": id, "v": wer, "p": portal})
        liste = [a for a in auftraege.liste() if gehoert_zu(a, art, id)][:15]
        hinweis = ""
        if not basis():
            hinweis = "Der NAS-Dienst kennt seine öffentliche Adresse noch nicht (Einrichtung → Tunnel)."
        elif not konfig.get("hubspot_token"):
            hinweis = "HubSpot ist auf dem NAS nicht verbunden – Notizen und Ablage im Datensatz fehlen."
        from . import __version__

        return {
            "ok": True,
            "version": __version__,
            "studio": f"{basis()}/hs/studio?t={t}",
            "auftraege": [kurz(auftraege.laden(a["id"]), t) for a in liste],
            "hinweis": hinweis,
        }

    # ------------------------------------------------------ Studio (Fenster)
    @app.get("/hs/studio")
    async def studio(t: str = ""):
        schluessel_lesen(konfig.signieren, t)
        return FileResponse(STATISCH / "studio.html", media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.get("/hs/statisch/{name}")
    async def studio_statisch(name: str):
        if name not in ("studio.js", "studio.css"):
            return Response(status_code=404)
        return FileResponse(STATISCH / name, headers={"Cache-Control": "no-cache"})

    @app.get("/hs/api/kontext")
    def kontext(request: Request):
        s = sitzung(request)
        ergebnis: dict = {"objekt": s["o"], "id": s["i"], "von": s.get("v", ""), "kontakte": [], "deal": None, "deals": [], "anhaenge": [], "hinweise": []}
        if not konfig.get("hubspot_token"):
            ergebnis["hinweise"].append("HubSpot ist auf dem NAS nicht verbunden – Namen bitte von Hand eintragen.")
            return ergebnis
        try:
            with dienst.hubspot() as h:
                if s["o"] == "deals":
                    ergebnis["deal"] = h.deal(s["i"])
                    ergebnis["kontakte"] = h.deal_kontakte(s["i"])
                else:
                    ergebnis["kontakte"] = [h.kontakt(s["i"])]
                    try:
                        ergebnis["deals"] = h.deals(s["i"])
                    except HubSpotFehler:
                        pass
                try:
                    ergebnis["anhaenge"] = h.anhaenge(s["o"], s["i"])
                except HubSpotFehler as fehler:
                    ergebnis["hinweise"].append(f"Anhänge aus HubSpot nicht lesbar: {fehler}")
        except HubSpotFehler as fehler:
            ergebnis["hinweise"].append(str(fehler))
        return ergebnis

    def entwurf_ordner(s: dict, eid: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{16}", eid or ""):
            raise AuftragFehler("Entwurf nicht gefunden – bitte die PDF neu wählen.", 404)
        ordner = entwuerfe / eid
        try:
            info = json.loads((ordner / "entwurf.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise AuftragFehler("Entwurf nicht gefunden – bitte die PDF neu wählen.", 404) from None
        if info.get("o") != s["o"] or info.get("i") != s["i"]:
            raise AuftragFehler("Entwurf nicht gefunden – bitte die PDF neu wählen.", 404)
        return ordner

    def entwurf_anlegen(s: dict, name: str, pdf: bytes) -> dict:
        from .pdfwerk import entwurf_vorbereiten

        if len(pdf) > 40_000_000:
            raise AuftragFehler("Die PDF ist zu groß (max. 40 MB).")
        pdf, seiten, vorschlaege = entwurf_vorbereiten(pdf)
        eid = secrets.token_hex(8)
        ordner = entwuerfe / eid
        ordner.mkdir(parents=True)
        (ordner / "original.pdf").write_bytes(pdf)
        name = dateiname(re.sub(r"\.pdf$", "", name or "Dokument", flags=re.I))
        (ordner / "entwurf.json").write_text(json.dumps({"o": s["o"], "i": s["i"], "name": name, "zeit": int(time.time())}), encoding="utf-8")
        return {"entwurf": eid, "name": name, "seiten": seiten, "vorschlaege": vorschlaege}

    @app.post("/hs/api/entwurf")
    async def entwurf_hochladen(request: Request):
        s = sitzung(request)
        pdf = await request.body()
        name = unquote(request.headers.get("x-dateiname", "") or "Dokument")[:200]
        return entwurf_anlegen(s, name, pdf)

    @app.post("/hs/api/entwurf/hubspot")
    def entwurf_aus_hubspot(request: Request, datei_id: str = Body(..., embed=True)):
        s = sitzung(request)
        if not str(datei_id).isdigit():
            raise AuftragFehler("Unbekannte Datei.")
        with dienst.hubspot() as h:
            anhaenge = {d["id"] for d in h.anhaenge(s["o"], s["i"], grenze=50)}
            if str(datei_id) not in anhaenge:
                raise AuftragFehler("Diese Datei hängt nicht an diesem Datensatz.", 404)
            name, pdf = h.datei_laden(str(datei_id))
        return entwurf_anlegen(s, name, pdf)

    @app.get("/hs/api/entwurf/{eid}/seite/{nummer}")
    def entwurf_seite(eid: str, nummer: int, request: Request, breite: int = 900):
        from .pdfwerk import seite_png

        ordner = entwurf_ordner(sitzung(request), eid)
        png = seite_png(ordner / "original.pdf", ordner / "seiten", nummer, breite)
        return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})

    @app.post("/hs/api/senden")
    def senden(request: Request, daten: dict = Body(...)):
        s = sitzung(request)
        ordner = entwurf_ordner(s, str(daten.get("entwurf") or ""))
        info = json.loads((ordner / "entwurf.json").read_text(encoding="utf-8"))
        personen = []
        for p in (daten.get("personen") or [])[:8]:
            kontakt = str(p.get("hubspot_kontakt_id") or "")
            personen.append({**{k: p.get(k) for k in ("rolle", "name", "email", "code")}, "hubspot_kontakt_id": kontakt if kontakt.isdigit() else ""})
        if not personen or not all(" ".join(str(p.get("name") or "").split()) for p in personen):
            raise AuftragFehler("Bitte für jede unterzeichnende Person einen Namen eintragen.")
        deal = s["i"] if s["o"] == "deals" else str(daten.get("deal_id") or "")
        angaben = {
            "titel": str(daten.get("titel") or info["name"]).strip() or info["name"],
            "dateiname": info["name"],
            "nachricht": daten.get("nachricht") or "",
            "gueltig_tage": daten.get("gueltig_tage") or 14,
            "reihenfolge": bool(daten.get("reihenfolge")),
            "erstellt_von": s.get("v") or "HubSpot",
            "hubspot_kontakt_id": s["i"] if s["o"] == "contacts" else (personen[0]["hubspot_kontakt_id"] or ""),
            "hubspot_deal_id": deal if deal.isdigit() else "",
            "personen": personen,
            "felder": daten.get("felder") or [],
        }
        a = dienst.auftrag_anlegen((ordner / "original.pdf").read_bytes(), angaben)
        shutil.rmtree(ordner, ignore_errors=True)
        print(f"[Karte] Auftrag {a['id']} aus HubSpot ({s['o']} {s['i']}) von {angaben['erstellt_von']}", flush=True)
        return dienst.detail(a)

    @app.get("/hs/api/auftraege/{auftrag_id}")
    def detail(auftrag_id: str, request: Request):
        s = sitzung(request)
        d = dienst.detail(sitzungs_auftrag(s, auftrag_id))
        d["status_text"] = STATUS_TEXT.get(d["status"], d["status"])
        d["gueltig_bis_text"] = ortszeit(d["gueltig_bis"], False)
        d["erstellt_text"] = ortszeit(d["erstellt"], False)
        for p in d["personen"]:
            p["unterschrieben_text"] = ortszeit(p["unterschrieben"]) if p["unterschrieben"] else ""
        d["verlauf"] = [{**e, "zeit_text": ortszeit(e["zeit"])} for e in d["verlauf"][-30:]]
        d.pop("felder", None)
        return d

    @app.post("/hs/api/auftraege/{auftrag_id}/widerrufen")
    def widerrufen(auftrag_id: str, request: Request):
        s = sitzung(request)
        sitzungs_auftrag(s, auftrag_id)
        return dienst.detail(dienst.widerrufen(auftrag_id, f"{s.get('v') or 'HubSpot'} (HubSpot)"))

    @app.get("/hs/pdf/{auftrag_id}")
    def pdf(auftrag_id: str, request: Request, art: str = "ergebnis"):
        s = sitzung(request)
        a = sitzungs_auftrag(s, auftrag_id)
        datei = "ergebnis.pdf" if art == "ergebnis" else "original.pdf"
        pfad = auftraege.pfad(a["id"], datei)
        if not pfad.exists():
            raise AuftragFehler("Noch nicht von allen unterschrieben.", 404)
        name = f"{a['dateiname']}{' – unterschrieben' if art == 'ergebnis' else ''}.pdf"
        from urllib.parse import quote

        return Response(pfad.read_bytes(), media_type="application/pdf", headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(name)}"})


def entwuerfe_aufraeumen(ordner: Path) -> int:
    weg = 0
    for e in (ordner / "entwuerfe").glob("*/entwurf.json"):
        try:
            alt = time.time() - int(json.loads(e.read_text(encoding="utf-8")).get("zeit", 0)) > ENTWURF_S
        except (OSError, ValueError):
            alt = True
        if alt:
            shutil.rmtree(e.parent, ignore_errors=True)
            weg += 1
    return weg

