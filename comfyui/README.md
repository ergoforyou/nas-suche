# MiniMax H3 – ComfyUI Video-Workflow

Datei: `minimax-h3-video-workflow.json` – per Drag & Drop in ComfyUI ziehen.

**Voraussetzungen:** ComfyUI ≥ 0.34.2 (H3-Partner-Nodes), Comfy-Konto mit Credits (H3 läuft über die API, Abrechnung pro Sekunde).
Für den optionalen lokalen Upscaler: ein Upscale-Modell, z. B. `RealESRGAN_x2.pth`, in `models/upscale_models/`.

## Gruppen

| Gruppe | Zweck | Standard |
|---|---|---|
| 1 · Startbild + Format | Startbild laden, mit `ImageScale` auf Wunschgröße bringen (Crop: center) | aktiv |
| 1b · Endbild | optionales Endbild, gleiche Größe wie Start | aktiv (`Ctrl+B` zum Überspringen) |
| 2 · Probelauf | H3 First-Last-Frame, 768P, Dauer 4–15 s | aktiv |
| 3A · Upscale 2K | H3 Regenerate → 2K mit demselben Video und denselben Frames | stumm (`Ctrl+M`) |
| 3B · Lokaler Upscaler | Video → Frames → Upscale-Modell → Video (kostenlos, viel RAM) | stumm |
| 0 · Nur Text | Text-to-Video mit Seitenverhältnis (16:9, 9:16, 1:1, 4:3, 3:4, 21:9) | stumm |
| R · Referenzen | Reference-to-Video, bis zu 9 Bilder (Figuren/Produkte) | stumm |

## Ablauf

1. Start- (und ggf. End-)bild laden, in **beiden** `ImageScale`-Nodes dieselbe Breite × Höhe setzen
   (z. B. 1280×720 quer, 720×1280 hochkant, 1024×1024 quadratisch; Seitenverhältnis 0,4–2,5).
2. Im H3-Node Prompt, Auflösung und Dauer einstellen, *Queue* → Probelauf ansehen.
3. Passt das Ergebnis: Gruppe 3A aktivieren, denselben Prompt einfügen, erneut *Queue*.
   Weil der Seed auf `fixed` steht, nimmt ComfyUI den Probelauf aus dem Cache – es wird nur der 2K-Upscale bezahlt.
   Für eine neue Variante: Seed ändern.

Hinweise: 2K-Regenerate akzeptiert nur 24-fps-Videos aus H3 768P (4–15 s). Die Modelle „H3 Max“/„Max Turbo“
(480P/768P, 5–15 s) lassen sich im `model`-Feld wählen – günstig für schnelle Tests.
