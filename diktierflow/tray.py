"""Symbol im Infobereich der Taskleiste."""

from __future__ import annotations

from typing import Callable


def _icon_image(active: bool = False):
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, 62, 62), fill=(91, 141, 239, 255) if not active else (255, 77, 79, 255))
    # Mikrofon
    d.rounded_rectangle((24, 12, 40, 38), radius=8, fill="white")
    d.arc((17, 22, 47, 46), start=0, end=180, fill="white", width=4)
    d.line((32, 46, 32, 53), fill="white", width=4)
    d.line((23, 53, 41, 53), fill="white", width=4)
    return img


class Tray:
    def __init__(self, app, ui, on_quit: Callable[[], None], on_restart: Callable[[], None]):
        import pystray

        self.app, self.ui = app, ui
        item = pystray.MenuItem
        self.icon = pystray.Icon(
            "DiktierFlow", _icon_image(), "DiktierFlow",
            menu=pystray.Menu(
                item("Verlauf & Wörterbuch", lambda: ui.open_history(), default=True),
                item("Letztes Diktat erneut einfügen", lambda: app.paste_last()),
                item("Einstellungen", lambda: ui.open_settings()),
                item("Datenschutz-Modus (nur lokal)",
                     lambda: app.set_privacy_mode(not app.cfg.privacy_mode),
                     checked=lambda _i: app.cfg.privacy_mode),
                pystray.Menu.SEPARATOR,
                item("Neu starten", lambda: on_restart()),
                item("Beenden", lambda: on_quit()),
            ),
        )

    def start(self) -> None:
        self.icon.run_detached()

    def stop(self) -> None:
        self.icon.stop()
