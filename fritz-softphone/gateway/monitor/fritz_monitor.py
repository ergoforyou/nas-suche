#!/usr/bin/env python3
"""Liest den FRITZ!Box-Callmonitor (TCP 1012) und stellt den Zustand der
Nebenstellen per HTTP/Server-Sent-Events für die Chrome-Erweiterung bereit.

Einmalig an einem an der FRITZ!Box angeschlossenen Telefon #96*5* wählen,
damit der Callmonitor aktiv ist.

  GET /state   -> aktueller Zustand als JSON
  GET /events  -> Server-Sent Events, bei jeder Änderung ein "state"-Event
"""
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

FRITZ = os.environ.get("FRITZBOX_HOST", "192.168.178.1")
CM_PORT = int(os.environ.get("CALLMONITOR_PORT", "1012"))
HTTP_PORT = int(os.environ.get("MONITOR_PORT", "8089"))
TOKEN = os.environ.get("MONITOR_TOKEN", "")

lock = threading.Condition()
state = {"connected": False, "calls": {}, "version": 0, "error": ""}


def bump():
    state["version"] += 1
    lock.notify_all()


def handle_line(line):
    # Formate (AVM):
    # datum;RING;ConnID;Anrufer;Angerufen;SIPx;
    # datum;CALL;ConnID;Nebenstelle;EigeneNr;Ziel;SIPx;
    # datum;CONNECT;ConnID;Nebenstelle;Nummer;
    # datum;DISCONNECT;ConnID;Dauer;
    p = line.strip().split(";")
    if len(p) < 4:
        return
    kind, cid = p[1], p[2]
    now = int(time.time() * 1000)
    with lock:
        calls = state["calls"]
        if kind == "RING":
            calls[cid] = {"id": cid, "state": "ringing", "direction": "in",
                          "remote": p[3], "own": p[4] if len(p) > 4 else "", "ext": None, "since": now}
        elif kind == "CALL":
            calls[cid] = {"id": cid, "state": "dialing", "direction": "out",
                          "remote": p[5] if len(p) > 5 else "", "own": p[4] if len(p) > 4 else "",
                          "ext": p[3], "since": now}
        elif kind == "CONNECT":
            c = calls.setdefault(cid, {"id": cid, "direction": "in", "remote": p[4] if len(p) > 4 else "", "own": ""})
            c.update({"state": "connected", "ext": p[3], "since": now})
        elif kind == "DISCONNECT":
            calls.pop(cid, None)
        else:
            return
        bump()


def monitor_loop():
    while True:
        try:
            with socket.create_connection((FRITZ, CM_PORT), timeout=10) as s:
                s.settimeout(None)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                with lock:
                    state.update(connected=True, error="", calls={})
                    bump()
                print(f"Callmonitor verbunden: {FRITZ}:{CM_PORT}", flush=True)
                buf = b""
                while True:
                    chunk = s.recv(4096)
                    if not chunk:
                        raise ConnectionError("Verbindung von der FRITZ!Box getrennt")
                    buf += chunk
                    while b"\n" in buf:
                        raw, buf = buf.split(b"\n", 1)
                        handle_line(raw.decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if isinstance(e, ConnectionRefusedError):
                msg = "Callmonitor aus – an einem Telefon #96*5* wählen"
            print(f"Callmonitor: {msg}", flush=True)
            with lock:
                state.update(connected=False, error=msg, calls={})
                bump()
            time.sleep(10)


def public_state():
    return {"connected": state["connected"], "error": state["error"],
            "calls": list(state["calls"].values()), "version": state["version"]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _ok(self, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if TOKEN and parse_qs(url.query).get("token", [""])[0] != TOKEN:
            self.send_response(403)
            self.end_headers()
            return
        if url.path == "/state":
            with lock:
                body = json.dumps(public_state()).encode()
            self._ok("application/json")
            self.wfile.write(body)
        elif url.path == "/events":
            self._ok("text/event-stream")
            seen = -1
            try:
                while True:
                    with lock:
                        if state["version"] == seen:
                            lock.wait(timeout=20)
                        if state["version"] != seen:
                            seen = state["version"]
                            data = "event: state\ndata: " + json.dumps(public_state()) + "\n\n"
                        else:
                            data = ": ping\n\n"
                    self.wfile.write(data.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    threading.Thread(target=monitor_loop, daemon=True).start()
    print(f"Nebenstellen-Monitor: http://0.0.0.0:{HTTP_PORT}/events", flush=True)
    ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever()
