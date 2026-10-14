"""Erzeugt ein schlichtes Programmsymbol (rotes Dokument mit „PDF“)."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

groesse = 256
bild = Image.new("RGBA", (groesse, groesse), (0, 0, 0, 0))
z = ImageDraw.Draw(bild)
z.rounded_rectangle((40, 16, 216, 240), radius=22, fill=(255, 255, 255, 255), outline=(181, 18, 27, 255), width=10)
z.polygon([(166, 16), (216, 66), (166, 66)], fill=(181, 18, 27, 255))
z.rounded_rectangle((28, 130, 228, 206), radius=14, fill=(181, 18, 27, 255))
try:
    schrift = ImageFont.truetype("arialbd.ttf", 58)
except OSError:
    schrift = ImageFont.load_default()
z.text((128, 168), "PDF", fill="white", font=schrift, anchor="mm")
bild.save(Path(__file__).with_name("agentur-pdf.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
