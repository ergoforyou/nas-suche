# PyInstaller-Bauplan für Agentur-PDF (Windows, Ordner-Variante).
# Aufruf (aus agentur-pdf/installer):  pyinstaller agentur_pdf.spec --noconfirm
# Ergebnis: dist/Agentur-PDF/Agentur-PDF.exe – Tesseract, Modelle und LibreOffice
# werden danach vom Workflow daneben kopiert (siehe bausteine_windows.ps1).

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

HIER = Path(SPECPATH)
DIENST = HIER.parent / "dienst"
OBERFLAECHE = HIER.parent / "oberflaeche" / "dist"

datas = [(str(OBERFLAECHE), "oberflaeche")]
binaries = []
hiddenimports = collect_submodules("uvicorn") + collect_submodules("agentur_pdf")
import importlib.util
import sys

for paket in ("pymupdf", "webview", "pillow_heif", "spylls", "cv2"):
    if importlib.util.find_spec(paket) is None:
        if sys.platform == "win32":
            raise SystemExit(f"Paket fehlt: {paket}")
        print(f"Hinweis: {paket} fehlt (nur unter Windows Pflicht)")
        continue
    d, b, h = collect_all(paket)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [str(HIER / "start.py")],
    pathex=[str(DIENST)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    # tkinter wird für die Bereichsauswahl des Screenshot-Werkzeugs gebraucht
    excludes=["matplotlib", "pytest", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Agentur-PDF",
    console=False,  # Fensterprogramm – Fehler landen im Protokoll + Meldungsfenster
    icon=str(HIER / "agentur-pdf.ico") if (HIER / "agentur-pdf.ico").exists() else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Agentur-PDF")
