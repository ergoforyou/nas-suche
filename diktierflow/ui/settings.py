"""Einstellungsfenster für die wichtigsten Optionen (alles Weitere in config.json)."""

from __future__ import annotations

import os
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox, ttk

from ..config import Config
from ..hotkey import parse_combo

STYLE_NAMES = {"clean": "Nur korrigieren", "formal": "Professionell",
               "casual": "Locker", "raw": "Unverändert"}
MODE_NAMES = {"auto": "Tippen = Freihand, Halten = Push-to-Talk",
              "toggle": "Umschalten (Start/Stopp)", "hold": "Nur solange gedrückt"}
STT_NAMES = {"hybrid": "Hybrid (Cloud, bei Ausfall lokal)", "cloud": "Nur Cloud",
             "local": "Nur lokal (Whisper)"}


def _input_devices() -> list[str]:
    try:
        import sounddevice as sd
        return [""] + [d["name"] for d in sd.query_devices() if d["max_input_channels"] > 0]
    except Exception:  # noqa: BLE001
        return [""]


class SettingsWindow:
    def __init__(self, root: tk.Tk, app):
        self.app = app
        self.cfg: Config = app.cfg
        self.win = tk.Toplevel(root)
        self.win.title("DiktierFlow – Einstellungen")
        self.win.resizable(False, False)
        self.vars: dict[str, tk.Variable] = {}
        body = ttk.Frame(self.win, padding=14)
        body.pack(fill="both", expand=True)
        self.row = 0

        self._section(body, "Tastenkombinationen")
        self._entry(body, "hotkey_dictate", "Diktieren")
        self._entry(body, "hotkey_variants", "Diktieren + Varianten")
        self._entry(body, "hotkey_command", "Befehls-Modus (markierter Text)")
        self._combo(body, "hotkey_mode", "Verhalten", MODE_NAMES)
        self._check(body, "always_show_variants", "Varianten-Auswahl nach jedem Diktat")

        self._section(body, "Spracherkennung")
        self._combo(body, "stt_mode", "Modus", STT_NAMES)
        self._entry(body, "openai_api_key", "OpenAI-API-Schlüssel", secret=True)
        self._combo(body, "local_model", "Lokales Modell",
                    {m: m for m in ("large-v3-turbo", "large-v3", "medium", "small", "base")})
        self._combo(body, "input_device", "Mikrofon",
                    {d: d or "Standard" for d in _input_devices()})

        self._section(body, "Nachbearbeitung (Claude)")
        self._check(body, "llm_enabled", "Text mit Claude bereinigen und formulieren")
        self._entry(body, "anthropic_api_key", "Anthropic-API-Schlüssel", secret=True)
        self._combo(body, "llm_model", "Modell",
                    {"claude-opus-5-5": "Claude Opus 5.5 (beste Qualität)",
                     "claude-sonnet-5-5": "Claude Sonnet 5.5 (schneller)",
                     "claude-haiku-5-5": "Claude Haiku 5.5 (am schnellsten, günstig)"})
        self._combo(body, "default_style", "Standard-Stil", STYLE_NAMES)

        self._section(body, "Allgemein")
        self._check(body, "privacy_mode", "Datenschutz-Modus (alles lokal, kein Internet)")
        self._check(body, "learn_from_edits", "Aus meinen Korrekturen lernen")
        self._check(body, "save_audio", "Audio im Verlauf speichern")
        self._spin(body, "auto_stop_silence_s", "Freihand stoppt nach Stille (s, 0 = nie)",
                   0, 120)
        self._check(body, "sounds", "Signaltöne")
        self._check(body, "autostart", "Mit Windows starten")

        btns = ttk.Frame(body)
        btns.grid(row=self.row + 1, column=0, columnspan=2, sticky="ew", pady=(14, 0))
        ttk.Button(btns, text="config.json öffnen", command=self._open_json).pack(side="left")
        ttk.Button(btns, text="Speichern", command=self._save).pack(side="right")
        ttk.Button(btns, text="Abbrechen", command=self.win.destroy).pack(side="right", padx=6)

    # ------------------------------------------------------------ Widgets
    def _section(self, parent, title: str) -> None:
        self.row += 1
        ttk.Label(parent, text=title, font=("Segoe UI", 10, "bold")).grid(
            row=self.row, column=0, columnspan=2, sticky="w", pady=(10, 2))

    def _entry(self, parent, key: str, label: str, secret: bool = False) -> None:
        self.row += 1
        ttk.Label(parent, text=label).grid(row=self.row, column=0, sticky="w", padx=(0, 12))
        var = tk.StringVar(value=getattr(self.cfg, key))
        ttk.Entry(parent, textvariable=var, width=42, show="•" if secret else "").grid(
            row=self.row, column=1, sticky="ew")
        self.vars[key] = var

    def _combo(self, parent, key: str, label: str, options: dict[str, str]) -> None:
        self.row += 1
        ttk.Label(parent, text=label).grid(row=self.row, column=0, sticky="w", padx=(0, 12))
        reverse = {v: k for k, v in options.items()}
        current = getattr(self.cfg, key)
        box = ttk.Combobox(parent, values=list(options.values()), state="readonly", width=40)
        box.set(options.get(current, current))
        box.grid(row=self.row, column=1, sticky="ew")
        var = tk.StringVar(value=current)
        box.bind("<<ComboboxSelected>>", lambda _e: var.set(reverse.get(box.get(), box.get())))
        self.vars[key] = var

    def _check(self, parent, key: str, label: str) -> None:
        self.row += 1
        var = tk.BooleanVar(value=bool(getattr(self.cfg, key)))
        ttk.Checkbutton(parent, text=label, variable=var).grid(
            row=self.row, column=0, columnspan=2, sticky="w")
        self.vars[key] = var

    def _spin(self, parent, key: str, label: str, lo: float, hi: float) -> None:
        self.row += 1
        ttk.Label(parent, text=label).grid(row=self.row, column=0, sticky="w", padx=(0, 12))
        var = tk.DoubleVar(value=float(getattr(self.cfg, key)))
        ttk.Spinbox(parent, from_=lo, to=hi, textvariable=var, width=8).grid(
            row=self.row, column=1, sticky="w")
        self.vars[key] = var

    # ------------------------------------------------------------ Aktionen
    def _open_json(self) -> None:
        path = str(Config.path())
        if sys.platform == "win32":
            os.startfile(path)  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", path])  # noqa: S603, S607

    def _save(self) -> None:
        values = {k: v.get() for k, v in self.vars.items()}
        for key in ("hotkey_dictate", "hotkey_variants", "hotkey_command"):
            if values[key]:
                try:
                    parse_combo(values[key])
                except ValueError as exc:
                    messagebox.showerror("Ungültige Tastenkombination", str(exc),
                                         parent=self.win)
                    return
        privacy_changed = values["privacy_mode"] != self.cfg.privacy_mode
        for k, v in values.items():
            setattr(self.cfg, k, v)
        self.cfg.save()
        if privacy_changed:
            self.app.set_privacy_mode(self.cfg.privacy_mode)
        from ..autostart import set_autostart
        set_autostart(self.cfg.autostart)
        messagebox.showinfo("Gespeichert", "Einstellungen gespeichert. Tastenkombinationen, "
                                           "Schlüssel und Modelle gelten nach einem Neustart "
                                           "(Tray-Menü → Neu starten).", parent=self.win)
        self.win.destroy()
