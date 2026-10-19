"""Tk-Oberfläche: schwebende Aufnahme-Anzeige, Hinweise und Varianten-Auswahl.

Tk muss im Hauptthread laufen. Andere Threads rufen die öffentlichen Methoden
auf; diese reichen die Arbeit über eine Queue an den Tk-Thread weiter.
"""

from __future__ import annotations

import queue
import sys
import threading
import tkinter as tk
from concurrent.futures import Future
from tkinter import font as tkfont

BG = "#1f2124"
FG = "#f1f1f1"
MUTED = "#9aa0a6"
RED = "#ff4d4f"
AMBER = "#f5b942"
GREEN = "#4cc38a"
ACCENT = "#5b8def"


def _no_activate(window: tk.Toplevel) -> None:
    """Fenster soll den Fokus der Zielanwendung nicht stehlen (Windows)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        window.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
        GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW = -20, 0x08000000, 0x00000080
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE,
                                            style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
    except Exception:  # noqa: BLE001
        pass


class Overlay:
    """Kleine Pille unten am Bildschirm: Status, Zeit, Pegel."""

    W, H, BARS = 300, 46, 18

    def __init__(self, root: tk.Tk):
        self.root = root
        self.win = tk.Toplevel(root)
        self.win.withdraw()
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        try:
            self.win.attributes("-alpha", 0.93)
        except tk.TclError:
            pass
        self.canvas = tk.Canvas(self.win, width=self.W, height=self.H, bg=BG,
                                highlightthickness=0)
        self.canvas.pack()
        self.dot = self.canvas.create_oval(14, 16, 28, 30, fill=RED, outline="")
        self.label = self.canvas.create_text(38, 23, anchor="w", fill=FG, text="",
                                             font=("Segoe UI", 10))
        self.bars = [self.canvas.create_rectangle(0, 0, 0, 0, fill=FG, outline="")
                     for _ in range(self.BARS)]
        self.levels = [0.0] * self.BARS
        self._hide_job = None
        self._visible = False
        self._state = "idle"
        self._label_text = ""
        _no_activate(self.win)

    def _place(self) -> None:
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.win.geometry(f"{self.W}x{self.H}+{(sw - self.W) // 2}+{sh - self.H - 70}")

    def show(self) -> None:
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None
        if not self._visible:
            self._place()
            self.win.deiconify()
            self.win.attributes("-topmost", True)
            self._visible = True

    def hide_later(self, ms: int) -> None:
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
        self._hide_job = self.root.after(ms, self._hide)

    def _hide(self) -> None:
        self._hide_job = None
        self.win.withdraw()
        self._visible = False

    def set_state(self, state: str, text: str) -> None:
        self._state = state
        self._label_text = text
        color = {"recording": RED, "processing": AMBER, "idle": GREEN, "error": RED}[state]
        self.canvas.itemconfigure(self.dot, fill=color)
        self.canvas.itemconfigure(self.label, text=text)
        self._draw_bars(show=state == "recording")
        if state == "recording":
            self.levels = [0.0] * self.BARS
            self.show()
        elif state == "processing":
            self.show()
        elif state == "idle":
            if self._visible:
                self.hide_later(1300)
        else:
            self.show()
            self.hide_later(5000)

    def set_level(self, level: float, elapsed: float) -> None:
        if self._state != "recording":
            return
        self.levels = self.levels[1:] + [min(1.0, level * 12)]
        m, s = divmod(int(elapsed), 60)
        self.canvas.itemconfigure(self.label, text=f"{self._label_text}  {m:02d}:{s:02d}")
        self._draw_bars(show=True)

    def _draw_bars(self, show: bool) -> None:
        x0, mid = self.W - 14 - self.BARS * 5, self.H / 2
        for i, bar in enumerate(self.bars):
            h = 2 + self.levels[i] * 26 if show else 0
            x = x0 + i * 5
            self.canvas.coords(bar, x, mid - h / 2, x + 3, mid + h / 2)


class Toasts:
    """Kurze Hinweise oben rechts."""

    def __init__(self, root: tk.Tk):
        self.root = root
        self.active: list[tk.Toplevel] = []

    def show(self, text: str, ms: int = 4500) -> None:
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        frame = tk.Frame(win, bg=BG, padx=14, pady=10)
        frame.pack()
        tk.Label(frame, text=text, bg=BG, fg=FG, font=("Segoe UI", 10), wraplength=340,
                 justify="left").pack()
        win.update_idletasks()
        sw = self.root.winfo_screenwidth()
        y = 20 + sum(w.winfo_height() + 8 for w in self.active)
        win.geometry(f"+{sw - win.winfo_width() - 20}+{y}")
        _no_activate(win)
        self.active.append(win)

        def close():
            if win in self.active:
                self.active.remove(win)
            win.destroy()
        self.root.after(ms, close)


class VariantChooser:
    """Zeigt die Formulierungsvarianten; 1–3 wählt, 0 = Rohtext, Esc = abbrechen."""

    def __init__(self, root: tk.Tk, labels: list[str], pending: Future, raw: str,
                 done: callable):
        self.root, self.labels, self.pending, self.raw, self.done = \
            root, labels, pending, raw, done
        self.selected = 0
        self.win = tk.Toplevel(root)
        self.win.title("DiktierFlow – Formulierung wählen")
        self.win.configure(bg=BG)
        self.win.attributes("-topmost", True)
        self.win.protocol("WM_DELETE_WINDOW", lambda: self._finish(None))
        bold = tkfont.Font(family="Segoe UI", size=10, weight="bold")

        tk.Label(self.win, text="1/2/3 wählen und einfügen · Pfeile + Enter · 0 = Rohtext · "
                                "Esc = verwerfen (bleibt im Verlauf) · Texte sind editierbar",
                 bg=BG, fg=MUTED, font=("Segoe UI", 9)).pack(anchor="w", padx=14, pady=(10, 4))
        self.cards: list[tuple[tk.Frame, tk.Text]] = []
        for i, label in enumerate(labels):
            frame = tk.Frame(self.win, bg=BG, highlightthickness=2,
                             highlightbackground="#3a3d42", padx=8, pady=6)
            frame.pack(fill="x", padx=14, pady=4)
            tk.Label(frame, text=f"{i + 1} · {label}", bg=BG, fg=ACCENT, font=bold
                     ).pack(anchor="w")
            text = tk.Text(frame, height=4, wrap="word", bg="#2a2d31", fg=FG,
                           insertbackground=FG, relief="flat", font=("Segoe UI", 10),
                           padx=6, pady=4)
            text.insert("1.0", "wird erstellt …")
            text.configure(state="disabled")
            text.pack(fill="x")
            for w in (frame, text):
                w.bind("<Button-1>", lambda _e, k=i: self._select(k), add="+")
            self.cards.append((frame, text))

        raw_frame = tk.Frame(self.win, bg=BG, padx=8)
        raw_frame.pack(fill="x", padx=14, pady=(2, 4))
        tk.Label(raw_frame, text="0 · Rohtext: " + (raw if len(raw) < 160 else raw[:157] + "…"),
                 bg=BG, fg=MUTED, font=("Segoe UI", 9), wraplength=620, justify="left"
                 ).pack(anchor="w")
        btns = tk.Frame(self.win, bg=BG)
        btns.pack(fill="x", padx=14, pady=(4, 12))
        tk.Button(btns, text="Einfügen (Enter)", command=self._confirm).pack(side="right")
        tk.Button(btns, text="Verwerfen (Esc)", command=lambda: self._finish(None)
                  ).pack(side="right", padx=6)
        self.status = tk.Label(btns, text="", bg=BG, fg=AMBER, font=("Segoe UI", 9))
        self.status.pack(side="left")

        self.win.bind("<Escape>", lambda _e: self._finish(None))
        self.win.bind("<Return>", lambda _e: self._confirm())
        self.win.bind("<Up>", lambda _e: self._select((self.selected - 1) % len(labels)))
        self.win.bind("<Down>", lambda _e: self._select((self.selected + 1) % len(labels)))
        for i in range(len(labels)):
            self.win.bind(str(i + 1), lambda _e, k=i: self._pick(k))
        self.win.bind("0", lambda _e: self._finish(self.raw))

        self.win.update_idletasks()
        w, h = 680, self.win.winfo_reqheight()
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        self.win.geometry(f"{w}x{h}+{(sw - w) // 2}+{(sh - h) // 3}")
        self.win.lift()
        self.win.focus_force()
        self._select(0)
        self._poll()

    def _ready(self) -> bool:
        return self.pending.done() and self.pending.exception() is None

    def _poll(self) -> None:
        if not self.win.winfo_exists():
            return
        if not self.pending.done():
            self.status.configure(text="Claude formuliert …")
            self.root.after(120, self._poll)
            return
        if self.pending.exception() is not None:
            self.status.configure(text=f"Fehler: {self.pending.exception()} – 0 fügt Rohtext ein",
                                  fg=RED)
            return
        self.status.configure(text="")
        for (frame, text), value in zip(self.cards, self.pending.result()):
            text.configure(state="normal")
            text.delete("1.0", "end")
            text.insert("1.0", value)
            lines = int(text.count("1.0", "end", "displaylines")[0]) if \
                text.count("1.0", "end", "displaylines") else 4
            text.configure(height=max(2, min(10, lines)))
        self.win.focus_force()

    def _select(self, k: int) -> None:
        self.selected = k
        for i, (frame, _t) in enumerate(self.cards):
            frame.configure(highlightbackground=ACCENT if i == k else "#3a3d42")

    def _pick(self, k: int) -> str | None:
        # Tasten 1–3 nur, wenn der Fokus nicht in einem Textfeld liegt
        if isinstance(self.win.focus_get(), tk.Text):
            return None
        self._select(k)
        self._confirm()
        return "break"

    def _confirm(self) -> None:
        if not self._ready():
            return
        text = self.cards[self.selected][1].get("1.0", "end").strip()
        self._finish(text)

    def _finish(self, value: str | None) -> None:
        if self.win.winfo_exists():
            self.win.destroy()
        self.done(value)


class UI:
    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("DiktierFlow")
        self._q: queue.Queue = queue.Queue()
        self.overlay = Overlay(self.root)
        self.toasts = Toasts(self.root)
        self.app = None
        self._history = None
        self._settings = None
        self.root.after(30, self._pump)

    # -------------------------------------------------- Thread-Übergabe
    def call(self, fn, *args) -> None:
        self._q.put((fn, args))

    def _pump(self) -> None:
        try:
            while True:
                fn, args = self._q.get_nowait()
                try:
                    fn(*args)
                except Exception:  # noqa: BLE001
                    import logging
                    logging.getLogger(__name__).exception("UI-Fehler")
        except queue.Empty:
            pass
        self.root.after(30, self._pump)

    def run(self) -> None:
        self.root.mainloop()

    def quit(self) -> None:
        self.call(self.root.quit)

    # -------------------------------------------------- von DiktierApp genutzt
    def set_state(self, state: str, text: str) -> None:
        self.call(self.overlay.set_state, state, text)

    def set_level(self, level: float, elapsed: float) -> None:
        self.call(self.overlay.set_level, level, elapsed)

    def toast(self, text: str) -> None:
        self.call(self.toasts.show, text)

    def choose_variant(self, labels: list[str], pending: Future, raw: str) -> str | None:
        """Blockiert den aufrufenden (Worker-)Thread bis zur Auswahl."""
        done = threading.Event()
        result: list[str | None] = [None]

        def finish(value):
            result[0] = value
            done.set()

        def open_():
            self.overlay.set_state("idle", "Bitte wählen …")
            VariantChooser(self.root, labels, pending, raw, finish)
        self.call(open_)
        done.wait()
        return result[0]

    def open_history(self) -> None:
        def open_():
            from .history import HistoryWindow
            if self._history and self._history.win.winfo_exists():
                self._history.win.deiconify()
                self._history.win.lift()
                self._history.reload()
                return
            self._history = HistoryWindow(self.root, self.app)
        self.call(open_)

    def open_settings(self) -> None:
        def open_():
            from .settings import SettingsWindow
            if self._settings and self._settings.win.winfo_exists():
                self._settings.win.lift()
                return
            self._settings = SettingsWindow(self.root, self.app)
        self.call(open_)
