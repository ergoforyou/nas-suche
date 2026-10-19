"""Verlaufsfenster: Diktate suchen, kopieren, erneut einfügen, korrigieren (= lernen),
plus Wörterbuch, gelernte Korrekturen, Textbausteine und Statistik."""

from __future__ import annotations

import sys
import threading
import tkinter as tk
from datetime import datetime
from tkinter import messagebox, ttk


def _fmt_time(ts: float) -> str:
    d = datetime.fromtimestamp(ts)
    return d.strftime("%H:%M") if d.date() == datetime.now().date() else d.strftime("%d.%m. %H:%M")


class HistoryWindow:
    def __init__(self, root: tk.Tk, app):
        self.root, self.app = root, app
        self.storage = app.storage
        self.win = tk.Toplevel(root)
        self.win.title("DiktierFlow – Verlauf & Lernen")
        self.win.geometry("980x640")
        nb = ttk.Notebook(self.win)
        nb.pack(fill="both", expand=True, padx=8, pady=8)
        self._build_history(ttk.Frame(nb, padding=6), nb)
        self._build_vocab(ttk.Frame(nb, padding=6), nb)
        self._build_corrections(ttk.Frame(nb, padding=6), nb)
        self._build_snippets(ttk.Frame(nb, padding=6), nb)
        self._build_stats(ttk.Frame(nb, padding=12), nb)
        nb.bind("<<NotebookTabChanged>>", lambda _e: self.reload())
        self.reload()

    def reload(self) -> None:
        self._load_history()
        self._load_vocab()
        self._load_corrections()
        self._load_snippets()
        self._load_stats()

    # ======================================================== Verlauf
    def _build_history(self, f: ttk.Frame, nb: ttk.Notebook) -> None:
        nb.add(f, text="Verlauf")
        top = ttk.Frame(f)
        top.pack(fill="x")
        ttk.Label(top, text="Suchen:").pack(side="left")
        self.search = tk.StringVar()
        entry = ttk.Entry(top, textvariable=self.search, width=40)
        entry.pack(side="left", padx=6)
        self.search.trace_add("write", lambda *_: self._load_history())

        pane = ttk.PanedWindow(f, orient="horizontal")
        pane.pack(fill="both", expand=True, pady=6)
        left = ttk.Frame(pane)
        self.tree = ttk.Treeview(left, columns=("zeit", "app", "text"), show="headings",
                                 selectmode="browse")
        for col, title, width in (("zeit", "Zeit", 90), ("app", "Programm", 110),
                                  ("text", "Text", 260)):
            self.tree.heading(col, text=title)
            self.tree.column(col, width=width, stretch=col == "text")
        sb = ttk.Scrollbar(left, command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.tree.bind("<<TreeviewSelect>>", lambda _e: self._show_selected())
        self.tree.bind("<Double-1>", lambda _e: self._copy())
        pane.add(left, weight=1)

        right = ttk.Frame(pane, padding=(8, 0))
        self.meta = ttk.Label(right, text="", foreground="#666")
        self.meta.pack(anchor="w")
        ttk.Label(right, text="Text (bearbeitbar – Korrektur speichern lässt das Programm "
                              "daraus lernen):").pack(anchor="w", pady=(6, 2))
        self.text = tk.Text(right, wrap="word", height=12, font=("Segoe UI", 10), undo=True)
        self.text.pack(fill="both", expand=True)
        ttk.Label(right, text="Rohtext der Spracherkennung:").pack(anchor="w", pady=(6, 2))
        self.raw = tk.Text(right, wrap="word", height=4, font=("Segoe UI", 9),
                           foreground="#555", background="#f4f4f4")
        self.raw.pack(fill="x")
        vrow = ttk.Frame(right)
        vrow.pack(fill="x", pady=(6, 0))
        ttk.Label(vrow, text="Varianten:").pack(side="left")
        self.variant_box = ttk.Combobox(vrow, state="readonly", width=40)
        self.variant_box.pack(side="left", padx=6)
        ttk.Button(vrow, text="Übernehmen", command=self._use_variant).pack(side="left")

        rows = (
            (("Kopieren", self._copy), ("Einfügen", self._paste),
             ("Korrektur speichern & lernen", self._save_correction)),
            (("Audio neu erkennen", self._retranscribe), ("Abspielen", self._play),
             ("Löschen", self._delete)),
        )
        for i, row in enumerate(rows):
            btns = ttk.Frame(right)
            btns.pack(fill="x", pady=(8 if i == 0 else 4, 0))
            for label, cmd in row:
                ttk.Button(btns, text=label, command=cmd).pack(side="left", padx=(0, 6))
        pane.add(right, weight=2)
        self.current = None

    def _load_history(self) -> None:
        self.tree.delete(*self.tree.get_children())
        for d in self.storage.list_dictations(self.search.get().strip()):
            preview = d.best_text.replace("\n", " ")[:120] or "(nicht erkannt)"
            self.tree.insert("", "end", iid=str(d.id),
                             values=(_fmt_time(d.created_at), d.app or "", preview))

    def _show_selected(self) -> None:
        sel = self.tree.selection()
        if not sel:
            return
        d = self.storage.get_dictation(int(sel[0]))
        self.current = d
        if d is None:
            return
        mode = {"dictate": "Diktat", "variants": "Varianten", "command": "Befehl"}.get(
            d.mode, d.mode)
        dur = f"{d.duration_s:.0f}s" if d.duration_s else "–"
        edited = " · nachträglich korrigiert" if d.edited_text else ""
        self.meta.configure(text=f"{datetime.fromtimestamp(d.created_at):%d.%m.%Y %H:%M} · "
                                 f"{mode} · {d.app or '?'} · Stil {d.style or '–'} · "
                                 f"{d.stt_engine or '?'} · {dur}{edited}")
        self.text.delete("1.0", "end")
        self.text.insert("1.0", d.best_text)
        self.text.edit_reset()
        self.raw.delete("1.0", "end")
        self.raw.insert("1.0", d.raw_text)
        options = [f"{v['label']}: {v['text'][:60]}" for v in (d.variants or [])]
        self.variant_box.configure(values=options)
        self.variant_box.set("")

    def _current_text(self) -> str:
        return self.text.get("1.0", "end").strip()

    def _copy(self) -> None:
        if not self.current:
            return
        self.win.clipboard_clear()
        self.win.clipboard_append(self._current_text())
        self.app._ui("toast", "In die Zwischenablage kopiert")

    def _paste(self) -> None:
        """Fenster minimieren und Text ins zuvor aktive Programm einfügen."""
        if not self.current:
            return
        text = self._current_text()
        self.win.iconify()

        def go():
            import time
            time.sleep(0.35)
            self.app.insert(text, trailing_space=False)
        threading.Thread(target=go, daemon=True).start()

    def _use_variant(self) -> None:
        if not self.current or not self.current.variants:
            return
        idx = self.variant_box.current()
        if idx < 0:
            return
        self.text.delete("1.0", "end")
        self.text.insert("1.0", self.current.variants[idx]["text"])

    def _save_correction(self) -> None:
        d = self.current
        if not d:
            return
        new = self._current_text()
        before = d.best_text
        if new == before:
            return
        self.storage.update_dictation(d.id, edited_text=new)
        learned = self.app.learn_from_edit(before, new, manual=True)
        if not learned:
            messagebox.showinfo(
                "Gespeichert",
                "Korrigierter Text gespeichert.\nEs wurde keine wiederverwendbare Wort-"
                "Korrektur erkannt (größere Umformulierungen werden nicht gelernt). Einzelne "
                "Begriffe kannst du im Reiter „Gelernte Korrekturen“ von Hand eintragen.",
                parent=self.win)
        self._load_history()

    def _retranscribe(self) -> None:
        d = self.current
        if not d:
            return
        if not d.audio_path:
            messagebox.showinfo("Kein Audio", "Für diesen Eintrag ist kein Audio gespeichert.",
                                parent=self.win)
            return
        self.meta.configure(text="Erkenne erneut …")

        def work():
            try:
                result = self.app.retranscribe(d.id)
            except Exception as exc:  # noqa: BLE001
                result = None
                self.app._ui("toast", f"Fehler: {exc}")
            self.root.after(0, lambda: (self._load_history(), self.tree.selection_set(str(d.id))
                                        if result is not None else None))
        threading.Thread(target=work, daemon=True).start()

    def _play(self) -> None:
        d = self.current
        if d and d.audio_path and sys.platform == "win32":
            import winsound
            winsound.PlaySound(d.audio_path, winsound.SND_FILENAME | winsound.SND_ASYNC)

    def _delete(self) -> None:
        d = self.current
        if not d or not messagebox.askyesno("Löschen", "Eintrag wirklich löschen?",
                                            parent=self.win):
            return
        audio = self.storage.delete_dictation(d.id)
        if audio:
            from pathlib import Path
            Path(audio).unlink(missing_ok=True)
        self.current = None
        self.text.delete("1.0", "end")
        self.raw.delete("1.0", "end")
        self._load_history()

    # ======================================================== Wörterbuch
    def _build_vocab(self, f: ttk.Frame, nb: ttk.Notebook) -> None:
        nb.add(f, text="Wörterbuch")
        ttk.Label(f, text="Namen, Firmen, Fachbegriffe in der richtigen Schreibweise. Sie werden "
                          "der Spracherkennung als Hinweis und Claude als Glossar mitgegeben."
                  ).pack(anchor="w")
        row = ttk.Frame(f)
        row.pack(fill="x", pady=6)
        self.term = tk.StringVar()
        e = ttk.Entry(row, textvariable=self.term, width=40)
        e.pack(side="left")
        e.bind("<Return>", lambda _e: self._add_term())
        ttk.Button(row, text="Hinzufügen", command=self._add_term).pack(side="left", padx=6)
        ttk.Button(row, text="Entfernen", command=self._remove_term).pack(side="left")
        self.vocab = tk.Listbox(f, font=("Segoe UI", 10), selectmode="extended")
        self.vocab.pack(fill="both", expand=True)

    def _load_vocab(self) -> None:
        self.vocab.delete(0, "end")
        for t in self.storage.list_terms():
            self.vocab.insert("end", t)

    def _add_term(self) -> None:
        for t in self.term.get().split(","):
            self.storage.add_term(t)
        self.term.set("")
        self.app.refresh_learning()
        self._load_vocab()

    def _remove_term(self) -> None:
        for i in self.vocab.curselection():
            self.storage.remove_term(self.vocab.get(i))
        self.app.refresh_learning()
        self._load_vocab()

    # ======================================================== Korrekturen
    def _build_corrections(self, f: ttk.Frame, nb: ttk.Notebook) -> None:
        nb.add(f, text="Gelernte Korrekturen")
        ttk.Label(f, text=f"Automatisch erkannte Korrekturen gelten ab "
                          f"{self.app.cfg.learn_threshold}× Beobachtung, bestätigte und "
                          f"manuelle sofort.").pack(anchor="w")
        self.ctree = ttk.Treeview(f, columns=("falsch", "richtig", "anzahl", "status", "quelle"),
                                  show="headings")
        for col, title, width in (("falsch", "Erkannt als", 220), ("richtig", "Richtig", 220),
                                  ("anzahl", "Gesehen", 70), ("status", "Status", 110),
                                  ("quelle", "Quelle", 80)):
            self.ctree.heading(col, text=title)
            self.ctree.column(col, width=width)
        self.ctree.pack(fill="both", expand=True, pady=6)
        row = ttk.Frame(f)
        row.pack(fill="x")
        ttk.Button(row, text="Bestätigen (sofort aktiv)", command=self._confirm_corr
                   ).pack(side="left")
        ttk.Button(row, text="Löschen", command=self._delete_corr).pack(side="left", padx=6)
        ttk.Separator(row, orient="vertical").pack(side="left", fill="y", padx=12)
        self.c_wrong, self.c_right = tk.StringVar(), tk.StringVar()
        ttk.Entry(row, textvariable=self.c_wrong, width=22).pack(side="left")
        ttk.Label(row, text="→").pack(side="left", padx=4)
        ttk.Entry(row, textvariable=self.c_right, width=22).pack(side="left")
        ttk.Button(row, text="Manuell hinzufügen", command=self._add_corr).pack(side="left",
                                                                               padx=6)

    def _load_corrections(self) -> None:
        self.ctree.delete(*self.ctree.get_children())
        threshold = self.app.cfg.learn_threshold
        for c in self.storage.list_corrections():
            status = "aktiv" if (c.confirmed or c.count >= threshold) else "beobachtet"
            self.ctree.insert("", "end", iid=str(c.id),
                              values=(c.wrong, c.right, c.count, status, c.source))

    def _confirm_corr(self) -> None:
        for iid in self.ctree.selection():
            self.storage.set_correction_confirmed(int(iid), True)
        self.app.refresh_learning()
        self._load_corrections()

    def _delete_corr(self) -> None:
        for iid in self.ctree.selection():
            self.storage.delete_correction(int(iid))
        self.app.refresh_learning()
        self._load_corrections()

    def _add_corr(self) -> None:
        wrong, right = self.c_wrong.get().strip(), self.c_right.get().strip()
        if wrong and right:
            self.storage.record_correction(wrong, right, source="manual", confirm=True)
            self.c_wrong.set("")
            self.c_right.set("")
            self.app.refresh_learning()
            self._load_corrections()

    # ======================================================== Textbausteine
    def _build_snippets(self, f: ttk.Frame, nb: ttk.Notebook) -> None:
        nb.add(f, text="Textbausteine")
        ttk.Label(f, text="Beim Diktieren z. B. „füge meine Signatur ein“ sagen – Claude setzt "
                          "den passenden Baustein ein.").pack(anchor="w")
        pane = ttk.PanedWindow(f, orient="horizontal")
        pane.pack(fill="both", expand=True, pady=6)
        self.snip_list = tk.Listbox(pane, font=("Segoe UI", 10), width=28)
        self.snip_list.bind("<<ListboxSelect>>", lambda _e: self._show_snippet())
        pane.add(self.snip_list, weight=1)
        right = ttk.Frame(pane, padding=(8, 0))
        ttk.Label(right, text="Name:").pack(anchor="w")
        self.snip_name = tk.StringVar()
        ttk.Entry(right, textvariable=self.snip_name).pack(fill="x")
        ttk.Label(right, text="Text:").pack(anchor="w", pady=(6, 0))
        self.snip_text = tk.Text(right, wrap="word", height=10, font=("Segoe UI", 10))
        self.snip_text.pack(fill="both", expand=True)
        row = ttk.Frame(right)
        row.pack(fill="x", pady=6)
        ttk.Button(row, text="Speichern", command=self._save_snippet).pack(side="left")
        ttk.Button(row, text="Löschen", command=self._delete_snippet).pack(side="left", padx=6)
        pane.add(right, weight=3)

    def _load_snippets(self) -> None:
        self.snip_list.delete(0, "end")
        for name in self.storage.snippets():
            self.snip_list.insert("end", name)

    def _show_snippet(self) -> None:
        sel = self.snip_list.curselection()
        if not sel:
            return
        name = self.snip_list.get(sel[0])
        self.snip_name.set(name)
        self.snip_text.delete("1.0", "end")
        self.snip_text.insert("1.0", self.storage.snippets().get(name, ""))

    def _save_snippet(self) -> None:
        name = self.snip_name.get().strip()
        if name:
            self.storage.set_snippet(name, self.snip_text.get("1.0", "end").rstrip())
            self._load_snippets()

    def _delete_snippet(self) -> None:
        name = self.snip_name.get().strip()
        if name:
            self.storage.delete_snippet(name)
            self._load_snippets()

    # ======================================================== Statistik
    def _build_stats(self, f: ttk.Frame, nb: ttk.Notebook) -> None:
        nb.add(f, text="Statistik")
        self.stats_label = ttk.Label(f, text="", font=("Segoe UI", 12), justify="left")
        self.stats_label.pack(anchor="w")

    def _load_stats(self) -> None:
        s = self.storage.stats()
        self.stats_label.configure(text=(
            f"Diktate: {s['dictations']}\n"
            f"Diktierte Wörter: {s['words']:,}".replace(",", ".") + "\n"
            f"Gesprochene Zeit: {s['seconds'] / 60:.0f} Minuten\n"
            f"Geschätzt gesparte Tippzeit: {s['saved_minutes']:.0f} Minuten\n"
            f"Gelernte Korrekturen: {len(self.storage.active_corrections(self.app.cfg.learn_threshold))}\n"
            f"Wörterbuch-Einträge: {len(self.storage.list_terms())}"))
