"""Kommandozeile:  python -m bild2vrm BILD.png -o avatar.vrm   |   python -m bild2vrm --gui"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from .avatar import Options, Views, generate
from .keypoints import load_keypoints


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bild2vrm", description="Erzeugt aus einem Ganzkörperbild (Frontalansicht) eine VRM-Datei.")
    p.add_argument("image", nargs="?", help="Frontansicht (am besten PNG mit transparentem Hintergrund)")
    p.add_argument("--back", help="Rückansicht derselben Figur (optional, ersetzt die gespiegelte Rückseite)")
    p.add_argument("--side", action="append", default=[], help="Seitenansicht (optional, mehrfach möglich) – liefert das Körperprofil")
    p.add_argument("--side-facing", choices=["auto", "left", "right"], default="auto",
                   help="Blickrichtung der Figur in der Seitenansicht (Standard: automatisch)")
    p.add_argument("--sheet", help="Turnaround-Blatt (Front/Seite/Rücken nebeneinander) – wird automatisch aufgeteilt")
    p.add_argument("--no-face", action="store_true", help="Keine Gesichtsausdrücke erzeugen")
    p.add_argument("-o", "--output", help="Ziel-Datei (Standard: <bild>.vrm)")
    p.add_argument("--gui", action="store_true", help="Lokale Web-Oberfläche starten")
    p.add_argument("--port", type=int, default=8765, help="Port der Web-Oberfläche (Standard 8765)")
    p.add_argument("--no-browser", action="store_true", help="Browser beim Start der Oberfläche nicht automatisch öffnen")
    p.add_argument("--vrm", choices=["0", "1"], default="0", help="VRM-Version: 0 = VRM 0.x (VSeeFace, VMagicMirror …), 1 = VRM 1.0")
    p.add_argument("--keypoints", help="JSON-Datei mit Gelenkpunkten (überschreibt die automatische Erkennung)")
    p.add_argument("--save-keypoints", help="Verwendete Gelenkpunkte als JSON speichern (zum Nachbearbeiten)")
    p.add_argument("--pose", choices=["auto", "mediapipe", "heuristic"], default="auto", help="Gelenkerkennung")
    p.add_argument("--background", choices=["auto", "alpha", "flood", "rembg", "none"], default="auto", help="Freistellen")
    p.add_argument("--height", type=float, default=1.6, help="Körpergröße in Metern (Standard 1.6)")
    p.add_argument("--depth", type=float, default=1.0, help="Körperdicke-Faktor (0 = flach, Standard 1.0)")
    p.add_argument("--grid", type=int, default=140, help="Mesh-Auflösung über die Körperhöhe (Standard 140)")
    p.add_argument("--keep-pose", action="store_true", help="Keine T-Pose-Korrektur (Arme bleiben wie im Bild)")
    p.add_argument("--name", default=None, help="Avatar-Name (Standard: Dateiname)")
    p.add_argument("--author", default="bild2vrm", help="Autor in den VRM-Metadaten")
    a = p.parse_args(argv)

    if a.gui:
        from .webui import serve
        serve(port=a.port, open_browser=not a.no_browser)
        return 0
    if not a.image and not a.sheet:
        p.error("Bitte ein Bild (oder --sheet) angeben oder --gui verwenden.")

    src = Path(a.image or a.sheet)
    opts = Options(height=a.height, vrm_version=a.vrm, tpose=not a.keep_pose, depth=a.depth, grid=a.grid,
                   background=a.background, pose=a.pose, expressions=not a.no_face,
                   name=a.name or src.stem, author=a.author)
    kp = load_keypoints(a.keypoints) if a.keypoints else None
    try:
        front = Image.open(a.image) if a.image else None
        views = Views(back=Image.open(a.back) if a.back else None,
                      sides=[(Image.open(sp), a.side_facing) for sp in a.side])
        if a.sheet:
            from .views import split_sheet
            for fig in split_sheet(Image.open(a.sheet), a.background):
                if fig["role"] == "front" and front is None:
                    front = fig["image"]
                elif fig["role"] == "back" and views.back is None:
                    views.back = fig["image"]
                elif fig["role"] == "side":
                    views.sides.append((fig["image"], a.side_facing))
            if front is None:
                raise RuntimeError("Im Turnaround-Blatt wurde keine Frontansicht erkannt.")
        res = generate(front, opts, kp, views)
    except (RuntimeError, ValueError) as exc:
        print(f"Fehler: {exc}", file=sys.stderr)
        return 1
    out = Path(a.output or src.with_suffix(".vrm"))
    out.write_bytes(res.vrm)
    if a.save_keypoints:
        Path(a.save_keypoints).write_text(json.dumps(res.keypoints, indent=2), encoding="utf-8")
    s = res.stats
    print(f"VRM {'0.x' if a.vrm == '0' else '1.0'} gespeichert: {out}  "
          f"({s['vertices']} Vertices, {s['triangles']} Dreiecke, Textur {s['texture']}, {s['bytes'] / 1e6:.1f} MB)")
    extras = [f"Ausdrücke: {', '.join(s['expressions'])}" if s["expressions"] else "keine Ausdrücke"]
    if s["back_view"]:
        extras.append("Rückansicht verwendet")
    if s["side_views"]:
        extras.append(f"{s['side_views']} Seitenansicht(en) verwendet")
    print("  " + " · ".join(extras))
    return 0


if __name__ == "__main__":
    sys.exit(main())
