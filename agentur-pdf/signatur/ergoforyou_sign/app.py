"""Die beiden Web-Anwendungen des NAS-Dienstes.

``kunde``  – öffentlich (Reverse-Proxy): nur die Unterschriftsseite ``/s/<link>``.
``intern`` – nur im Büronetz: Einrichtung und Schnittstelle für Ergoforyou PDF
            (Kopf ``X-Sign-Schluessel``).
"""

from __future__ import annotations

import base64
import functools
import html
import ipaddress
import json
import secrets
import threading
import time
from datetime import timedelta
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx
from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

from . import PRODUKT, __version__
from .auftraege import (
    KOPIE_TAGE,
    MAX_CODE_FEHLER,
    OFFEN,
    AuftragFehler,
    Auftraege,
    aus_iso,
    iso,
    jetzt,
    link,
    ortszeit,
    sha256,
    zusammenfassung,
)
from .hubspot import HubSpot, HubSpotFehler
from .konfig import Konfig, kennwort_hash, kennwort_pruefen
from .pdfwerk import ergebnis_erzeugen, felder_pruefen, png_aus_dataurl, pruefen, seite_png

STATISCH = Path(__file__).parent / "statisch"
SITZUNG_S = 12 * 3600
SICHER = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}
CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


@dataclass
class Dienst:
    ordner: Path
    hubspot_transport: httpx.BaseTransport | None = None
    konfig: Konfig = field(init=False)
    auftraege: Auftraege = field(init=False)

    def __post_init__(self) -> None:
        self.konfig = Konfig(self.ordner)
        self.auftraege = Auftraege(self.ordner)

    def hubspot(self) -> HubSpot:
        return HubSpot(self.konfig.get("hubspot_token"), self.hubspot_transport)

    def zugang(self, a: dict) -> str:
        """Nachweis „Zugangscode bestätigt“ – an den Link gebunden."""
        return self.konfig.signieren(f"zugang:{a['id']}:{a['token']}")[:32]

    def hubspot_kontakt_url(self, kontakt_id: str) -> str:
        portal = self.konfig.get("hubspot_portal")
        domain = self.konfig.get("hubspot_domain") or "app-eu1.hubspot.com"
        return f"https://{domain}/contacts/{portal}/record/0-1/{kontakt_id}" if portal and kontakt_id else ""

    # ------------------------------------------------------ HubSpot-Ablage
    def hubspot_im_hintergrund(self, auftrag_id: str, art: str) -> None:
        if not self.konfig.get("hubspot_token"):
            return
        threading.Thread(target=self.hubspot_ablegen, args=(auftrag_id, art), daemon=True).start()

    def hubspot_ablegen(self, auftrag_id: str, art: str) -> None:
        """art = „gesendet“ (Notiz mit Link) oder „fertig“ (PDF + Notiz).
        Die HubSpot-Aufrufe laufen ohne Sperre; nur das Ergebnis wird unter
        der Sperre in den (neu gelesenen) Auftrag geschrieben."""
        schluessel = "hubspot_gesendet" if art == "gesendet" else "hubspot_fertig"
        a = self.auftraege.laden(auftrag_id)
        hs = a["hubspot"]
        if not (hs.get("kontakt_id") or hs.get("deal_id")) or a["ablage"].get(schluessel):
            return
        ergebnis, fehler_text = "", ""
        try:
            with self.hubspot() as h:
                titel = html.escape(a["titel"])
                if art == "gesendet":
                    ziel = link(self.konfig.oeffentliche_adresse, a)
                    text = (
                        f"<p><strong>Zur Unterschrift gesendet:</strong> {titel}</p>"
                        f"<p>Gültig bis {ortszeit(a['gueltig_bis'], False)} · Auftrag {a['id']}"
                        f"{' · mit Zugangscode' if a['code_hash'] else ''} · von {html.escape(a['erstellt_von'] or 'Büro')}</p>"
                        f"<p>Link: {html.escape(ziel)}</p>"
                    )
                    ergebnis = h.notiz(text, hs.get("kontakt_id", ""), hs.get("deal_id", ""))
                else:
                    daten = self.auftraege.pfad(a["id"], "ergebnis.pdf").read_bytes()
                    u = a["unterzeichner"]
                    datei_id = h.datei_hochladen(f"{a['dateiname']} – unterschrieben ({a['id'][-8:]}).pdf", daten)
                    text = (
                        f"<p><strong>✔ Unterschrieben:</strong> {titel}</p>"
                        f"<p>von {html.escape(u['name'])} am {ortszeit(u['zeit'])} · IP {html.escape(u['ip'] or '–')}</p>"
                        f"<p>Auftrag {a['id']} · SHA-256 {a['sha_ergebnis']}</p>"
                    )
                    ergebnis = h.notiz(text, hs.get("kontakt_id", ""), hs.get("deal_id", ""), [datei_id])
        except HubSpotFehler as fehler:
            fehler_text = str(fehler)
        except Exception as fehler:  # noqa: BLE001 – Ablage darf die Unterschrift nie gefährden
            fehler_text = f"Unerwarteter Fehler: {fehler.__class__.__name__}"
        with self.auftraege.sperre:
            a = self.auftraege.laden(auftrag_id)
            if ergebnis:
                a["ablage"][schluessel] = ergebnis
            a["ablage"]["hubspot_fehler"] = fehler_text
            self.auftraege.speichern(a)
        if fehler_text:
            print(f"[HubSpot] {auftrag_id}: {fehler_text}", flush=True)


def _fehlerbehandlung(app: FastAPI) -> None:
    @app.exception_handler(AuftragFehler)
    async def auftrag_fehler(_: Request, fehler: AuftragFehler):
        return JSONResponse({"fehler": str(fehler)}, status_code=fehler.status, headers=SICHER)

    @app.exception_handler(HubSpotFehler)
    async def hubspot_fehler(_: Request, fehler: HubSpotFehler):
        return JSONResponse({"fehler": str(fehler)}, status_code=502, headers=SICHER)


def _gesperrt(auftraege: Auftraege) -> Callable:
    """Endpunkt, der einen Auftrag liest und ändert, unter der Auftragssperre ausführen."""

    def dekorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def mit_sperre(*args: Any, **kwargs: Any) -> Any:
            with auftraege.sperre:
                return fn(*args, **kwargs)

        return mit_sperre

    return dekorator


def client_ip(request: Request) -> str:
    """Absender-IP. Hinter dem DSM-Reverse-Proxy (privates Netz) zählt der
    weitergereichte Kopf, sonst die Verbindung selbst."""
    direkt = request.client.host if request.client else ""
    try:
        privat = ipaddress.ip_address(direkt).is_private
    except ValueError:
        privat = False
    if privat:
        weiter = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or request.headers.get("x-real-ip", "").strip()
        if weiter:
            return weiter[:64]
    return direkt


# ======================================================================
# Kundenseite (öffentlich)
# ======================================================================
def kunde_app(dienst: Dienst) -> FastAPI:
    app = FastAPI(title=f"{PRODUKT} – Kundenseite", docs_url=None, redoc_url=None, openapi_url=None)
    _fehlerbehandlung(app)
    auftraege = dienst.auftraege
    zuletzt_geoeffnet: dict[str, float] = {}
    gesperrt = _gesperrt(auftraege)

    @app.middleware("http")
    async def kopfzeilen(request: Request, weiter: Callable):
        antwort = await weiter(request)
        for k, v in SICHER.items():
            antwort.headers.setdefault(k, v)
        antwort.headers.setdefault("Content-Security-Policy", CSP)
        if request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https":
            antwort.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        return antwort

    def mit_zugang(token: str, z: str | None) -> dict:
        a = auftraege.nach_token(token)
        if a["code_hash"] and not secrets.compare_digest(z or "", dienst.zugang(a)):
            raise AuftragFehler("Bitte zuerst den Zugangscode eingeben.", 403)
        return a

    @app.get("/gesundheit")
    async def gesundheit():
        return PlainTextResponse("ok")

    @app.get("/robots.txt")
    async def robots():
        return PlainTextResponse("User-agent: *\nDisallow: /\n")

    @app.get("/statisch/{name}")
    async def statisch(name: str):
        if name not in ("kunde.js", "kunde.css", "zeichnen.js"):
            return Response(status_code=404)
        return FileResponse(STATISCH / name, headers={"Cache-Control": "no-cache"})

    @app.get("/s/{token}")
    async def seite(token: str):
        auftraege.nach_token(token)  # unbekannte Links gar nicht erst ausliefern
        return FileResponse(STATISCH / "kunde.html", media_type="text/html")

    @app.get("/s/{token}/daten")
    @gesperrt
    def daten(token: str, request: Request, z: str | None = None):
        a = auftraege.nach_token(token)
        kopf = {"titel": a["titel"], "status": a["status"], "code_noetig": bool(a["code_hash"]), "absender": PRODUKT.split()[0]}
        if a["status"] == "unterschrieben":
            return {**kopf, "unterzeichnet": ortszeit(a["unterzeichner"]["zeit"]), "kopie_bis": ortszeit(a["unterzeichner"]["kopie_bis"], False), "sha": a["sha_ergebnis"]}
        if a["status"] not in OFFEN:
            return kopf
        if a["code_hash"] and not secrets.compare_digest(z or "", dienst.zugang(a)):
            if a["code_fehler"] >= MAX_CODE_FEHLER:
                return {**kopf, "status": "gesperrt"}
            return kopf
        ip, geraet = client_ip(request), request.headers.get("user-agent", "")
        schluessel = f"{a['id']}|{ip}|{geraet}"
        if time.time() - zuletzt_geoeffnet.get(schluessel, 0) > 1800:
            zuletzt_geoeffnet[schluessel] = time.time()
            if a["status"] == "offen":
                a["status"] = "geoeffnet"
            auftraege.ereignis(a, "geoeffnet", ip, geraet)
        return {
            **kopf,
            "nachricht": a["nachricht"],
            "gueltig_bis": ortszeit(a["gueltig_bis"], False),
            "name": a["empfaenger"]["name"] or a["hubspot"].get("kontakt_name", ""),
            "seiten": a["seiten"],
            "felder": [{k: f[k] for k in ("id", "seite", "rechteck", "art", "beschriftung", "pflicht")} for f in a["felder"]],
        }

    @app.post("/s/{token}/code")
    @gesperrt
    def code(token: str, request: Request, code: str = Body(..., embed=True)):
        a = auftraege.nach_token(token)
        if a["status"] not in (*OFFEN, "unterschrieben"):
            raise AuftragFehler("Dieser Link kann nicht mehr benutzt werden.", 410)
        if a["code_fehler"] >= MAX_CODE_FEHLER:
            raise AuftragFehler("Zu viele Fehlversuche – bitte melden Sie sich bei uns.", 423)
        ip, geraet = client_ip(request), request.headers.get("user-agent", "")
        if not auftraege.code_pruefen(a, str(code)[:64]):
            a["code_fehler"] += 1
            auftraege.ereignis(a, "code_falsch", ip, geraet)
            if a["code_fehler"] >= MAX_CODE_FEHLER:
                auftraege.ereignis(a, "gesperrt", ip, geraet)
                raise AuftragFehler("Zu viele Fehlversuche – bitte melden Sie sich bei uns.", 423)
            raise AuftragFehler(f"Der Zugangscode stimmt nicht (noch {MAX_CODE_FEHLER - a['code_fehler']} Versuche).", 403)
        auftraege.ereignis(a, "code_ok", ip, geraet)
        return {"zugang": dienst.zugang(a)}

    @app.get("/s/{token}/seite/{nummer}")
    def seitenbild(token: str, nummer: int, breite: int = 1000, z: str | None = None):
        a = mit_zugang(token, z)
        if a["status"] not in OFFEN:
            raise AuftragFehler("Dieser Link kann nicht mehr benutzt werden.", 410)
        png = seite_png(auftraege.pfad(a["id"], "original.pdf"), auftraege.pfad(a["id"], "seiten"), nummer, breite)
        return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=600"})

    @app.post("/s/{token}/unterschreiben")
    def unterschreiben(token: str, request: Request, daten: dict = Body(...)):
        a = mit_zugang(token, str(daten.get("zugang") or ""))
        if a["status"] not in OFFEN:
            raise AuftragFehler("Dieser Link kann nicht mehr benutzt werden.", 410)
        name = " ".join(str(daten.get("name") or "").split())
        if not 2 <= len(name) <= 120:
            raise AuftragFehler("Bitte Ihren vollständigen Namen eingeben.")
        if daten.get("zustimmung") is not True:
            raise AuftragFehler("Bitte bestätigen Sie, dass Sie das Dokument gelesen haben.")
        eingegeben = daten.get("unterschriften") or {}
        unterschriften: dict[str, dict] = {}
        for f in a["felder"]:
            if f["art"] != "unterschrift":
                continue
            u = eingegeben.get(f["id"]) or {}
            if u.get("png"):
                unterschriften[f["id"]] = {"png": png_aus_dataurl(u["png"])}
            elif str(u.get("text") or "").strip():
                unterschriften[f["id"]] = {"text": " ".join(str(u["text"]).split())[:80]}
            elif f["pflicht"]:
                raise AuftragFehler("Bitte alle Unterschriftsfelder ausfüllen.")
        zeit = iso(jetzt())
        ip, geraet = client_ip(request), request.headers.get("user-agent", "")
        with auftraege.sperre:
            a = auftraege.laden(a["id"])
            if a["status"] not in OFFEN:
                raise AuftragFehler("Dieses Dokument wurde bereits unterschrieben.", 409)
            auftraege.ereignis(a, "unterschrieben", ip, geraet, text=f"Name: {name}", speichern=False)
            eingaben = {"name": name, "zeit": zeit, "ip": ip, "geraet": geraet, "unterschriften": unterschriften}
            original = auftraege.pfad(a["id"], "original.pdf").read_bytes()
            if sha256(original) != a["sha_original"]:
                raise AuftragFehler("Das Dokument wurde verändert – bitte melden Sie sich bei uns.", 409)
            pdf = ergebnis_erzeugen(original, a, eingaben)
            auftraege.pfad(a["id"], "ergebnis.pdf").write_bytes(pdf)
            a["status"] = "unterschrieben"
            a["sha_ergebnis"] = sha256(pdf)
            a["unterzeichner"] = {"name": name, "zeit": zeit, "ip": ip, "geraet": geraet, "kopie_bis": iso(aus_iso(zeit) + timedelta(days=KOPIE_TAGE))}
            a["ablage"]["datei"] = auftraege.fertig_ablegen(a, pdf).name
            auftraege.speichern(a)
        print(f"[Sign] {a['id']} unterschrieben von {name}", flush=True)
        dienst.hubspot_im_hintergrund(a["id"], "fertig")
        return {"ok": True, "sha": a["sha_ergebnis"], "unterzeichnet": ortszeit(zeit), "kopie_bis": ortszeit(a["unterzeichner"]["kopie_bis"], False)}

    @app.get("/s/{token}/kopie")
    @gesperrt
    def kopie(token: str, request: Request, z: str | None = None):
        a = mit_zugang(token, z)
        if a["status"] != "unterschrieben":
            raise AuftragFehler("Es gibt noch keine unterschriebene Fassung.", 404)
        if jetzt() > aus_iso(a["unterzeichner"]["kopie_bis"]):
            raise AuftragFehler("Der Download ist abgelaufen – bitte melden Sie sich bei uns.", 410)
        auftraege.ereignis(a, "kopie", client_ip(request), request.headers.get("user-agent", ""))
        name = f"{a['dateiname']} – unterschrieben.pdf"
        return Response(
            auftraege.pfad(a["id"], "ergebnis.pdf").read_bytes(),
            media_type="application/pdf",
            headers={"Content-Disposition": _anhang(name)},
        )

    return app


def _anhang(name: str) -> str:
    from urllib.parse import quote

    einfach = name.encode("ascii", "replace").decode().replace("?", "_").replace('"', "")
    return f"attachment; filename=\"{einfach}\"; filename*=UTF-8''{quote(name)}"


# ======================================================================
# Intern: Einrichtung + Schnittstelle für Ergoforyou PDF
# ======================================================================
def intern_app(dienst: Dienst) -> FastAPI:
    app = FastAPI(title=f"{PRODUKT} – intern", docs_url=None, redoc_url=None, openapi_url=None)
    _fehlerbehandlung(app)
    konfig, auftraege = dienst.konfig, dienst.auftraege
    gesperrt = _gesperrt(auftraege)

    def angemeldet(request: Request) -> bool:
        wert = request.cookies.get("esign_admin", "")
        try:
            ablauf, unterschrift = wert.split(".", 1)
            return int(ablauf) > time.time() and secrets.compare_digest(unterschrift, konfig.signieren(f"admin:{ablauf}"))
        except ValueError:
            return False

    def anmelden(antwort: Response) -> Response:
        ablauf = str(int(time.time()) + SITZUNG_S)
        antwort.set_cookie("esign_admin", f"{ablauf}.{konfig.signieren(f'admin:{ablauf}')}", max_age=SITZUNG_S, httponly=True, samesite="strict")
        return antwort

    @app.middleware("http")
    async def schutz(request: Request, weiter: Callable):
        pfad = request.url.path
        if pfad.startswith("/api/"):
            gesendet = request.headers.get("x-sign-schluessel", "")
            if not secrets.compare_digest(gesendet, konfig.get("schluessel")):
                return JSONResponse({"fehler": "Verbindungsschlüssel ungültig – bitte in Ergoforyou PDF neu verbinden."}, status_code=401)
        elif pfad.startswith("/einrichtung/") and pfad not in ("/einrichtung/zustand", "/einrichtung/anmelden", "/einrichtung/kennwort"):
            if not angemeldet(request):
                return JSONResponse({"fehler": "Bitte anmelden."}, status_code=401)
        antwort = await weiter(request)
        for k, v in SICHER.items():
            antwort.headers.setdefault(k, v)
        return antwort

    # ---------------------------------------------------- Einrichtung
    @app.get("/")
    async def startseite():
        return FileResponse(STATISCH / "einrichtung.html", media_type="text/html", headers={"Content-Security-Policy": CSP})

    @app.get("/statisch/{name}")
    async def statisch(name: str):
        if name not in ("einrichtung.js", "kunde.css"):
            return Response(status_code=404)
        return FileResponse(STATISCH / name, headers={"Cache-Control": "no-cache"})

    @app.get("/einrichtung/zustand")
    async def zustand(request: Request):
        return {"kennwort_gesetzt": bool(konfig.get("kennwort")), "angemeldet": angemeldet(request), "version": __version__}

    @app.post("/einrichtung/kennwort")
    async def kennwort_setzen(kennwort: str = Body(..., embed=True)):
        if konfig.get("kennwort"):
            raise AuftragFehler("Das Einrichtungskennwort ist schon vergeben.", 409)
        if len(kennwort) < 8:
            raise AuftragFehler("Bitte mindestens 8 Zeichen verwenden.")
        konfig.setzen(kennwort=kennwort_hash(kennwort))
        return anmelden(JSONResponse({"ok": True}))

    @app.post("/einrichtung/anmelden")
    def anmelden_route(kennwort: str = Body(..., embed=True)):
        time.sleep(0.5)  # bremst Rateversuche
        if not konfig.get("kennwort") or not kennwort_pruefen(kennwort, konfig.get("kennwort")):
            raise AuftragFehler("Kennwort falsch.", 403)
        return anmelden(JSONResponse({"ok": True}))

    @app.post("/einrichtung/abmelden")
    async def abmelden():
        antwort = JSONResponse({"ok": True})
        antwort.delete_cookie("esign_admin")
        return antwort

    @app.get("/einrichtung/werte")
    async def werte(request: Request):
        token = str(konfig.get("hubspot_token") or "")
        basis = str(request.base_url).rstrip("/")
        code = base64.urlsafe_b64encode(json.dumps({"u": basis, "k": konfig.get("schluessel")}).encode()).decode().rstrip("=")
        return {
            "oeffentliche_adresse": konfig.oeffentliche_adresse,
            "hubspot_verbunden": bool(token),
            "hubspot_token_ende": token[-4:] if token else "",
            "hubspot_portal": konfig.get("hubspot_portal") or "",
            "verbindungscode": f"EFY-SIGN:{code}",
            "intern_adresse": basis,
            "anzahl": len(auftraege.liste()),
            "version": __version__,
        }

    @app.post("/einrichtung/werte")
    def werte_setzen(daten: dict = Body(...)):
        neu: dict[str, Any] = {}
        if "oeffentliche_adresse" in daten:
            adresse = str(daten["oeffentliche_adresse"] or "").strip().rstrip("/")
            if adresse and not adresse.startswith(("https://", "http://")):
                adresse = "https://" + adresse
            neu["oeffentliche_adresse"] = adresse
        if daten.get("hubspot_token") is not None:
            token = str(daten["hubspot_token"]).strip()
            if token:
                with HubSpot(token, dienst.hubspot_transport) as h:
                    info = h.pruefen()
                neu.update(hubspot_token=token, hubspot_portal=info.get("portal") or "", hubspot_domain=info.get("domain") or "")
            else:
                neu.update(hubspot_token="", hubspot_portal="", hubspot_domain="")
        konfig.setzen(**neu)
        return {"ok": True}

    @app.post("/einrichtung/hubspot-test")
    def hubspot_test():
        with dienst.hubspot() as h:
            return {"ok": True, **h.pruefen()}

    @app.post("/einrichtung/adresse-test")
    def adresse_test():
        adresse = konfig.oeffentliche_adresse
        if not adresse:
            raise AuftragFehler("Noch keine öffentliche Adresse eingetragen.")
        try:
            antwort = httpx.get(f"{adresse}/gesundheit", timeout=8)
            ok = antwort.status_code == 200 and antwort.text == "ok"
        except httpx.HTTPError as fehler:
            return {"ok": False, "hinweis": f"Nicht erreichbar ({fehler.__class__.__name__}). Vom NAS selbst klappt das manchmal nicht – bitte zusätzlich am Handy (ohne WLAN) prüfen: {adresse}/gesundheit"}
        return {"ok": ok, "hinweis": "Erreichbar." if ok else f"Antwort {antwort.status_code} – zeigt der Reverse-Proxy auf Port 8480?"}

    @app.post("/einrichtung/schluessel-neu")
    async def schluessel_neu():
        konfig.setzen(schluessel=secrets.token_urlsafe(32))
        return {"ok": True}

    # ------------------------------------------------------ Schnittstelle
    @app.get("/api/status")
    async def status():
        return {
            "version": __version__,
            "hubspot": bool(konfig.get("hubspot_token")),
            "oeffentliche_adresse": konfig.oeffentliche_adresse,
            "bereit": bool(konfig.oeffentliche_adresse),
        }

    @app.post("/api/auftraege")
    def auftrag_anlegen(daten: dict = Body(...)):
        try:
            pdf = base64.b64decode(str(daten.get("pdf") or ""), validate=True)
        except ValueError:
            raise AuftragFehler("PDF fehlt oder ist beschädigt.") from None
        if len(pdf) > 40_000_000:
            raise AuftragFehler("Die PDF ist zu groß (max. 40 MB).")
        seiten = pruefen(pdf)
        felder = felder_pruefen(daten.get("felder") or [], seiten)
        a = auftraege.anlegen(pdf, daten, seiten, felder)
        dienst.hubspot_im_hintergrund(a["id"], "gesendet")
        return _detail(a)

    @app.get("/api/auftraege")
    def auftraege_liste():
        return {"auftraege": auftraege.liste()}

    @app.get("/api/auftraege/{auftrag_id}")
    def auftrag(auftrag_id: str):
        return _detail(auftraege.laden(auftrag_id))

    @app.get("/api/auftraege/{auftrag_id}/pdf")
    def auftrag_pdf(auftrag_id: str, art: str = "ergebnis"):
        a = auftraege.laden(auftrag_id)
        datei = auftraege.pfad(a["id"], "ergebnis.pdf" if art == "ergebnis" else "original.pdf")
        if not datei.exists():
            raise AuftragFehler("Noch nicht unterschrieben.", 404)
        return Response(datei.read_bytes(), media_type="application/pdf")

    @app.post("/api/auftraege/{auftrag_id}/widerrufen")
    @gesperrt
    def widerrufen(auftrag_id: str, von: str = Body("", embed=True)):
        a = auftraege.laden(auftrag_id)
        if a["status"] == "unterschrieben":
            raise AuftragFehler("Bereits unterschrieben – kann nicht mehr zurückgezogen werden.", 409)
        a["status"] = "widerrufen"
        auftraege.ereignis(a, "widerrufen", text=f"von {von or 'Büro'}")
        return _detail(a)

    @app.post("/api/auftraege/{auftrag_id}/entsperren")
    @gesperrt
    def entsperren(auftrag_id: str, von: str = Body("", embed=True)):
        a = auftraege.laden(auftrag_id)
        a["code_fehler"] = 0
        auftraege.ereignis(a, "entsperrt", text=f"von {von or 'Büro'}")
        return _detail(a)

    @app.post("/api/auftraege/{auftrag_id}/hubspot")
    def hubspot_erneut(auftrag_id: str):
        a = auftraege.laden(auftrag_id)
        dienst.hubspot_ablegen(a["id"], "gesendet")
        if a["status"] == "unterschrieben":
            dienst.hubspot_ablegen(a["id"], "fertig")
        return _detail(auftraege.laden(auftrag_id))

    @app.get("/api/hubspot/kontakte")
    def kontakte(q: str = ""):
        q = q.strip()
        if len(q) < 2:
            return {"kontakte": []}
        with dienst.hubspot() as h:
            return {"kontakte": h.kontakte_suchen(q)}

    @app.get("/api/hubspot/kontakte/{kontakt_id}/deals")
    def deals(kontakt_id: str):
        if not kontakt_id.isdigit():
            raise AuftragFehler("Unbekannter Kontakt.", 404)
        with dienst.hubspot() as h:
            return {"deals": h.deals(kontakt_id)}

    def _detail(a: dict) -> dict:
        d = zusammenfassung(a)
        d.update(
            link=link(konfig.oeffentliche_adresse, a),
            felder=a["felder"],
            seiten=len(a["seiten"]),
            verlauf=a["verlauf"],
            sha_original=a["sha_original"],
            sha_ergebnis=a["sha_ergebnis"],
            code_gesperrt=a["code_fehler"] >= MAX_CODE_FEHLER,
            hubspot_url=dienst.hubspot_kontakt_url(a["hubspot"].get("kontakt_id", "")),
        )
        return d

    return app
