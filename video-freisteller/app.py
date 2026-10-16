"""Video-Freisteller – einfacher Videoschnitt + Hintergrund freistellen.

Start:  python app.py [video]
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import numpy as np
from PySide6.QtCore import QSettings, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QColor, QImage, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QColorDialog, QComboBox, QDoubleSpinBox,
    QFileDialog, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QListWidget,
    QMainWindow, QMessageBox, QProgressBar, QProgressDialog, QPushButton,
    QScrollArea, QSizePolicy, QSlider, QSplitter, QVBoxLayout, QWidget,
)

import processing as P

VIDEO_FILTER = "Videos (*.mp4 *.mov *.mkv *.avi *.webm *.m4v *.wmv *.mts *.m2ts);;Alle Dateien (*)"
PREVIEW_MAX = 960  # Vorschau wird auf diese Breite/Hoehe begrenzt (schneller)


def fmt_time(t: float) -> str:
    t = max(0.0, t)
    m, s = divmod(t, 60)
    h, m = divmod(int(m), 60)
    return f"{h:d}:{m:02d}:{s:06.3f}" if h else f"{m:02d}:{s:06.3f}"


def to_qimage(rgb: np.ndarray) -> QImage:
    rgb = np.ascontiguousarray(rgb)
    h, w = rgb.shape[:2]
    return QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()


# --------------------------------------------------------------------------
# Zeitleiste mit Schnittbereichen
# --------------------------------------------------------------------------

class Timeline(QWidget):
    seek = Signal(int)

    def __init__(self):
        super().__init__()
        self.setMinimumHeight(46)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.total = 1
        self.pos = 0
        self.mark_in = 0
        self.mark_out = 0
        self.segments: list[tuple[int, int]] = []
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def _x(self, f):
        return 8 + (self.width() - 16) * f / max(1, self.total - 1)

    def _frame(self, x):
        f = (x - 8) / max(1, self.width() - 16) * (self.total - 1)
        return int(round(min(max(f, 0), self.total - 1)))

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        h = self.height()
        p.fillRect(8, 14, self.width() - 16, h - 28, QColor(60, 60, 66))
        # Uebernommene Bereiche
        for a, b in self.segments:
            p.fillRect(int(self._x(a)), 14, max(2, int(self._x(b) - self._x(a))),
                       h - 28, QColor(46, 160, 90))
        # Aktueller In/Out-Bereich
        xa, xb = self._x(self.mark_in), self._x(self.mark_out)
        p.fillRect(int(xa), 8, max(2, int(xb - xa)), 5, QColor(255, 190, 40))
        p.setPen(QColor(255, 190, 40))
        p.drawLine(int(xa), 6, int(xa), h - 6)
        p.drawLine(int(xb), 6, int(xb), h - 6)
        # Abspielposition
        x = self._x(self.pos)
        p.setPen(QColor(240, 70, 70))
        p.drawLine(int(x), 2, int(x), h - 2)
        p.setBrush(QColor(240, 70, 70))
        p.drawEllipse(int(x) - 5, h - 12, 10, 10)
        p.end()

    def mousePressEvent(self, e):
        self.seek.emit(self._frame(e.position().x()))

    def mouseMoveEvent(self, e):
        if e.buttons() & Qt.MouseButton.LeftButton:
            self.seek.emit(self._frame(e.position().x()))


# --------------------------------------------------------------------------
# Vorschau (Pipette per Klick)
# --------------------------------------------------------------------------

class Preview(QLabel):
    picked = Signal(float, float)  # relative Koordinaten 0..1

    def __init__(self):
        super().__init__("Video hierher ziehen oder „Video öffnen…“ klicken")
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(480, 270)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setStyleSheet("background:#1e1e22;color:#999;font-size:15px;")
        self._img: QImage | None = None
        self.pick_mode = False

    def set_image(self, img: QImage):
        self._img = img
        self._rescale()

    def _rescale(self):
        if self._img is None:
            return
        self.setPixmap(QPixmap.fromImage(self._img).scaled(
            self.size(), Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._rescale()

    def mousePressEvent(self, e):
        pm = self.pixmap()
        if not self.pick_mode or pm is None or pm.isNull():
            return
        ox = (self.width() - pm.width()) / 2
        oy = (self.height() - pm.height()) / 2
        rx = (e.position().x() - ox) / pm.width()
        ry = (e.position().y() - oy) / pm.height()
        if 0 <= rx <= 1 and 0 <= ry <= 1:
            self.picked.emit(rx, ry)


# --------------------------------------------------------------------------
# Hintergrund-Threads
# --------------------------------------------------------------------------

class ExportThread(QThread):
    progress = Signal(float, str)
    done = Signal(str)
    failed = Signal(str)

    def __init__(self, job, model_path):
        super().__init__()
        self.job, self.model_path = job, model_path
        self._cancel = False

    def cancel(self):
        self._cancel = True

    def run(self):
        try:
            P.export(self.job, self.model_path,
                     progress=lambda f, t: self.progress.emit(f, t),
                     is_cancelled=lambda: self._cancel)
            self.done.emit(self.job.out_path)
        except P.Cancelled:
            self.failed.emit("Abgebrochen.")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.failed.emit(str(exc))


class DownloadThread(QThread):
    progress = Signal(int)
    done = Signal(str)
    failed = Signal(str)

    def __init__(self, quality):
        super().__init__()
        self.quality = quality

    def run(self):
        try:
            path = P.download_model(self.quality, lambda f: self.progress.emit(int(f * 100)))
            self.done.emit(str(path))
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))


# --------------------------------------------------------------------------
# Hauptfenster
# --------------------------------------------------------------------------

def slider_row(minimum, maximum, value, step=1.0, decimals=2, suffix=""):
    """Schieberegler + Zahlenfeld, gekoppelt."""
    box = QWidget()
    lay = QHBoxLayout(box)
    lay.setContentsMargins(0, 0, 0, 0)
    sl = QSlider(Qt.Orientation.Horizontal)
    factor = 10 ** decimals
    sl.setRange(int(minimum * factor), int(maximum * factor))
    sp = QDoubleSpinBox()
    sp.setRange(minimum, maximum)
    sp.setDecimals(decimals)
    sp.setSingleStep(step)
    sp.setSuffix(suffix)
    sp.setFixedWidth(80)
    sl.valueChanged.connect(lambda v: sp.setValue(v / factor))
    sp.valueChanged.connect(lambda v: sl.setValue(int(round(v * factor))))
    sp.setValue(value)
    lay.addWidget(sl, 1)
    lay.addWidget(sp)
    box.spin = sp
    return box


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Video-Freisteller")
        self.resize(1400, 860)
        self.setAcceptDrops(True)
        self.qs = QSettings("ergoforyou", "VideoFreisteller")

        self.info: P.VideoInfo | None = None
        self.reader: P.FrameReader | None = None
        self.frame_idx = 0
        self.cur_rgb: np.ndarray | None = None
        self.matters: dict = {}
        self.processor: P.Processor | None = None
        self.proc_dirty = True
        self.last_processed_idx = -10
        self.export_thread = None

        self.play_timer = QTimer(self)
        self.play_timer.timeout.connect(self._play_tick)
        self.update_timer = QTimer(self)
        self.update_timer.setSingleShot(True)
        self.update_timer.setInterval(120)
        self.update_timer.timeout.connect(self._render)

        self._build_ui()
        self._load_settings()

    # ---------------------------------------------------------------- UI
    def _build_ui(self):
        splitter = QSplitter()
        self.setCentralWidget(splitter)

        # Links: Vorschau + Schnitt
        left = QWidget()
        lv = QVBoxLayout(left)
        top = QHBoxLayout()
        b_open = QPushButton("Video öffnen…")
        b_open.clicked.connect(self.open_dialog)
        top.addWidget(b_open)
        self.lbl_file = QLabel("–")
        self.lbl_file.setStyleSheet("color:#888")
        top.addWidget(self.lbl_file, 1)
        top.addWidget(QLabel("Ansicht:"))
        self.cb_view = QComboBox()
        self.cb_view.addItems(["Ergebnis", "Vorher | Nachher", "Maske (Alpha)", "Original"])
        self.cb_view.currentIndexChanged.connect(self.schedule_render)
        top.addWidget(self.cb_view)
        top.addWidget(QLabel("Hintergrund:"))
        self.cb_bg = QComboBox()
        self.cb_bg.addItems(["Schachbrett", "Schwarz", "Weiß", "Grau", "Grün", "Eigenes Bild…"])
        self.cb_bg.currentIndexChanged.connect(self._bg_changed)
        top.addWidget(self.cb_bg)
        lv.addLayout(top)

        self.preview = Preview()
        self.preview.picked.connect(self._picked)
        lv.addWidget(self.preview, 1)

        self.timeline = Timeline()
        self.timeline.seek.connect(self.seek)
        lv.addWidget(self.timeline)

        ctl = QHBoxLayout()
        self.b_play = QPushButton("▶  Abspielen")
        self.b_play.clicked.connect(self.toggle_play)
        ctl.addWidget(self.b_play)
        for txt, d in (("◀◀ 1s", -1.0), ("◀ Bild", None), ("Bild ▶", None), ("1s ▶▶", 1.0)):
            b = QPushButton(txt)
            if d is None:
                step = -1 if txt.startswith("◀") else 1
                b.clicked.connect(lambda _=False, s=step: self.seek(self.frame_idx + s))
            else:
                b.clicked.connect(lambda _=False, s=d: self.seek_seconds(s))
            ctl.addWidget(b)
        self.lbl_time = QLabel("00:00.000 / 00:00.000")
        self.lbl_time.setStyleSheet("font-family:Consolas,monospace;font-size:14px;")
        ctl.addStretch(1)
        ctl.addWidget(self.lbl_time)
        lv.addLayout(ctl)

        cut = QGroupBox("Schneiden  (Tasten: Leertaste = Play, ←/→ = Bild, I = Anfang, O = Ende)")
        cl = QHBoxLayout(cut)
        b_in = QPushButton("[ Anfang setzen (I)")
        b_in.clicked.connect(self.set_in)
        b_out = QPushButton("Ende setzen (O) ]")
        b_out.clicked.connect(self.set_out)
        self.lbl_inout = QLabel("Bereich: –")
        b_add = QPushButton("＋ Bereich zur Liste")
        b_add.clicked.connect(self.add_segment)
        b_del = QPushButton("Entfernen")
        b_del.clicked.connect(self.remove_segment)
        self.seg_list = QListWidget()
        self.seg_list.setMaximumHeight(90)
        self.seg_list.itemDoubleClicked.connect(self._jump_segment)
        col = QVBoxLayout()
        row = QHBoxLayout()
        row.addWidget(b_in)
        row.addWidget(b_out)
        row.addWidget(b_add)
        col.addLayout(row)
        col.addWidget(self.lbl_inout)
        hint = QLabel("Ohne Einträge in der Liste wird der Bereich Anfang–Ende exportiert. "
                      "Mehrere Listeneinträge werden aneinandergehängt.")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#888")
        col.addWidget(hint)
        cl.addLayout(col, 1)
        sl = QVBoxLayout()
        sl.addWidget(self.seg_list)
        sl.addWidget(b_del)
        cl.addLayout(sl, 1)
        lv.addWidget(cut)
        splitter.addWidget(left)

        # Rechts: Einstellungen
        panel = QWidget()
        pv = QVBoxLayout(panel)

        g_mode = QGroupBox("Freistellen")
        fm = QFormLayout(g_mode)
        self.cb_mode = QComboBox()
        self.cb_mode.addItem("KI – Person automatisch (empfohlen)", "ai")
        self.cb_mode.addItem("Farbe – Green-Screen / weißer Hintergrund", "chroma")
        self.cb_mode.addItem("Nicht freistellen (nur schneiden)", "none")
        self.cb_mode.currentIndexChanged.connect(self._mode_changed)
        fm.addRow(self.cb_mode)
        pv.addWidget(g_mode)

        # KI
        self.g_ai = QGroupBox("KI-Freistellung (lokal berechnet)")
        fa = QFormLayout(self.g_ai)
        self.cb_aiq = QComboBox()
        self.cb_aiq.addItem("Schnell (MobileNet)", "schnell")
        self.cb_aiq.addItem("Höchste Qualität (ResNet50, ~100 MB Download)", "hoch")
        self.cb_aiq.currentIndexChanged.connect(self._aiq_changed)
        fa.addRow("Modell:", self.cb_aiq)
        self.s_detail = slider_row(0.5, 2.5, 1.0, 0.1, 2, "×")
        self.s_detail.setToolTip("Höher = feinere Details (Haare), langsamer. "
                                 "Bei Nahaufnahmen eher niedriger.")
        fa.addRow("Detailstufe:", self.s_detail)
        self.ck_edgecol = QCheckBox("Kantenfarben bereinigen (kein Hintergrund-Saum)")
        fa.addRow(self.ck_edgecol)
        self.ck_gpu = QCheckBox("Grafikkarte nutzen, falls verfügbar")
        fa.addRow(self.ck_gpu)
        self.lbl_provider = QLabel("")
        self.lbl_provider.setStyleSheet("color:#888")
        fa.addRow(self.lbl_provider)
        pv.addWidget(self.g_ai)

        # Farbe
        self.g_chroma = QGroupBox("Farb-Freistellung")
        fc = QFormLayout(self.g_chroma)
        crow = QHBoxLayout()
        self.b_color = QPushButton()
        self.b_color.setFixedWidth(60)
        self.b_color.clicked.connect(self._choose_color)
        crow.addWidget(self.b_color)
        self.b_pick = QPushButton("Pipette")
        self.b_pick.setCheckable(True)
        self.b_pick.setToolTip("Danach in die Vorschau auf den Hintergrund klicken")
        self.b_pick.toggled.connect(self._pick_toggled)
        crow.addWidget(self.b_pick)
        b_auto = QPushButton("Auto (Bildrand)")
        b_auto.setToolTip("Häufigste Farbe am Bildrand als Hintergrundfarbe übernehmen")
        b_auto.clicked.connect(self._auto_color)
        crow.addWidget(b_auto)
        crow.addStretch(1)
        fc.addRow("Hintergrundfarbe:", crow)
        qrow = QHBoxLayout()
        for name, c in (("Grün", (0, 177, 64)), ("Blau", (0, 71, 187)), ("Weiß", (255, 255, 255))):
            b = QPushButton(name)
            b.clicked.connect(lambda _=False, c=c, n=name: self._quick_color(c, n == "Weiß"))
            qrow.addWidget(b)
        fc.addRow("Schnellwahl:", qrow)
        self.s_tol = slider_row(0.0, 1.0, 0.22, 0.01, 3)
        self.s_tol.setToolTip("Wie ähnlich eine Farbe dem Hintergrund sein darf, "
                              "um komplett transparent zu werden.")
        fc.addRow("Toleranz:", self.s_tol)
        self.s_soft = slider_row(0.0, 1.0, 0.18, 0.01, 3)
        self.s_soft.setToolTip("Breite des weichen Übergangs (Graduierung).")
        fc.addRow("Weicher Übergang:", self.s_soft)
        self.s_despill = slider_row(0.0, 1.0, 0.8, 0.05, 2)
        self.s_despill.setToolTip("Entfernt grünen/blauen Farbschimmer am Motiv.")
        fc.addRow("Farbsaum entfernen:", self.s_despill)
        self.ck_unmix = QCheckBox("Kantenfarben vom Hintergrund entmischen")
        fc.addRow(self.ck_unmix)
        self.ck_edge = QCheckBox("Nur vom Bildrand aus entfernen (weißes Hemd vor weißer Wand bleibt)")
        self.ck_edge.setToolTip("Entfernt nur Hintergrund, der mit dem Bildrand verbunden ist. "
                                "Große, gleichmäßige Lücken (z. B. zwischen Arm und Körper) "
                                "werden trotzdem entfernt.")
        fc.addRow(self.ck_edge)
        pv.addWidget(self.g_chroma)

        # Kanten
        self.g_edge = QGroupBox("Kanten feinjustieren")
        fe = QFormLayout(self.g_edge)
        self.ck_refine = QCheckBox("Kanten an Bilddetails anpassen (Haare)")
        fe.addRow(self.ck_refine)
        self.s_dehalo = slider_row(0.0, 1.0, 0.4, 0.05, 2)
        self.s_dehalo.setToolTip("Entfernt den hellen/farbigen Schleier („Aura“) um die Figur. "
                                 "Höher = sauberere Kante, bei sehr feinen Haaren evtl. etwas weniger Detail.")
        fe.addRow("Aura entfernen:", self.s_dehalo)
        self.s_choke = slider_row(-10.0, 10.0, 0.0, 0.5, 1, " px")
        self.s_choke.setToolTip("Positiv = Kante nach innen ziehen, negativ = erweitern.")
        fe.addRow("Kante schrumpfen:", self.s_choke)
        self.s_feather = slider_row(0.0, 10.0, 0.0, 0.25, 2, " px")
        fe.addRow("Weichzeichnen:", self.s_feather)
        self.s_lo = slider_row(0.0, 0.9, 0.0, 0.01, 2)
        self.s_lo.setToolTip("Leicht transparente Reste unterhalb dieses Werts entfernen.")
        fe.addRow("Alpha-Schwarzpunkt:", self.s_lo)
        self.s_hi = slider_row(0.1, 1.0, 1.0, 0.01, 2)
        self.s_hi.setToolTip("Fast deckende Stellen ab diesem Wert ganz deckend machen.")
        fe.addRow("Alpha-Weißpunkt:", self.s_hi)
        b_reset = QPushButton("Kanten-Einstellungen zurücksetzen")
        b_reset.clicked.connect(self._reset_edges)
        fe.addRow(b_reset)
        pv.addWidget(self.g_edge)

        # Export
        g_exp = QGroupBox("Export")
        fx = QFormLayout(g_exp)
        self.cb_fmt = QComboBox()
        for k, v in P.FORMATS.items():
            self.cb_fmt.addItem(v, k)
        self.cb_fmt.currentIndexChanged.connect(self._fmt_changed)
        fx.addRow("Format:", self.cb_fmt)
        self.cb_q = QComboBox()
        self.cb_q.addItem("Hoch", "hoch")
        self.cb_q.addItem("Mittel", "mittel")
        self.cb_q.addItem("Klein (Web)", "klein")
        fx.addRow("Qualität:", self.cb_q)
        self.cb_size = QComboBox()
        for label, hh in (("Original", 0), ("2160p", 2160), ("1440p", 1440), ("1080p", 1080),
                          ("720p", 720), ("540p", 540), ("480p", 480)):
            self.cb_size.addItem(label, hh)
        fx.addRow("Größe (Höhe max.):", self.cb_size)
        self.ck_audio = QCheckBox("Ton mitnehmen")
        fx.addRow(self.ck_audio)
        self.b_mp4bg = QPushButton()
        self.b_mp4bg.clicked.connect(self._choose_mp4bg)
        self.lbl_mp4bg = QLabel("Hintergrund für MP4:")
        fx.addRow(self.lbl_mp4bg, self.b_mp4bg)
        self.b_export = QPushButton("Exportieren…")
        self.b_export.setMinimumHeight(38)
        self.b_export.setStyleSheet("font-weight:bold;font-size:14px;")
        self.b_export.clicked.connect(self.start_export)
        fx.addRow(self.b_export)
        self.pbar = QProgressBar()
        self.pbar.setRange(0, 1000)
        self.pbar.setTextVisible(True)
        self.pbar.setFormat("")
        self.b_cancel = QPushButton("Abbrechen")
        self.b_cancel.setEnabled(False)
        self.b_cancel.clicked.connect(self.cancel_export)
        prow = QHBoxLayout()
        prow.addWidget(self.pbar, 1)
        prow.addWidget(self.b_cancel)
        fx.addRow(prow)
        pv.addWidget(g_exp)
        pv.addStretch(1)

        for cb in panel.findChildren(QComboBox):
            cb.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
            cb.setMinimumContentsLength(16)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setWidget(panel)
        scroll.setMinimumWidth(470)
        splitter.addWidget(scroll)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([960, 480])

        # Alle Regler aktualisieren die Vorschau
        for w in (self.s_dehalo, self.s_detail, self.s_tol, self.s_soft, self.s_despill, self.s_choke,
                  self.s_feather, self.s_lo, self.s_hi):
            w.spin.valueChanged.connect(self.settings_changed)
        for c in (self.ck_edgecol, self.ck_gpu, self.ck_unmix, self.ck_edge, self.ck_refine):
            c.toggled.connect(self.settings_changed)

        for key, fn in (("Space", self.toggle_play), ("I", self.set_in), ("O", self.set_out),
                        ("Left", lambda: self.seek(self.frame_idx - 1)),
                        ("Right", lambda: self.seek(self.frame_idx + 1)),
                        ("Shift+Left", lambda: self.seek_seconds(-1)),
                        ("Shift+Right", lambda: self.seek_seconds(1)),
                        ("Home", lambda: self.seek(0)),
                        ("End", lambda: self.seek(10 ** 9)),
                        ("Ctrl+O", self.open_dialog), ("Ctrl+E", self.start_export)):
            QShortcut(QKeySequence(key), self, activated=fn)

        self.key_color = (0, 177, 64)
        self.mp4_bg = (255, 255, 255)
        self.custom_bg: np.ndarray | None = None

    # -------------------------------------------------------- Einstellungen
    def current_settings(self) -> P.KeySettings:
        return P.KeySettings(
            mode=self.cb_mode.currentData(),
            key_color=self.key_color,
            tolerance=self.s_tol.spin.value(),
            softness=self.s_soft.spin.value(),
            despill=self.s_despill.spin.value(),
            unmix=self.ck_unmix.isChecked(),
            from_edge=self.ck_edge.isChecked(),
            ai_quality=self.cb_aiq.currentData(),
            ai_detail=self.s_detail.spin.value(),
            ai_edge_colors=self.ck_edgecol.isChecked(),
            use_gpu=self.ck_gpu.isChecked(),
            choke=self.s_choke.spin.value(),
            feather=self.s_feather.spin.value(),
            refine=self.ck_refine.isChecked(),
            dehalo=self.s_dehalo.spin.value(),
            alpha_low=self.s_lo.spin.value(),
            alpha_high=self.s_hi.spin.value(),
        )

    def _apply_settings(self, s: P.KeySettings):
        self.cb_mode.setCurrentIndex(max(0, self.cb_mode.findData(s.mode)))
        self.cb_aiq.setCurrentIndex(max(0, self.cb_aiq.findData(s.ai_quality)))
        self._set_key_color(s.key_color, render=False)
        self.s_tol.spin.setValue(s.tolerance)
        self.s_soft.spin.setValue(s.softness)
        self.s_despill.spin.setValue(s.despill)
        self.ck_unmix.setChecked(s.unmix)
        self.ck_edge.setChecked(s.from_edge)
        self.s_detail.spin.setValue(s.ai_detail)
        self.ck_edgecol.setChecked(s.ai_edge_colors)
        self.ck_gpu.setChecked(s.use_gpu)
        self.s_choke.spin.setValue(s.choke)
        self.s_feather.spin.setValue(s.feather)
        self.ck_refine.setChecked(s.refine)
        self.s_dehalo.spin.setValue(s.dehalo)
        self.s_lo.spin.setValue(s.alpha_low)
        self.s_hi.spin.setValue(s.alpha_high)

    def _load_settings(self):
        try:
            s = P.KeySettings.from_dict(json.loads(self.qs.value("key", "{}")))
        except Exception:  # noqa: BLE001
            s = P.KeySettings()
        self._apply_settings(s)
        exp = {}
        try:
            exp = json.loads(self.qs.value("export", "{}"))
        except Exception:  # noqa: BLE001
            pass
        self.cb_fmt.setCurrentIndex(max(0, self.cb_fmt.findData(exp.get("fmt", "webm"))))
        self.cb_q.setCurrentIndex(max(0, self.cb_q.findData(exp.get("quality", "hoch"))))
        self.cb_size.setCurrentIndex(max(0, self.cb_size.findData(exp.get("max_height", 0))))
        self.ck_audio.setChecked(exp.get("audio", True))
        self._set_mp4bg(tuple(exp.get("bg", (255, 255, 255))))
        self._mode_changed()
        self._fmt_changed()

    def _save_settings(self):
        self.qs.setValue("key", json.dumps(self.current_settings().to_dict()))
        self.qs.setValue("export", json.dumps({
            "fmt": self.cb_fmt.currentData(), "quality": self.cb_q.currentData(),
            "max_height": self.cb_size.currentData(), "audio": self.ck_audio.isChecked(),
            "bg": list(self.mp4_bg),
        }))

    def closeEvent(self, e):
        if self.export_thread and self.export_thread.isRunning():
            if QMessageBox.question(self, "Export läuft",
                                    "Ein Export läuft noch. Wirklich beenden?") != \
                    QMessageBox.StandardButton.Yes:
                e.ignore()
                return
            self.export_thread.cancel()
            self.export_thread.wait(5000)
        self._save_settings()
        super().closeEvent(e)

    def settings_changed(self, *_):
        self.proc_dirty = True
        self.schedule_render()

    def _mode_changed(self, *_):
        mode = self.cb_mode.currentData()
        self.g_ai.setVisible(mode == "ai")
        self.g_chroma.setVisible(mode == "chroma")
        self.g_edge.setVisible(mode != "none")
        if mode != "chroma":
            self.b_pick.setChecked(False)
        if mode == "ai":
            self._ensure_model(self.cb_aiq.currentData())
        self.settings_changed()

    def _aiq_changed(self, *_):
        if self.cb_mode.currentData() == "ai":
            self._ensure_model(self.cb_aiq.currentData())
        self.settings_changed()

    def _fmt_changed(self, *_):
        is_mp4 = self.cb_fmt.currentData() == "mp4"
        self.lbl_mp4bg.setVisible(is_mp4)
        self.b_mp4bg.setVisible(is_mp4)

    def _reset_edges(self):
        d = P.KeySettings()
        self.ck_refine.setChecked(d.refine)
        self.s_dehalo.spin.setValue(d.dehalo)
        self.s_choke.spin.setValue(d.choke)
        self.s_feather.spin.setValue(d.feather)
        self.s_lo.spin.setValue(d.alpha_low)
        self.s_hi.spin.setValue(d.alpha_high)

    def _set_key_color(self, c, render=True):
        self.key_color = tuple(int(x) for x in c)
        self.b_color.setStyleSheet(
            f"background-color: rgb{self.key_color}; border:1px solid #555; min-height:20px;")
        if render:
            self.settings_changed()

    def _choose_color(self):
        c = QColorDialog.getColor(QColor(*self.key_color), self, "Hintergrundfarbe")
        if c.isValid():
            self._set_key_color((c.red(), c.green(), c.blue()))

    def _set_mp4bg(self, c):
        self.mp4_bg = tuple(int(x) for x in c)
        self.b_mp4bg.setStyleSheet(
            f"background-color: rgb{self.mp4_bg}; border:1px solid #555; min-height:20px;")

    def _choose_mp4bg(self):
        c = QColorDialog.getColor(QColor(*self.mp4_bg), self, "Hintergrund für MP4")
        if c.isValid():
            self._set_mp4bg((c.red(), c.green(), c.blue()))

    def _quick_color(self, c, white):
        # Weiße Wand: nur zusammenhängend vom Rand aus, sonst verschwinden helle Stellen im Motiv
        self.ck_edge.setChecked(white)
        self._set_key_color(c)

    def _auto_color(self):
        if self.cur_rgb is not None:
            self._set_key_color(P.border_color(self.cur_rgb))

    def _pick_toggled(self, on):
        self.preview.pick_mode = on
        self.preview.setCursor(Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor)
        if on and self.cb_view.currentIndex() != 3:
            self.cb_view.setCurrentIndex(3)  # Original anzeigen zum Picken

    def _picked(self, rx, ry):
        if self.cur_rgb is None:
            return
        h, w = self.cur_rgb.shape[:2]
        x, y = int(rx * (w - 1)), int(ry * (h - 1))
        patch = self.cur_rgb[max(0, y - 3):y + 4, max(0, x - 3):x + 4].reshape(-1, 3)
        self._set_key_color(np.median(patch, axis=0))
        self.b_pick.setChecked(False)
        self.cb_view.setCurrentIndex(0)

    def _bg_changed(self, idx):
        if self.cb_bg.itemText(idx).startswith("Eigenes"):
            path, _ = QFileDialog.getOpenFileName(
                self, "Hintergrundbild", "", "Bilder (*.png *.jpg *.jpeg *.bmp *.webp)")
            if path:
                import cv2
                img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    self.custom_bg = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            if self.custom_bg is None:
                self.cb_bg.setCurrentIndex(0)
                return
        self.schedule_render()

    # ------------------------------------------------------------- KI-Modell
    def _ensure_model(self, quality) -> bool:
        if P.find_model(quality):
            return True
        size = "~100 MB" if quality == "hoch" else "~15 MB"
        if QMessageBox.question(
                self, "KI-Modell laden",
                f"Das KI-Modell „{quality}“ ({size}) ist noch nicht vorhanden.\n"
                "Jetzt einmalig herunterladen? Danach wird alles lokal berechnet.") != \
                QMessageBox.StandardButton.Yes:
            if quality == "hoch":
                self.cb_aiq.setCurrentIndex(0)
            return False
        dlg = QProgressDialog("KI-Modell wird geladen…", None, 0, 100, self)
        dlg.setWindowModality(Qt.WindowModality.WindowModal)
        dlg.setMinimumDuration(0)
        th = DownloadThread(quality)
        th.progress.connect(dlg.setValue)
        result = {}
        th.done.connect(lambda p: result.setdefault("ok", p))
        th.failed.connect(lambda m: result.setdefault("err", m))
        th.finished.connect(dlg.close)
        th.start()
        dlg.exec()
        th.wait()
        if "err" in result:
            QMessageBox.warning(self, "Download fehlgeschlagen", result["err"])
            return False
        self.settings_changed()
        return True

    def _matter(self, s: P.KeySettings):
        key = (s.ai_quality, s.use_gpu)
        if key not in self.matters:
            path = P.find_model(s.ai_quality)
            if path is None:
                return None
            QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
            try:
                self.matters[key] = P.AIMatter(s, path)
            finally:
                QApplication.restoreOverrideCursor()
            prov = self.matters[key].provider.replace("ExecutionProvider", "")
            self.lbl_provider.setText(
                f"Rechnet auf: {'Grafikkarte (' + prov + ')' if prov != 'CPU' else 'Prozessor (CPU)'}")
        return self.matters[key]

    # ------------------------------------------------------------- Video
    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e):
        urls = e.mimeData().urls()
        if urls:
            self.open_video(urls[0].toLocalFile())

    def open_dialog(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Video öffnen", self.qs.value("last_dir", ""), VIDEO_FILTER)
        if path:
            self.open_video(path)

    def open_video(self, path):
        try:
            QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
            info = P.probe(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Fehler", str(exc))
            return
        finally:
            QApplication.restoreOverrideCursor()
        self.stop()
        if self.reader:
            self.reader.close()
        self.info = info
        self.reader = P.FrameReader(path)
        self.qs.setValue("last_dir", str(Path(path).parent))
        self.lbl_file.setText(f"{Path(path).name}   {info.width}×{info.height}, "
                              f"{info.fps_float:.2f} fps, {fmt_time(info.duration)}"
                              f"{'' if info.has_audio else ', ohne Ton'}")
        self.setWindowTitle(f"Video-Freisteller – {Path(path).name}")
        self.timeline.total = info.frame_count
        self.timeline.mark_in = 0
        self.timeline.mark_out = info.frame_count - 1
        self.timeline.segments = []
        self.seg_list.clear()
        self._update_inout()
        self.proc_dirty = True
        self.seek(0)

    def t_of(self, f):
        return f / self.info.fps_float if self.info else 0.0

    def seek(self, idx):
        if not self.info:
            return
        idx = int(min(max(idx, 0), self.info.frame_count - 1))
        rgb = self.reader.read(idx)
        if rgb is None:
            # Ende der Datei kann laut Metadaten etwas spaeter liegen
            if idx > 0 and idx == self.info.frame_count - 1:
                self.info.frame_count -= 1
                self.timeline.total = self.info.frame_count
                self.timeline.mark_out = min(self.timeline.mark_out, self.info.frame_count - 1)
                return self.seek(idx - 1)
            return
        self.frame_idx = idx
        self.cur_rgb = rgb
        self.timeline.pos = idx
        self.timeline.update()
        self.lbl_time.setText(f"{fmt_time(self.t_of(idx))} / {fmt_time(self.info.duration)}"
                              f"   (Bild {idx + 1})")
        if self.play_timer.isActive():
            self._render()
        else:
            self.schedule_render()

    def seek_seconds(self, d):
        if self.info:
            self.seek(self.frame_idx + int(round(d * self.info.fps_float)))

    def toggle_play(self):
        if not self.info:
            return
        if self.play_timer.isActive():
            self.stop()
        else:
            if self.frame_idx >= self.info.frame_count - 1:
                self.seek(0)
            self.play_timer.start(int(1000 / max(1.0, self.info.fps_float)))
            self.b_play.setText("❚❚  Pause")

    def stop(self):
        self.play_timer.stop()
        self.b_play.setText("▶  Abspielen")

    def _play_tick(self):
        if self.frame_idx >= self.info.frame_count - 1:
            self.stop()
            return
        self.seek(self.frame_idx + 1)

    # ------------------------------------------------------------- Schnitt
    def set_in(self):
        if self.info:
            self.timeline.mark_in = self.frame_idx
            if self.timeline.mark_out < self.frame_idx:
                self.timeline.mark_out = self.info.frame_count - 1
            self._update_inout()

    def set_out(self):
        if self.info:
            self.timeline.mark_out = self.frame_idx
            if self.timeline.mark_in > self.frame_idx:
                self.timeline.mark_in = 0
            self._update_inout()

    def _update_inout(self):
        a, b = self.timeline.mark_in, self.timeline.mark_out
        self.lbl_inout.setText(
            f"Bereich: {fmt_time(self.t_of(a))} – {fmt_time(self.t_of(b + 1))}  "
            f"(Länge {fmt_time(self.t_of(b + 1 - a))})")
        self.timeline.update()

    def add_segment(self):
        if not self.info:
            return
        a, b = self.timeline.mark_in, self.timeline.mark_out
        self.timeline.segments.append((a, b))
        self.seg_list.addItem(f"{len(self.timeline.segments)}.  {fmt_time(self.t_of(a))} – "
                              f"{fmt_time(self.t_of(b + 1))}")
        self.timeline.update()

    def remove_segment(self):
        row = self.seg_list.currentRow()
        if row < 0:
            return
        del self.timeline.segments[row]
        self.seg_list.clear()
        for i, (a, b) in enumerate(self.timeline.segments):
            self.seg_list.addItem(f"{i + 1}.  {fmt_time(self.t_of(a))} – "
                                  f"{fmt_time(self.t_of(b + 1))}")
        self.timeline.update()

    def _jump_segment(self, item):
        a, b = self.timeline.segments[self.seg_list.row(item)]
        self.timeline.mark_in, self.timeline.mark_out = a, b
        self._update_inout()
        self.seek(a)

    def export_segments(self):
        segs = self.timeline.segments or [(self.timeline.mark_in, self.timeline.mark_out)]
        return [(self.t_of(a), self.t_of(b + 1)) for a, b in segs]

    # ------------------------------------------------------------- Vorschau
    def schedule_render(self, *_):
        self.update_timer.start()

    def _render(self):
        if self.cur_rgb is None:
            return
        rgb = self.cur_rgb
        h, w = rgb.shape[:2]
        sc = min(1.0, PREVIEW_MAX / max(h, w))
        if sc < 1.0:
            import cv2
            rgb = cv2.resize(rgb, (int(w * sc) // 2 * 2, int(h * sc) // 2 * 2),
                             interpolation=cv2.INTER_AREA)
        view = self.cb_view.currentIndex()
        s = self.current_settings()
        if view == 3 or s.mode == "none":
            self.preview.set_image(to_qimage(rgb))
            return

        try:
            if self.proc_dirty or self.processor is None:
                matter = self._matter(s) if s.mode == "ai" else None
                if s.mode == "ai" and matter is None:
                    self.preview.set_image(to_qimage(rgb))
                    return
                self.processor = P.Processor(s, px_scale=sc, matter=matter)
                self.proc_dirty = False
                self.last_processed_idx = -10
            sequential = (self.frame_idx == self.last_processed_idx + 1
                          and self.play_timer.isActive())
            if not sequential:
                self.processor.reset()
            rgba = self.processor(rgb, warmup=0 if sequential else 3)
            self.last_processed_idx = self.frame_idx
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.stop()
            QMessageBox.critical(self, "Fehler bei der Freistellung", str(exc))
            self.cb_mode.setCurrentIndex(self.cb_mode.findData("none"))
            return

        if view == 2:
            a = rgba[..., 3]
            out = np.repeat(a[..., None], 3, axis=-1)
        else:
            out = P.composite(rgba, self._preview_bg(rgba.shape[0], rgba.shape[1]))
            if view == 1:
                half = out.shape[1] // 2
                out = out.copy()
                out[:, :half] = rgb[:, :half]
                out[:, half - 1:half + 1] = (240, 70, 70)
        self.preview.set_image(to_qimage(out))

    def _preview_bg(self, h, w):
        name = self.cb_bg.currentText()
        if name == "Schwarz":
            return (0, 0, 0)
        if name == "Weiß":
            return (255, 255, 255)
        if name == "Grau":
            return (128, 128, 128)
        if name == "Grün":
            return (0, 177, 64)
        if name.startswith("Eigenes") and self.custom_bg is not None:
            import cv2
            return cv2.resize(self.custom_bg, (w, h), interpolation=cv2.INTER_AREA)
        return P.checkerboard(h, w)

    # ------------------------------------------------------------- Export
    def start_export(self):
        if not self.info:
            QMessageBox.information(self, "Export", "Bitte zuerst ein Video öffnen.")
            return
        if self.export_thread and self.export_thread.isRunning():
            return
        s = self.current_settings()
        model = None
        if s.mode == "ai":
            if not self._ensure_model(s.ai_quality):
                return
            model = P.find_model(s.ai_quality)
        fmt = self.cb_fmt.currentData()
        src = Path(self.info.path)
        suffix = "_freigestellt" if s.mode != "none" else "_schnitt"
        default = str(Path(self.qs.value("last_out_dir", str(src.parent)))
                      / f"{src.stem}{suffix}.{fmt}")
        out, _ = QFileDialog.getSaveFileName(self, "Exportieren als", default,
                                             f"{fmt.upper()} (*.{fmt})")
        if not out:
            return
        if not out.lower().endswith("." + fmt):
            out += "." + fmt
        if os.path.abspath(out) == os.path.abspath(self.info.path):
            QMessageBox.warning(self, "Export", "Bitte einen anderen Dateinamen als das Original wählen.")
            return
        self.qs.setValue("last_out_dir", str(Path(out).parent))
        self._save_settings()

        job = P.ExportJob(
            info=self.info, out_path=out, segments=self.export_segments(), settings=s,
            fmt=fmt, quality=self.cb_q.currentData(), max_height=self.cb_size.currentData(),
            audio=self.ck_audio.isChecked(), bg_color=self.mp4_bg,
        )
        self.stop()
        self.export_thread = ExportThread(job, model)
        self.export_thread.progress.connect(self._exp_progress)
        self.export_thread.done.connect(self._exp_done)
        self.export_thread.failed.connect(self._exp_failed)
        self.b_export.setEnabled(False)
        self.b_cancel.setEnabled(True)
        self.pbar.setValue(0)
        self.pbar.setFormat("Starte…")
        self.export_thread.start()

    def cancel_export(self):
        if self.export_thread:
            self.export_thread.cancel()

    def _exp_progress(self, f, text):
        self.pbar.setValue(int(f * 1000))
        self.pbar.setFormat(f"{f * 100:.0f} %  –  {text}")

    def _exp_finish(self):
        self.b_export.setEnabled(True)
        self.b_cancel.setEnabled(False)

    def _exp_done(self, path):
        self._exp_finish()
        self.pbar.setValue(1000)
        self.pbar.setFormat("Fertig ✓")
        box = QMessageBox(self)
        box.setWindowTitle("Export fertig")
        box.setText(f"Gespeichert:\n{path}")
        b_folder = box.addButton("Ordner öffnen", QMessageBox.ButtonRole.ActionRole)
        box.addButton(QMessageBox.StandardButton.Ok)
        box.exec()
        if box.clickedButton() == b_folder:
            if os.name == "nt":
                import subprocess
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
            else:
                from PySide6.QtCore import QUrl
                from PySide6.QtGui import QDesktopServices
                QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(path).parent)))

    def _exp_failed(self, msg):
        self._exp_finish()
        self.pbar.setFormat(msg.splitlines()[0] if msg else "Fehler")
        if msg != "Abgebrochen.":
            QMessageBox.critical(self, "Export fehlgeschlagen", msg[-3000:])


def main():
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("ergoforyou.videofreisteller")
        except Exception:  # noqa: BLE001
            pass
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setApplicationName("Video-Freisteller")
    win = MainWindow()
    win.show()
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        win.open_video(sys.argv[1])
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
