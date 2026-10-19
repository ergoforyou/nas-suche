"""Einstellungen: werden als JSON im Benutzerverzeichnis gespeichert.

Windows: %APPDATA%\\DiktierFlow\\config.json
Sonst:   ~/.config/diktierflow/config.json

API-Schlüssel können in der Datei stehen oder (bevorzugt) als
Umgebungsvariablen ANTHROPIC_API_KEY / OPENAI_API_KEY gesetzt werden.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path


def data_dir() -> Path:
    override = os.environ.get("DIKTIERFLOW_HOME")
    if override:
        base = Path(override)
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home())) / "DiktierFlow"
    else:
        base = Path.home() / ".config" / "diktierflow"
    base.mkdir(parents=True, exist_ok=True)
    return base


@dataclass
class Config:
    # --- Tastenkombinationen ---------------------------------------------
    # Diktieren: kurz tippen = Freihand (läuft bis zum nächsten Druck),
    # gedrückt halten = Push-to-Talk (stoppt beim Loslassen).
    hotkey_dictate: str = "ctrl+win+space"
    # Diktieren und danach drei Formulierungsvarianten zur Auswahl anbieten.
    hotkey_variants: str = "ctrl+win+shift+space"
    # Befehls-Modus: markierten Text per Sprachanweisung umschreiben.
    hotkey_command: str = "ctrl+win+alt+space"
    # "auto" (tippen = Freihand, halten = Push-to-Talk), "toggle" oder "hold"
    hotkey_mode: str = "auto"
    hold_threshold_s: float = 0.45
    # Zeigt nach jedem Diktat die Varianten-Auswahl (auch ohne Varianten-Taste)
    always_show_variants: bool = False

    # --- Spracherkennung ---------------------------------------------------
    # "hybrid" = Cloud, bei Fehler/Offline lokal; "cloud"; "local"
    stt_mode: str = "hybrid"
    language: str = "de"
    openai_api_key: str = ""
    cloud_stt_model: str = "gpt-4o-transcribe"
    # Lokales Whisper (faster-whisper). Auf CPU-Laptops ist "large-v3-turbo"
    # in int8 der beste Kompromiss; "small" ist deutlich schneller.
    local_model: str = "large-v3-turbo"
    local_device: str = "auto"          # "auto", "cpu", "cuda"
    local_compute_type: str = "int8"
    preload_local_model: bool = False

    # --- Nachbearbeitung mit Claude ------------------------------------------
    llm_enabled: bool = True
    anthropic_api_key: str = ""
    llm_model: str = "claude-opus-5-5"
    llm_effort: str = "low"              # schnelle Bereinigung beim Diktieren
    llm_effort_variants: str = "medium"  # Varianten / Befehls-Modus
    llm_timeout_s: float = 20.0
    # Stil, wenn kein App-Profil passt: "clean", "formal", "casual", "raw"
    default_style: str = "clean"
    # Prozessname -> Stil. "raw" = keine Umformulierung (z. B. in Editoren)
    app_styles: dict = field(default_factory=lambda: {
        "outlook.exe": "formal",
        "olk.exe": "formal",
        "winword.exe": "formal",
        "teams.exe": "casual",
        "ms-teams.exe": "casual",
        "whatsapp.exe": "casual",
        "slack.exe": "casual",
        "code.exe": "clean",
        "windowsterminal.exe": "raw",
    })
    # Namen der drei Varianten im Auswahlfenster
    variant_labels: list = field(default_factory=lambda: [
        "Korrigiert", "Professionell", "Freundlich & locker",
    ])

    # --- Datenschutz -------------------------------------------------------
    # Nichts verlässt den Rechner: lokales Whisper, keine Claude-Aufrufe.
    privacy_mode: bool = False

    # --- Aufnahme ------------------------------------------------------------
    sample_rate: int = 16000
    input_device: str = ""               # leer = Standardmikrofon
    # Freihand-Modus stoppt nach so vielen Sekunden Stille (0 = nie)
    auto_stop_silence_s: float = 0.0
    # Lange Diktate werden in Stücken im Hintergrund transkribiert
    chunk_min_s: float = 25.0
    chunk_max_s: float = 90.0
    silence_threshold: float = 0.012
    save_audio: bool = True
    keep_audio_days: int = 14

    # --- Einfügen ----------------------------------------------------------
    # Zwischenablage nach dem Einfügen wiederherstellen
    restore_clipboard: bool = True
    # Apps, in denen mit Strg+Umschalt+V eingefügt werden muss
    shift_paste_apps: list = field(default_factory=lambda: [
        "windowsterminal.exe", "wezterm-gui.exe", "alacritty.exe",
    ])
    add_trailing_space: bool = True

    # --- Lernen ------------------------------------------------------------
    learn_from_edits: bool = True
    # Sekunden nach dem Einfügen, zu denen das Textfeld erneut gelesen wird
    edit_check_delays_s: list = field(default_factory=lambda: [10, 30, 75])
    # Wie oft eine Korrektur beobachtet werden muss, bis sie automatisch gilt
    # (manuelle Korrekturen im Verlauf gelten sofort)
    learn_threshold: int = 2

    # --- Sonstiges ---------------------------------------------------------
    sounds: bool = True
    autostart: bool = False

    # ------------------------------------------------------------------------
    @classmethod
    def path(cls) -> Path:
        return data_dir() / "config.json"

    @classmethod
    def load(cls) -> "Config":
        p = cls.path()
        cfg = cls()
        if p.exists():
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                raw = {}
            known = {f.name for f in fields(cls)}
            for k, v in raw.items():
                if k in known:
                    setattr(cfg, k, v)
        else:
            cfg.save()
        return cfg

    def save(self) -> None:
        self.path().write_text(
            json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8"
        )

    # Schlüssel: Umgebungsvariable hat Vorrang vor der Datei
    def get_anthropic_key(self) -> str:
        return os.environ.get("ANTHROPIC_API_KEY") or self.anthropic_api_key

    def get_openai_key(self) -> str:
        return os.environ.get("OPENAI_API_KEY") or self.openai_api_key

    def style_for_app(self, process_name: str | None) -> str:
        if process_name:
            style = self.app_styles.get(process_name.lower())
            if style:
                return style
        return self.default_style
