# Klein Canny Reference – Erweiterung für Forge Neo

„ControlNet-Canny“-ähnliche Steuerung für **Flux.2 Klein (4B / 9B)** in
[Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo).

Du lädst ein Vorlagenbild hoch. Die Erweiterung macht daraus eine Canny-Kantenkarte
und gibt sie Klein als **Referenzbild** (Reference Latent) mit – genau wie in ComfyUI mit
`ReferenceLatent`. Zusätzlich wird an den Prompt eine Anweisung angehängt, dass Klein
den Konturen von „image N“ folgen soll.

> Hinweis: Für Flux.2 Klein gibt es keine klassischen ControlNet-Modelle, und Forge Neos
> ControlNet-Tab unterstützt Flux.2 nicht. Klein kann Kantenkarten aber nativ als
> Referenzbild lesen. Darum braucht es **kein zusätzliches Modell**.

## Installation

1. Den Ordner `sd-forge-klein-canny` nach `<forge-neo>/extensions/` kopieren.
2. Forge Neo neu starten.
3. Danach gibt es in **txt2img** und **img2img** das Akkordeon **„Klein Canny Reference“**.

## Benutzung

1. Ein Flux.2-Klein-Modell laden (4B oder 9B).
2. Das Akkordeon aktivieren und ein Vorlagenbild hochladen. Die Vorschau zeigt die Canny-Karte.
3. Prompt schreiben, z. B. `a knight in golden armor, cinematic lighting`, und auf **Generate** klicken.

| Option | Bedeutung |
|---|---|
| **Mode** | `Canny` = nur Kanten · `Canny + Original` = Kanten und Originalbild (übernimmt auch Farben/Inhalt) · `Original` = Bild unverändert als Referenz |
| **Low/High threshold** | Canny-Schwellen. Niedrigere Werte ergeben mehr Linien. |
| **Blur** | Weichzeichnen vor Canny, gegen Rauschen und feine Texturen |
| **Invert** | Schwarze Linien auf Weiß statt Weiß auf Schwarz |
| **Match output size** | txt2img: Breite und Höhe werden an das Seitenverhältnis der Vorlage angepasst. Das ist wichtig, damit die Kanten passen. |
| **Reference max side** | Maximale Kantenlänge der Referenz (und der Ausgabe, wenn „Match“ aktiv ist) |
| **Instruction** | Vorlage für den Prompt, der an Klein geht. `{n}` = Bildnummer, `{prompt}` = dein Prompt |

`[Klein] Enable Reference` wird bei Bedarf nur für diese Generierung eingeschaltet und danach
wieder zurückgesetzt. Die Erweiterung lässt sich mit dem eingebauten **ImageStitch** kombinieren.
Dessen Bilder bekommen die Nummern zuerst, die Canny-Karte folgt danach.

## Tipps

- Die Stärke lässt sich nicht per Regler einstellen wie bei ControlNet, denn Referenzbilder haben
  kein „Weight“. Steuern kannst du über die **Instruction**, zum Beispiel „loosely follow“ statt
  „exactly“, und über die Canny-Schwellen.
- Bei zu vielen Linien die Schwellen erhöhen (z. B. 150/250) oder Blur auf 2–3 stellen.
- Zeichnet Klein die Linien sichtbar mit, hilft eine deutlichere Anweisung wie „…without any visible lines or edge map artifacts“.
