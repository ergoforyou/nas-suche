"""Zeichnet eine einfache Testfigur (Front-, Seiten-, Rückansicht oder Turnaround-Blatt)."""

import sys

from PIL import Image, ImageDraw

SKIN, SHIRT, PANTS = (250, 215, 190, 255), (60, 120, 220, 255), (40, 40, 60, 255)
HAIR, SHOE, EYE = (120, 70, 30, 255), (30, 30, 30, 255), (30, 60, 120, 255)


def _front(d, cx, tpose=False, back=False):
    d.rounded_rectangle([cx - 70, 500, cx - 15, 940], 20, fill=PANTS)
    d.rounded_rectangle([cx + 15, 500, cx + 70, 940], 20, fill=PANTS)
    d.ellipse([cx - 85, 920, cx - 5, 975], fill=SHOE)
    d.ellipse([cx + 5, 920, cx + 85, 975], fill=SHOE)
    if tpose:
        d.rounded_rectangle([cx - 290, 205, cx - 80, 250], 20, fill=SHIRT)
        d.rounded_rectangle([cx + 80, 205, cx + 290, 250], 20, fill=SHIRT)
        d.ellipse([cx - 300, 200, cx - 250, 255], fill=SKIN)
        d.ellipse([cx + 250, 200, cx + 300, 255], fill=SKIN)
    else:
        d.polygon([(cx - 100, 200), (cx - 60, 210), (cx - 130, 480), (cx - 170, 470)], fill=SHIRT)
        d.polygon([(cx + 100, 200), (cx + 60, 210), (cx + 130, 480), (cx + 170, 470)], fill=SHIRT)
        d.ellipse([cx - 180, 460, cx - 120, 530], fill=SKIN)
        d.ellipse([cx + 120, 460, cx + 180, 530], fill=SKIN)
    d.rounded_rectangle([cx - 100, 190, cx + 100, 540], 35, fill=SHIRT)
    d.rectangle([cx - 20, 150, cx + 20, 200], fill=SKIN if not back else HAIR)
    d.ellipse([cx - 75, 25, cx + 75, 175], fill=SKIN)
    if back:
        d.ellipse([cx - 78, 15, cx + 78, 178], fill=HAIR)
        d.text((cx - 22, 280), "7", fill=(255, 255, 255, 255), font_size=110)
    else:
        d.chord([cx - 80, 15, cx + 80, 150], 180, 360, fill=HAIR)
        d.ellipse([cx - 40, 85, cx - 20, 110], fill=EYE)
        d.ellipse([cx + 20, 85, cx + 40, 110], fill=EYE)
        d.arc([cx - 25, 115, cx + 25, 150], 20, 160, fill=(150, 40, 40, 255), width=4)


def _side(d, cx):
    """Profile looking to the right: belly in front, nose, feet pointing forward."""
    d.rounded_rectangle([cx - 30, 500, cx + 25, 940], 20, fill=PANTS)
    d.ellipse([cx - 35, 920, cx + 75, 975], fill=SHOE)
    d.rounded_rectangle([cx - 55, 190, cx + 50, 540], 35, fill=SHIRT)
    d.ellipse([cx - 20, 330, cx + 75, 500], fill=SHIRT)  # belly
    d.rectangle([cx - 15, 150, cx + 20, 200], fill=SKIN)
    d.ellipse([cx - 70, 25, cx + 65, 175], fill=SKIN)
    d.polygon([(cx + 60, 90), (cx + 85, 118), (cx + 58, 122)], fill=SKIN)  # nose
    d.pieslice([cx - 80, 15, cx + 70, 160], 150, 300, fill=HAIR)
    d.ellipse([cx + 30, 88, cx + 42, 108], fill=EYE)
    d.rounded_rectangle([cx - 22, 205, cx + 18, 470], 18, fill=SHIRT)  # arm
    d.ellipse([cx - 28, 455, cx + 26, 520], fill=SKIN)


def make_figure(path: str, bg=None, tpose: bool = False, view: str = "front") -> None:
    W, H = 600, 1000
    img = Image.new("RGBA", (W, H), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if view == "side":
        _side(d, W // 2)
    else:
        _front(d, W // 2, tpose=tpose, back=view == "back")
    img.save(path)


def make_sheet(path: str) -> None:
    """Turnaround sheet: front | side | back on white."""
    sheet = Image.new("RGBA", (1800, 1000), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    _front(d, 300)
    _side(d, 900)
    _front(d, 1500, back=True)
    sheet.save(path)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "figur.png"
    view = sys.argv[2] if len(sys.argv) > 2 else "front"
    make_sheet(out) if view == "sheet" else make_figure(out, view=view)
