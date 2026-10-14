"""Screenshot-Werkzeug für Windows: globales Tastenkürzel, Bereich aufziehen,
Bild + Text in die Zwischenablage.

Ablauf: Ein eigener Thread meldet das Tastenkürzel bei Windows an
(RegisterHotKey) und wartet auf WM_HOTKEY. Beim Drücken wird der ganze
Bildschirm (alle Monitore) fotografiert und als abgedunkeltes Vollbild
angezeigt; der Benutzer zieht den gewünschten Bereich auf (Esc bricht ab,
Enter/Doppelklick = ganzer Bildschirm). Das Ergebnis geht an
``verarbeiten`` (PNG + PDF mit Texterkennung im zentralen Ordner).
"""

from __future__ import annotations

import ctypes
import io
import logging
import threading
from ctypes import wintypes
from typing import Callable

log = logging.getLogger(__name__)

WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, MOD_NOREPEAT = 0x1, 0x2, 0x4, 0x8, 0x4000

_MODIFIKATOREN = {
    "strg": MOD_CONTROL,
    "ctrl": MOD_CONTROL,
    "umschalt": MOD_SHIFT,
    "shift": MOD_SHIFT,
    "alt": MOD_ALT,
    "win": MOD_WIN,
}
_TASTEN = {"druck": 0x2C, "print": 0x2C, "pos1": 0x24, "ende": 0x23, "einfg": 0x2D, "pause": 0x13, "leertaste": 0x20}


class TastenFehler(ValueError):
    pass


def taste_parsen(text: str) -> tuple[int, int]:
    """„Strg+Umschalt+Druck“ → (Modifikatoren, virtueller Tastencode)."""
    teile = [t.strip().lower() for t in text.replace("-", "+").split("+") if t.strip()]
    if not teile:
        raise TastenFehler("Kein Tastenkürzel angegeben.")
    mods = 0
    for t in teile[:-1]:
        if t not in _MODIFIKATOREN:
            raise TastenFehler(f"Unbekannte Zusatztaste: {t}")
        mods |= _MODIFIKATOREN[t]
    taste = teile[-1]
    if taste in _TASTEN:
        vk = _TASTEN[taste]
    elif len(taste) == 1 and taste.isalnum():
        vk = ord(taste.upper())
    elif taste.startswith("f") and taste[1:].isdigit() and 1 <= int(taste[1:]) <= 24:
        vk = 0x6F + int(taste[1:])
    else:
        raise TastenFehler(f"Unbekannte Taste: {taste}")
    if not mods and vk != 0x2C:
        raise TastenFehler("Bitte mit Strg, Alt oder Umschalt kombinieren.")
    return mods, vk


class Tastenkuerzel:
    """Meldet ein globales Tastenkürzel an und ruft ``ausloesen`` im eigenen Thread auf."""

    def __init__(self, text: str, ausloesen: Callable[[], None]) -> None:
        self.text = text
        self.mods, self.vk = taste_parsen(text)
        self._ausloesen = ausloesen
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self.fehler: str | None = None
        self._bereit = threading.Event()

    def starten(self) -> bool:
        self._thread = threading.Thread(target=self._schleife, name="screenshot-taste", daemon=True)
        self._thread.start()
        self._bereit.wait(3)
        return self.fehler is None

    def stoppen(self) -> None:
        if self._thread_id:
            ctypes.windll.user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self._thread:
            self._thread.join(2)

    def _schleife(self) -> None:
        user32 = ctypes.windll.user32
        self._thread_id = ctypes.windll.kernel32.GetCurrentThreadId()
        if not user32.RegisterHotKey(None, 1, self.mods | MOD_NOREPEAT, self.vk):
            self.fehler = f"Das Tastenkürzel „{self.text}“ ist schon von einem anderen Programm belegt."
            log.warning(self.fehler)
            self._bereit.set()
            return
        self._bereit.set()
        nachricht = wintypes.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(nachricht), None, 0, 0) > 0:
                if nachricht.message == WM_HOTKEY:
                    try:
                        self._ausloesen()
                    except Exception:  # noqa: BLE001 – Werkzeug darf nie abstürzen
                        log.exception("Screenshot fehlgeschlagen")
        finally:
            user32.UnregisterHotKey(None, 1)


# ------------------------------------------------------------ Bereich wählen
def _virtueller_bildschirm() -> tuple[int, int, int, int]:
    m = ctypes.windll.user32.GetSystemMetrics
    return m(76), m(77), m(78), m(79)  # SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN


def bereich_waehlen():
    """Ganzen Bildschirm fotografieren und Bereich aufziehen lassen.
    Ergebnis: PIL-Bild oder None (abgebrochen)."""
    import tkinter as tk

    from PIL import Image, ImageEnhance, ImageGrab, ImageTk

    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass
    x0, y0, breite, hoehe = _virtueller_bildschirm()
    foto = ImageGrab.grab(all_screens=True)
    if foto.size != (breite, hoehe):
        breite, hoehe = foto.size
    dunkel = ImageEnhance.Brightness(foto).enhance(0.55)

    ergebnis: dict = {"bild": None}
    fenster = tk.Tk()
    fenster.overrideredirect(True)
    fenster.attributes("-topmost", True)
    fenster.geometry(f"{breite}x{hoehe}{x0:+d}{y0:+d}")
    fenster.configure(cursor="crosshair")
    flaeche = tk.Canvas(fenster, width=breite, height=hoehe, highlightthickness=0, bd=0)
    flaeche.pack()
    hintergrund = ImageTk.PhotoImage(dunkel)
    flaeche.create_image(0, 0, image=hintergrund, anchor="nw")
    hinweis = flaeche.create_text(
        -x0 + ctypes.windll.user32.GetSystemMetrics(0) // 2,  # Mitte des Hauptbildschirms
        -y0 + 40,
        text="Bereich aufziehen · Enter = ganzer Bildschirm · Esc = abbrechen",
        fill="white",
        font=("Segoe UI", 14, "bold"),
    )
    zustand: dict = {"start": None, "rahmen": None, "hell": None, "masse": None, "hell_bild": None}

    def beenden(bild=None) -> None:
        ergebnis["bild"] = bild
        fenster.destroy()

    def druecken(e) -> None:
        zustand["start"] = (e.x, e.y)

    def ziehen(e) -> None:
        if not zustand["start"]:
            return
        sx, sy = zustand["start"]
        a, b = (min(sx, e.x), min(sy, e.y)), (max(sx, e.x), max(sy, e.y))
        for schluessel in ("rahmen", "hell", "masse"):
            if zustand[schluessel]:
                flaeche.delete(zustand[schluessel])
        if b[0] - a[0] > 2 and b[1] - a[1] > 2:
            zustand["hell_bild"] = ImageTk.PhotoImage(foto.crop((*a, *b)))
            zustand["hell"] = flaeche.create_image(a[0], a[1], image=zustand["hell_bild"], anchor="nw")
        zustand["rahmen"] = flaeche.create_rectangle(*a, *b, outline="#ff3b30", width=2)
        zustand["masse"] = flaeche.create_text(
            b[0], b[1] + 14, text=f"{b[0] - a[0]} × {b[1] - a[1]}", fill="white", anchor="ne", font=("Segoe UI", 10)
        )
        flaeche.itemconfigure(hinweis, state="hidden")

    def loslassen(e) -> None:
        if not zustand["start"]:
            return
        sx, sy = zustand["start"]
        a, b = (min(sx, e.x), min(sy, e.y)), (max(sx, e.x), max(sy, e.y))
        if b[0] - a[0] < 4 or b[1] - a[1] < 4:
            zustand["start"] = None
            return
        beenden(foto.crop((*a, *b)))

    flaeche.bind("<ButtonPress-1>", druecken)
    flaeche.bind("<B1-Motion>", ziehen)
    flaeche.bind("<ButtonRelease-1>", loslassen)
    flaeche.bind("<Double-Button-1>", lambda e: beenden(foto))
    fenster.bind("<Escape>", lambda e: beenden(None))
    fenster.bind("<Return>", lambda e: beenden(foto))
    fenster.after(50, lambda: (fenster.focus_force(), fenster.lift()))
    fenster.mainloop()
    bild = ergebnis["bild"]
    if bild is None:
        return None
    return bild if isinstance(bild, Image.Image) else None


def als_png(bild) -> bytes:
    puffer = io.BytesIO()
    bild.save(puffer, "PNG", optimize=True)
    return puffer.getvalue()


# ------------------------------------------------------------ Zwischenablage
CF_UNICODETEXT = 13
CF_DIB = 8
GMEM_MOVEABLE = 0x0002


def _zwischenablage_setzen(formate: list[tuple[int, bytes]]) -> bool:
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    for _ in range(10):  # Zwischenablage kann kurz von anderen Programmen belegt sein
        if user32.OpenClipboard(None):
            break
        threading.Event().wait(0.05)
    else:
        return False
    try:
        user32.EmptyClipboard()
        for format_, daten in formate:
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(daten))
            ziel = kernel32.GlobalLock(handle)
            ctypes.memmove(ziel, daten, len(daten))
            kernel32.GlobalUnlock(handle)
            user32.SetClipboardData(format_, handle)
        return True
    finally:
        user32.CloseClipboard()


def zwischenablage(bild=None, text: str | None = None) -> bool:
    """Bild (als DIB) und/oder Text in die Windows-Zwischenablage legen."""
    formate: list[tuple[int, bytes]] = []
    if bild is not None:
        puffer = io.BytesIO()
        bild.convert("RGB").save(puffer, "BMP")
        formate.append((CF_DIB, puffer.getvalue()[14:]))  # BMP ohne Dateikopf = DIB
    if text:
        formate.append((CF_UNICODETEXT, (text + "\0").encode("utf-16-le")))
    return bool(formate) and _zwischenablage_setzen(formate)


# ----------------------------------------------------------------- Steuerung
class Steuerung:
    """Hält das Tastenkürzel passend zu den Einstellungen und führt die
    Aufnahme aus (auch auf Knopfdruck aus der Oberfläche)."""

    def __init__(self, einstellungen: Callable[[], dict], verarbeiten: Callable[[bytes], dict],
                 vorher: Callable[[], None] = lambda: None, nachher: Callable[[], None] = lambda: None) -> None:
        self._einstellungen = einstellungen
        self._verarbeiten = verarbeiten
        self._vorher = vorher
        self._nachher = nachher
        self._taste: Tastenkuerzel | None = None
        self._sperre = threading.Lock()
        self.fehler: str | None = None

    def status(self) -> dict:
        e = self._einstellungen()
        return {
            "verfuegbar": True,
            "aktiv": bool(self._taste and not self._taste.fehler),
            "taste": e.get("screenshot_taste", ""),
            "fehler": self.fehler,
        }

    def neu_starten(self) -> None:
        if self._taste:
            self._taste.stoppen()
            self._taste = None
        self.fehler = None
        e = self._einstellungen()
        if not e.get("screenshot_aktiv", True):
            return
        try:
            self._taste = Tastenkuerzel(e.get("screenshot_taste") or "Strg+Umschalt+Druck", lambda: self.aufnehmen(von_taste=True))
        except TastenFehler as fehler:
            self.fehler = str(fehler)
            return
        if not self._taste.starten():
            self.fehler = self._taste.fehler

    def aufnehmen(self, von_taste: bool = False) -> dict | None:
        if not self._sperre.acquire(blocking=False):
            return None  # läuft schon
        try:
            if not von_taste:
                self._vorher()  # eigenes Fenster aus dem Weg
                threading.Event().wait(0.35)
            try:
                bild = bereich_waehlen()
            finally:
                if not von_taste:
                    self._nachher()
            if bild is None:
                return None
            e = self._einstellungen()
            if e.get("screenshot_bild_kopieren", True):
                zwischenablage(bild=bild)
            ergebnis = self._verarbeiten(als_png(bild))
            if e.get("screenshot_text_kopieren") and ergebnis.get("text"):
                zwischenablage(bild=bild if e.get("screenshot_bild_kopieren", True) else None, text=ergebnis["text"])
            return ergebnis
        finally:
            self._sperre.release()
