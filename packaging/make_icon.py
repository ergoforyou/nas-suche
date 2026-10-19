"""Erzeugt packaging/diktierflow.ico aus dem Tray-Symbol."""

from pathlib import Path

from diktierflow.tray import _icon_image

out = Path(__file__).with_name("diktierflow.ico")
_icon_image().resize((256, 256)).save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                                                  (128, 128), (256, 256)])
print(out)
