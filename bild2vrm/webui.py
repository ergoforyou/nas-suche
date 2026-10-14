"""Lokale Web-Oberfläche (nur 127.0.0.1, keine Internetverbindung nötig)."""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from .avatar import Options, analyze, cutout_preview, generate

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD = 60 * 1024 * 1024


def _decode_image(data_url: str) -> Image.Image:
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    img.load()
    return img


def _options(d: dict) -> Options:
    o = Options()
    o.height = float(d.get("height", o.height))
    o.vrm_version = "1" if str(d.get("vrm_version", "0")) == "1" else "0"
    o.tpose = bool(d.get("tpose", True))
    o.depth = float(d.get("depth", o.depth))
    o.grid = int(d.get("grid", o.grid))
    o.background = str(d.get("background", o.background))
    o.pose = str(d.get("pose", o.pose))
    o.name = str(d.get("name") or o.name)
    o.author = str(d.get("author") or o.author)
    return o


class Handler(BaseHTTPRequestHandler):
    server_version = "bild2vrm"

    def log_message(self, fmt, *args):  # quieter console
        pass

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_UPLOAD:
            return self._json(413, {"error": "Bild zu groß (max. 60 MB)."})
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
            img = _decode_image(data["image"])
            opts = _options(data.get("options", {}))
            if self.path == "/api/analyze":
                mask, kp = analyze(img, opts)
                buf = io.BytesIO()
                prev = cutout_preview(img, mask)
                prev.thumbnail((900, 900))
                prev.save(buf, format="PNG")
                return self._json(200, {
                    "width": img.width, "height": img.height, "keypoints": kp,
                    "cutout": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
                })
            if self.path == "/api/generate":
                res = generate(img, opts, data.get("keypoints"))
                return self._send(200, res.vrm, "application/octet-stream",
                                  {"X-Stats": json.dumps(res.stats)})
            return self._json(404, {"error": "unbekannter Endpunkt"})
        except (ValueError, RuntimeError, KeyError) as exc:
            return self._json(400, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            return self._json(500, {"error": f"Interner Fehler: {exc}"})


def serve(port: int = 8765, open_browser: bool = True) -> None:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"bild2vrm läuft auf {url}  (Beenden mit Strg+C)")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")
    finally:
        httpd.server_close()
