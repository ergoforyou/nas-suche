"""Globale Tastenkombinationen mit Halten-/Freihand-Logik.

`PressLogic` entscheidet (testbar, ohne Tastatur), ob ein Druck die Aufnahme
startet/stoppt:
  auto:   kurz tippen -> Freihand (läuft bis zum nächsten Druck),
          gedrückt halten -> Push-to-Talk (Loslassen stoppt)
  toggle: jeder Druck startet bzw. stoppt
  hold:   nur solange gedrückt
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable

log = logging.getLogger(__name__)

MODIFIERS = {"ctrl", "win", "shift", "alt"}
ALIASES = {"control": "ctrl", "strg": "ctrl", "cmd": "win", "super": "win",
           "windows": "win", "meta": "win", "umschalt": "shift", "leertaste": "space",
           "return": "enter"}
# Virtuelle Windows-Tastencodes für Auslösetasten
VK_CODES = {"space": 0x20, "enter": 0x0D, "tab": 0x09, "f1": 0x70, "f2": 0x71,
            "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
            "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B}


@dataclass(frozen=True)
class Combo:
    modifiers: frozenset[str]
    key: str

    @property
    def vk(self) -> int | None:
        if self.key in VK_CODES:
            return VK_CODES[self.key]
        if len(self.key) == 1 and self.key.isalnum():
            return ord(self.key.upper())
        return None


def parse_combo(text: str) -> Combo:
    parts = [ALIASES.get(p.strip().lower(), p.strip().lower())
             for p in text.replace(" ", "").split("+") if p.strip()]
    mods = frozenset(p for p in parts if p in MODIFIERS)
    keys = [p for p in parts if p not in MODIFIERS]
    if len(keys) != 1:
        raise ValueError(f"Tastenkombination braucht genau eine Taste außer Strg/Win/"
                         f"Umschalt/Alt: {text!r}")
    return Combo(mods, keys[0])


class PressLogic:
    """Zustandsautomat für eine Aufnahme-Taste."""

    def __init__(self, mode: str, hold_threshold_s: float,
                 start: Callable[[], None], stop: Callable[[], None],
                 is_recording: Callable[[], bool], clock=time.monotonic):
        self.mode = mode
        self.hold_threshold_s = hold_threshold_s
        self.start, self.stop, self.is_recording = start, stop, is_recording
        self.clock = clock
        self._pressed_at: float | None = None
        self._started_by_this_press = False

    def press(self) -> None:
        self._pressed_at = self.clock()
        if self.is_recording():
            self._started_by_this_press = False
            self.stop()
        else:
            self._started_by_this_press = True
            self.start()

    def release(self) -> None:
        if self._pressed_at is None:
            return
        held = self.clock() - self._pressed_at
        self._pressed_at = None
        if not (self._started_by_this_press and self.is_recording()):
            return
        if self.mode == "hold" or (self.mode == "auto" and held >= self.hold_threshold_s):
            self.stop()
        # toggle oder kurzes Tippen im auto-Modus: Freihand läuft weiter


def _key_name(key) -> str | None:
    from pynput.keyboard import Key, KeyCode

    mapping = {
        Key.ctrl: "ctrl", Key.ctrl_l: "ctrl", Key.ctrl_r: "ctrl",
        Key.cmd: "win", Key.cmd_l: "win", Key.cmd_r: "win",
        Key.shift: "shift", Key.shift_l: "shift", Key.shift_r: "shift",
        Key.alt: "alt", Key.alt_l: "alt", Key.alt_r: "alt", Key.alt_gr: "alt",
        Key.space: "space", Key.enter: "enter", Key.tab: "tab", Key.esc: "esc",
    }
    if key in mapping:
        return mapping[key]
    if isinstance(key, Key):
        return key.name
    if isinstance(key, KeyCode):
        if key.char:
            return key.char.lower()
        if key.vk is not None:
            if 0x41 <= key.vk <= 0x5A or 0x30 <= key.vk <= 0x39:
                return chr(key.vk).lower()
    return None


class HotkeyManager:
    """Hört global auf Tastenkombinationen und unterdrückt deren Auslösetaste."""

    WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x100, 0x101, 0x104, 0x105
    # Win-Taste "maskieren", damit sich nach Strg+Win+… nicht das Startmenü öffnet
    VK_MASK = 0xE8

    def __init__(self):
        self._combos: dict[str, Combo] = {}
        self._on_press: dict[str, Callable[[], None]] = {}
        self._on_release: dict[str, Callable[[], None]] = {}
        self._mods: set[str] = set()
        self._active: str | None = None
        self._lock = threading.Lock()
        self._listener = None
        self.on_escape: Callable[[], None] | None = None

    def register(self, name: str, combo_text: str, on_press: Callable[[], None],
                 on_release: Callable[[], None]) -> None:
        self._combos[name] = parse_combo(combo_text)
        self._on_press[name] = on_press
        self._on_release[name] = on_release

    def modifiers_down(self) -> bool:
        return bool(self._mods)

    def wait_modifiers_released(self, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while self._mods and time.monotonic() < deadline:
            time.sleep(0.02)

    def start(self) -> None:
        from pynput import keyboard

        kwargs = {}
        if sys.platform == "win32":
            kwargs["win32_event_filter"] = self._win32_filter
        self._listener = keyboard.Listener(on_press=self._press, on_release=self._release,
                                           **kwargs)
        self._listener.daemon = True
        self._listener.start()

    def stop(self) -> None:
        if self._listener:
            self._listener.stop()

    # ---------------------------------------------------------------- Matching
    def _match(self, key: str) -> str | None:
        for name, combo in self._combos.items():
            if combo.key == key and combo.modifiers == frozenset(self._mods):
                return name
        return None

    def _fire_press(self, name: str) -> None:
        with self._lock:
            if self._active is not None:
                return  # Tastenwiederholung ignorieren
            self._active = name
        threading.Thread(target=self._on_press[name], daemon=True).start()

    def _fire_release(self) -> None:
        with self._lock:
            name, self._active = self._active, None
        if name:
            threading.Thread(target=self._on_release[name], daemon=True).start()

    def _press(self, key) -> None:
        name = _key_name(key)
        if name is None:
            return
        if name in MODIFIERS:
            self._mods.add(name)
            return
        if name == "esc" and self.on_escape:
            self.on_escape()
        combo = self._match(name)
        if combo:
            self._fire_press(combo)

    def _release(self, key) -> None:
        name = _key_name(key)
        if name is None:
            return
        if name in MODIFIERS:
            self._mods.discard(name)
        active = self._active
        if active and (name == self._combos[active].key
                       or name in self._combos[active].modifiers):
            self._fire_release()

    # --------------------------------------------- Windows: Taste unterdrücken
    def _win32_filter(self, msg, data) -> bool:
        vk = data.vkCode
        is_down = msg in (self.WM_KEYDOWN, self.WM_SYSKEYDOWN)
        is_up = msg in (self.WM_KEYUP, self.WM_SYSKEYUP)
        for name, combo in self._combos.items():
            if combo.vk != vk:
                continue
            if is_down and combo.modifiers == frozenset(self._mods):
                self._fire_press(name)
                self._mask_win_key()
                self._listener.suppress_event()
            if is_up and self._active == name:
                self._fire_release()
                self._listener.suppress_event()
        return True

    def _mask_win_key(self) -> None:
        if "win" not in self._mods:
            return
        try:
            import ctypes
            user32 = ctypes.windll.user32
            user32.keybd_event(self.VK_MASK, 0, 0, 0)
            user32.keybd_event(self.VK_MASK, 0, 2, 0)  # KEYEVENTF_KEYUP
        except Exception:  # noqa: BLE001
            pass
