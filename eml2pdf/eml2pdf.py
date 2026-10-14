"""
eml2pdf - wandelt E-Mails (.eml) samt Anlagen in PDF-Dateien um.

Aufruf:
    eml2pdf.py DATEI.eml [DATEI2.eml ...]   einzelne Dateien umwandeln (Rechtsklick)
    eml2pdf.py --ueberwachen [ORDNER]       Ordner (Standard: Downloads) dauerhaft
                                            beobachten und neue .eml automatisch umwandeln
Optionen:
    --ziel ORDNER     Ausgabeordner (Standard: Ordner, in dem die .eml liegt)
    --alle            beim Überwachen auch bereits vorhandene .eml umwandeln

Ergebnis pro E-Mail:
    "JJJJ-MM-TT Betreff.pdf"                  die E-Mail selbst
    "JJJJ-MM-TT Betreff - Anlage NAME.pdf"    jede Anlage als PDF
Anlagen, die sich nicht umwandeln lassen (z. B. ZIP), werden im Original daneben abgelegt.
"""

import base64
import ctypes
import datetime as dt
import email
import email.policy
import email.utils
import html
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

IS_WINDOWS = os.name == "nt"

if IS_WINDOWS:
    DATA_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "eml2pdf"
else:
    DATA_DIR = Path.home() / ".eml2pdf"
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = DATA_DIR / "erledigt.json"
LOG_FILE = DATA_DIR / "eml2pdf.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8")]
    + ([logging.StreamHandler()] if sys.stderr and sys.stderr.isatty() else []),
)
log = logging.getLogger("eml2pdf")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp"}
BROWSER_EXT = {".txt", ".htm", ".html", ".csv", ".log", ".xml", ".json", ".svg"}
WORD_EXT = {".doc", ".docx", ".docm", ".rtf", ".odt"}
EXCEL_EXT = {".xls", ".xlsx", ".xlsm", ".ods"}
POWERPOINT_EXT = {".ppt", ".pptx", ".odp"}


# --------------------------------------------------------------------------- Hilfen

def downloads_folder() -> Path:
    """Echten Downloads-Ordner ermitteln (auch wenn er verschoben wurde)."""
    if IS_WINDOWS:
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
            )
            value, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            return Path(os.path.expandvars(value))
        except OSError:
            pass
    return Path.home() / "Downloads"


def safe_name(text: str, max_len: int = 120) -> str:
    text = re.sub(r":", " -", text or "")
    text = re.sub(r"[/\\|]", "-", text)
    text = re.sub(r'[<>"?*\x00-\x1f]', "", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return (text[:max_len].rstrip(" .") or "ohne Betreff")


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    n = 2
    while True:
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def show_message(text: str, title: str = "EML zu PDF") -> None:
    if IS_WINDOWS:
        try:
            ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
            return
        except Exception:
            pass
    print(text)


# --------------------------------------------------------------------------- PDF-Erzeugung

def find_browser() -> str | None:
    """Edge oder Chrome finden – damit wird HTML in PDF gedruckt."""
    env = os.environ.get("EML2PDF_BROWSER")
    if env and Path(env).exists():
        return env
    candidates = []
    if IS_WINDOWS:
        for base in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"),
                     os.environ.get("LOCALAPPDATA")):
            if base:
                candidates += [
                    Path(base) / "Microsoft/Edge/Application/msedge.exe",
                    Path(base) / "Google/Chrome/Application/chrome.exe",
                ]
    for c in candidates:
        if c.exists():
            return str(c)
    for name in ("msedge", "google-chrome", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def html_to_pdf(html_file: Path, pdf_file: Path) -> None:
    browser = find_browser()
    if not browser:
        raise RuntimeError("Weder Microsoft Edge noch Google Chrome gefunden.")
    with tempfile.TemporaryDirectory() as profile:
        cmd = [
            browser, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-extensions",
            f"--user-data-dir={profile}", "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw", "--virtual-time-budget=10000",
            f"--print-to-pdf={pdf_file}", html_file.resolve().as_uri(),
        ]
        if not IS_WINDOWS and os.geteuid() == 0:
            cmd.insert(1, "--no-sandbox")
        flags = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=120, creationflags=flags)
    if not pdf_file.exists() or pdf_file.stat().st_size == 0:
        raise RuntimeError(f"Browser konnte kein PDF erzeugen: {html_file.name}")


def image_to_pdf(src: Path, pdf_file: Path) -> None:
    from PIL import Image, ImageSequence
    with Image.open(src) as img:
        frames = [f.convert("RGB") for f in ImageSequence.Iterator(img)]
        if img.format == "GIF":
            frames = frames[:1]
    frames[0].save(pdf_file, "PDF", resolution=150, save_all=True, append_images=frames[1:])


def office_to_pdf(src: Path, pdf_file: Path) -> None:
    ext = src.suffix.lower()
    if IS_WINDOWS:
        try:
            _ms_office_to_pdf(src, pdf_file, ext)
            if pdf_file.exists():
                return
        except Exception as exc:
            log.info("MS Office nicht nutzbar (%s), versuche LibreOffice", exc)
    _libreoffice_to_pdf(src, pdf_file)


def _ms_office_to_pdf(src: Path, pdf_file: Path, ext: str) -> None:
    import win32com.client  # aus pywin32
    s, d = str(src.resolve()), str(pdf_file.resolve())
    if ext in WORD_EXT:
        app = win32com.client.DispatchEx("Word.Application")
        app.Visible = False
        app.DisplayAlerts = 0
        try:
            doc = app.Documents.Open(s, ReadOnly=True, AddToRecentFiles=False)
            doc.ExportAsFixedFormat(d, 17)  # wdExportFormatPDF
            doc.Close(False)
        finally:
            app.Quit()
    elif ext in EXCEL_EXT:
        app = win32com.client.DispatchEx("Excel.Application")
        app.Visible = False
        app.DisplayAlerts = False
        try:
            wb = app.Workbooks.Open(s, ReadOnly=True)
            wb.ExportAsFixedFormat(0, d)  # xlTypePDF
            wb.Close(False)
        finally:
            app.Quit()
    elif ext in POWERPOINT_EXT:
        app = win32com.client.DispatchEx("PowerPoint.Application")
        try:
            pres = app.Presentations.Open(s, ReadOnly=True, WithWindow=False)
            pres.SaveAs(d, 32)  # ppSaveAsPDF
            pres.Close()
        finally:
            app.Quit()


def _libreoffice_to_pdf(src: Path, pdf_file: Path) -> None:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice and IS_WINDOWS:
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)")):
            c = Path(base or "") / "LibreOffice/program/soffice.exe"
            if base and c.exists():
                soffice = str(c)
    if not soffice:
        raise RuntimeError("Weder Microsoft Office noch LibreOffice gefunden.")
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            [soffice, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless",
             "--convert-to", "pdf", "--outdir", out, str(src)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180,
            creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0,
        )
        produced = Path(out) / (src.stem + ".pdf")
        if not produced.exists():
            raise RuntimeError("LibreOffice konnte die Datei nicht umwandeln.")
        shutil.move(str(produced), pdf_file)


# --------------------------------------------------------------------------- E-Mail lesen

def decode_text(part) -> str:
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        for cs in (part.get_content_charset(), "utf-8", "cp1252"):
            try:
                return payload.decode(cs or "utf-8")
            except (LookupError, UnicodeDecodeError):
                continue
        return payload.decode("latin-1", errors="replace")


def leaf_parts(msg):
    """Alle Einzelteile der Mail – ohne in angehängte E-Mails hineinzugehen."""
    if msg.is_multipart() and msg.get_content_type() != "message/rfc822":
        for sub in msg.get_payload():
            yield from leaf_parts(sub)
    else:
        yield msg


def split_message(msg):
    """Liefert (html_body, text_body, inline_bilder{cid: part}, anlagen[part])."""
    html_body = text_body = None
    inline, attachments = {}, []
    for part in leaf_parts(msg):
        ctype = part.get_content_type()
        disp = part.get_content_disposition()
        filename = part.get_filename()
        cid = (part.get("Content-ID") or "").strip().strip("<>")

        if ctype == "message/rfc822":
            attachments.append(part)
        elif disp != "attachment" and not filename and ctype == "text/html" and html_body is None:
            html_body = decode_text(part)
        elif disp != "attachment" and not filename and ctype == "text/plain" and text_body is None:
            text_body = decode_text(part)
        elif cid and ctype.startswith("image/") and disp != "attachment":
            inline[cid] = part
        elif filename or disp == "attachment" or not ctype.startswith(("text/", "multipart/")):
            attachments.append(part)
        if cid and ctype.startswith("image/"):
            inline.setdefault(cid, part)
    # Inline-Bilder, die im Text gar nicht vorkommen, als normale Anlage behandeln
    for cid, part in list(inline.items()):
        if not html_body or f"cid:{cid}".lower() not in html_body.lower():
            del inline[cid]
            if part not in attachments:
                attachments.append(part)
    return html_body, text_body, inline, attachments


def attachment_name(part, index: int) -> str:
    name = part.get_filename()
    if not name and part.get_content_type() == "message/rfc822":
        inner = part.get_payload()[0] if part.is_multipart() else None
        subj = inner.get("Subject", "") if inner is not None else ""
        name = f"{subj or 'Weitergeleitete E-Mail'}.eml"
    if not name:
        ext = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png"}.get(
            part.get_content_type(), ".bin")
        name = f"Anlage {index}{ext}"
    return name


def attachment_bytes(part) -> bytes:
    if part.get_content_type() == "message/rfc822":
        inner = part.get_payload()[0] if part.is_multipart() else part.get_payload()
        return inner.as_bytes(policy=email.policy.default)
    return part.get_payload(decode=True) or b""


def mail_date(msg) -> dt.datetime | None:
    try:
        d = email.utils.parsedate_to_datetime(str(msg.get("Date", "")))
        return d.astimezone() if d.tzinfo else d
    except Exception:
        return None


# --------------------------------------------------------------------------- HTML der Mail

CSS = """
@page { size: A4; margin: 15mm; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #000; }
.kopf { border-bottom: 2px solid #444; margin-bottom: 14px; padding-bottom: 8px; }
.kopf h1 { font-size: 15pt; margin: 0 0 8px 0; }
.kopf table { border-collapse: collapse; font-size: 10pt; }
.kopf td { padding: 1px 10px 1px 0; vertical-align: top; }
.kopf td.l { font-weight: bold; white-space: nowrap; }
pre.text { white-space: pre-wrap; word-wrap: break-word; font-family: Consolas, monospace; font-size: 10pt; }
.inhalt img { max-width: 100%; height: auto; }
.inhalt table { max-width: 100% !important; }
"""


def build_mail_html(msg, html_body, text_body, inline, attachment_names) -> str:
    def h(name):
        return html.escape(str(msg.get(name, "") or ""))

    d = mail_date(msg)
    rows = [("Von", h("From")), ("An", h("To"))]
    if msg.get("Cc"):
        rows.append(("Cc", h("Cc")))
    rows.append(("Datum", d.strftime("%d.%m.%Y %H:%M") if d else h("Date")))
    if attachment_names:
        rows.append(("Anlagen", html.escape(", ".join(attachment_names))))
    header = "".join(f'<tr><td class="l">{k}:</td><td>{v}</td></tr>' for k, v in rows)

    if html_body:
        body = html_body
        for cid, part in inline.items():
            data = base64.b64encode(part.get_payload(decode=True) or b"").decode()
            uri = f"data:{part.get_content_type()};base64,{data}"
            body = re.sub(rf"cid:{re.escape(cid)}", uri, body, flags=re.I)
        # Eigenes <html>/<head> der Mail entfernen, Stil-Angaben behalten
        body = re.sub(r"(?is)<!DOCTYPE[^>]*>|</?html[^>]*>|</?body[^>]*>|<meta[^>]*>", "", body)
        content = f'<div class="inhalt">{body}</div>'
    else:
        content = f'<pre class="text">{html.escape(text_body or "")}</pre>'

    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        f"<title>{h('Subject')}</title><style>{CSS}</style></head><body>"
        f'<div class="kopf"><h1>{h("Subject") or "(ohne Betreff)"}</h1>'
        f"<table>{header}</table></div>{content}</body></html>"
    )


# --------------------------------------------------------------------------- Umwandlung

def convert_attachment(src: Path, pdf_file: Path) -> bool:
    """Wandelt eine Anlage in PDF. True bei Erfolg."""
    ext = src.suffix.lower()
    if ext == ".pdf":
        shutil.copyfile(src, pdf_file)
    elif ext in IMAGE_EXT:
        image_to_pdf(src, pdf_file)
    elif ext in BROWSER_EXT:
        html_to_pdf(src, pdf_file)
    elif ext in WORD_EXT | EXCEL_EXT | POWERPOINT_EXT:
        office_to_pdf(src, pdf_file)
    else:
        return False
    return True


def convert_eml(eml_path: Path, out_dir: Path | None = None, prefix: str = "") -> list[Path]:
    """Wandelt eine .eml-Datei um und gibt die erzeugten Dateien zurück."""
    eml_path = Path(eml_path)
    out_dir = Path(out_dir) if out_dir else eml_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(eml_path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)

    html_body, text_body, inline, attachments = split_message(msg)
    names = [attachment_name(p, i) for i, p in enumerate(attachments, 1)]

    d = mail_date(msg)
    subject = str(msg.get("Subject", "") or "") or eml_path.stem
    base = prefix or safe_name(f"{d:%Y-%m-%d} {subject}" if d else subject)
    created = []

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        html_file = tmp / "mail.html"
        html_file.write_text(build_mail_html(msg, html_body, text_body, inline, names),
                             encoding="utf-8")
        mail_pdf = unique_path(out_dir / f"{base}.pdf")
        html_to_pdf(html_file, mail_pdf)
        created.append(mail_pdf)
        log.info("E-Mail -> %s", mail_pdf)

        for i, (part, name) in enumerate(zip(attachments, names), 1):
            name = safe_name(name, 100)
            src = tmp / f"anlage{i}{Path(name).suffix}"
            src.write_bytes(attachment_bytes(part))
            stem = f"{base} - Anlage {Path(name).stem}"
            try:
                if src.suffix.lower() == ".eml":
                    created += convert_eml(src, out_dir, prefix=safe_name(stem, 150))
                    continue
                pdf = unique_path(out_dir / f"{stem}.pdf")
                if convert_attachment(src, pdf):
                    created.append(pdf)
                    log.info("Anlage -> %s", pdf)
                    continue
            except Exception as exc:
                log.warning("Anlage %s nicht umwandelbar: %s", name, exc)
            # Nicht umwandelbar: Original ablegen, damit nichts verloren geht
            orig = unique_path(out_dir / f"{base} - Anlage {name}")
            shutil.copyfile(src, orig)
            created.append(orig)
            log.info("Anlage im Original abgelegt -> %s", orig)
    return created


# --------------------------------------------------------------------------- Überwachung

def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")


def fingerprint(p: Path) -> str:
    st = p.stat()
    return f"{st.st_size}:{int(st.st_mtime)}"


def watch(folder: Path, out_dir: Path | None, include_existing: bool, interval: float = 3.0):
    log.info("Überwache %s", folder)
    state = load_state()
    first_run = not STATE_FILE.exists()
    if first_run and not include_existing:
        for p in folder.glob("*.eml"):
            state[str(p)] = fingerprint(p)
        save_state(state)

    sizes: dict[str, int] = {}
    while True:
        try:
            for p in folder.glob("*.eml"):
                key = str(p)
                try:
                    fp = fingerprint(p)
                except OSError:
                    continue
                if state.get(key) == fp:
                    continue
                # Warten bis der Download fertig ist (Größe zweimal gleich)
                size = p.stat().st_size
                if sizes.get(key) != size or size == 0:
                    sizes[key] = size
                    continue
                sizes.pop(key, None)
                try:
                    convert_eml(p, out_dir)
                except Exception:
                    log.exception("Fehler bei %s", p)
                state[key] = fp
                save_state(state)
        except Exception:
            log.exception("Fehler in der Überwachung")
        time.sleep(interval)


# --------------------------------------------------------------------------- Start

def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="E-Mails (.eml) samt Anlagen in PDF umwandeln")
    ap.add_argument("dateien", nargs="*", help=".eml-Dateien")
    ap.add_argument("--ueberwachen", nargs="?", const="", metavar="ORDNER",
                    help="Ordner beobachten (Standard: Downloads)")
    ap.add_argument("--ziel", help="Ausgabeordner (Standard: Ordner der .eml)")
    ap.add_argument("--alle", action="store_true",
                    help="beim Überwachen auch schon vorhandene .eml umwandeln")
    ap.add_argument("--still", action="store_true", help="keine Meldungsfenster anzeigen")
    args = ap.parse_args(argv)
    out_dir = Path(args.ziel) if args.ziel else None

    if args.ueberwachen is not None:
        folder = Path(args.ueberwachen) if args.ueberwachen else downloads_folder()
        watch(folder, out_dir, args.alle)
        return 0

    if not args.dateien:
        ap.print_help()
        return 1

    created, errors = [], []
    for f in args.dateien:
        try:
            created += convert_eml(Path(f), out_dir)
        except Exception as exc:
            log.exception("Fehler bei %s", f)
            errors.append(f"{Path(f).name}: {exc}")
    if not args.still:
        text = f"{len(created)} Datei(en) erstellt in:\n{(out_dir or Path(args.dateien[0]).parent)}"
        if errors:
            text += "\n\nFehler:\n" + "\n".join(errors)
        show_message(text)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
