# MiniMax H3 – ComfyUI Video-Workflows

| Datei | Läuft | Inhalt |
|---|---|---|
| `minimax-h3-lokal-workflow.json` | **lokal** (Open Weights) | Start-/Endbild → Video mit Ton, Format + Dauer wählbar, Probelauf (Turbo-LoRA), lokaler Upscaler |
| `minimax-h3-lokal-lang-4teile.json` | **lokal** | langes Video aus bis zu 4 Teilen (5 Schlüsselbilder), Ton abschaltbar, ohne Subgraph |
| `minimax-h3-lokal-geschichte-kette.json` | **lokal** | fortlaufende Geschichte: 4 Szenen, letztes Bild jeder Szene = Startbild der nächsten, gemeinsamer Szenen-Block, Dauer pro Szene |
| `minimax-h3-lokal-40s.json` | **lokal** | 40 s in einem Rutsch: 4 × 10 s Kette, 768p, 8er-Turbo, Farbabgleich an, Einzelszenen + Gesamtvideo |
| `minimax-h3-lokal-geschichte-6szenen.json` | **lokal** | wie Geschichte-Kette, aber 6 Szenen (≈ 48–60 s), jede Szene zusätzlich einzeln gespeichert, Gesamtvideo mit und ohne Ton |
| `minimax-h3-lokal-geschichte-ki-regie.json` | **lokal** | 6 Szenen + lokales Sprachmodell (Gemma 4 E4B): KI sieht das Startbild jeder Szene und schreibt den H3-Prompt aus Geschichte + Kurznotiz |
| `minimax-h3-lokal-ki-regie-auto.json` | **lokal** | KI-Regie automatisch: eine Geschichte eingeben → KI plant die Szenen, schreibt jeden H3-Prompt (sieht das jeweilige Startbild) → Video in einem Durchlauf (3 Szenen ≈ 30 s, Szene 4 zuschaltbar) |
| `minimax-h3-lokal-schnell-768p.json` | **lokal** | einfach & schnell: 768p, Turbo-LoRA 4 Schritte, Ton abschaltbar |
| `minimax-h3-video-workflow.json` | über die Comfy-API (Credits) | dasselbe über die API-Nodes, inkl. „Regenerate to 2K“ |

Datei per Drag & Drop in ComfyUI ziehen. Die lokale Version basiert auf der offiziellen Comfy-Vorlage
`video_minimax_h3_i2v` (H3 steckt dort als Subgraph – Doppelklick öffnet die Innereien).

## Modelle für die lokale Version (Hugging Face: Comfy-Org/MiniMax-H3)

```
ComfyUI/models/
├── diffusion_models/  minimax_h3_fl2va_pruned_int8_convrot.safetensors        (19,5 GB)
├── text_encoders/     qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors            (14,6 GB)
├── vae/               minimax_h3_video_vae_int8_convrot.safetensors           (2,6 GB)
│                      minimax_h3_audio_vae_fp32.safetensors                   (0,6 GB)
├── loras/             minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors (1,8 GB, lightx2v/Minimax-h3-Turbo)
├── loras/             minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors (1,8 GB, nur „schnell-768p“)
├── text_encoders/     gemma4_e4b_it_fp8_scaled.safetensors (nur „ki-regie“, Comfy-Org/gemma-4)
└── upscale_models/    RealESRGAN_x2.pth  (nur für den Upscaler)
```

ComfyUI vorher aktualisieren (H3-Support seit August 2026).

## Bedienung

1. **Bilder:** Startbild + Endbild laden. Ohne Endbild: Node markieren, `Ctrl+B`. Ohne beide: reines Text-zu-Video.
2. **Größe:** Gruppe 2a „Exakte Maße“ – Breite × Höhe in Pixel, automatisch auf Vielfache von 32 gerundet.
   Schalter aus → Node „Format“ (Seitenverhältnis + Megapixel, 0.4 ≈ 864×480 … 0.98 ≈ 1344×768).
   Exakte Endgröße (z. B. 1920×1080) im Upscaler-Node „Endgröße“.
3. **Dauer:** `duration` im H3-Node, bis ca. 15 s bei 24 fps.
4. **Probelauf:** `turbo_mode` an (8 Schritte), 0.4 MP, kurze Dauer.
   **Final:** `turbo_mode` aus (20 Schritte), 0.98 MP, gleicher Seed.
5. **Bild abschalten:** Bild-Node anklicken, `Ctrl+B` (Bypass). Nochmal `Ctrl+B` = wieder an.
6. **Zwischenbild:** Gruppe 4 mit `Ctrl+M` aktivieren, H3-Node + Speichern in Gruppe 2 stummschalten.
   Erzeugt Start → Zwischenbild und Zwischenbild → Ende und setzt beides (Bild + Ton) zusammen.
7. **Upscaler:** Gruppe 3 markieren, `Ctrl+M`. Braucht viel System-RAM (15 s bei 1344×768 ×2 ≈ 18 GB).

Das hostbasierte „Regenerate to 2K“ ist nicht Teil der Open Weights – lokal übernimmt das der Upscaler.
