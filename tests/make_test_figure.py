"""Zeichnet eine einfache Testfigur (A-Pose) auf transparentem Hintergrund."""

import sys

from PIL import Image, ImageDraw


def make_figure(path: str, bg=None, tpose: bool = False) -> None:
    W, H = 600, 1000
    img = Image.new("RGBA", (W, H), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    skin, shirt, pants, hair, shoe = (250, 215, 190, 255), (60, 120, 220, 255), (40, 40, 60, 255), (120, 70, 30, 255), (30, 30, 30, 255)
    cx = W // 2
    # legs
    d.rounded_rectangle([cx - 70, 500, cx - 15, 940], 20, fill=pants)
    d.rounded_rectangle([cx + 15, 500, cx + 70, 940], 20, fill=pants)
    d.ellipse([cx - 85, 920, cx - 5, 975], fill=shoe)
    d.ellipse([cx + 5, 920, cx + 85, 975], fill=shoe)
    # arms
    if tpose:
        d.rounded_rectangle([cx - 290, 205, cx - 80, 250], 20, fill=shirt)
        d.rounded_rectangle([cx + 80, 205, cx + 290, 250], 20, fill=shirt)
        d.ellipse([cx - 300, 200, cx - 250, 255], fill=skin)
        d.ellipse([cx + 250, 200, cx + 300, 255], fill=skin)
    else:
        d.polygon([(cx - 100, 200), (cx - 60, 210), (cx - 130, 480), (cx - 170, 470)], fill=shirt)
        d.polygon([(cx + 100, 200), (cx + 60, 210), (cx + 130, 480), (cx + 170, 470)], fill=shirt)
        d.ellipse([cx - 180, 460, cx - 120, 530], fill=skin)
        d.ellipse([cx + 120, 460, cx + 180, 530], fill=skin)
    # torso
    d.rounded_rectangle([cx - 100, 190, cx + 100, 540], 35, fill=shirt)
    d.rectangle([cx - 20, 150, cx + 20, 200], fill=skin)
    # head
    d.ellipse([cx - 75, 25, cx + 75, 175], fill=skin)
    d.chord([cx - 80, 15, cx + 80, 150], 180, 360, fill=hair)
    d.ellipse([cx - 40, 85, cx - 20, 110], fill=(30, 60, 120, 255))
    d.ellipse([cx + 20, 85, cx + 40, 110], fill=(30, 60, 120, 255))
    d.arc([cx - 25, 115, cx + 25, 150], 20, 160, fill=(150, 40, 40, 255), width=4)
    img.save(path)


if __name__ == "__main__":
    make_figure(sys.argv[1] if len(sys.argv) > 1 else "figur.png")
