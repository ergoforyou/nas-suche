# Avatar Overlay – Machbarkeitstest (Variante B)

Ein schwebender, durchsichtiger Avatar über der ChatGPT-App. ChatGPT bleibt unverändert und
macht weiterhin Spracherkennung, Denken und Gedächtnis (über dein Abo). Diese App liest nur den
angezeigten Antworttext über die Android-Bedienungshilfen mit und lässt den Avatar ihn mit der
kostenlosen Sprachausgabe des Handys vorlesen. Keine API, keine Zusatzkosten.

Als Avatar kann ein eigenes Video gewählt werden (z. B. Idle-Animation). Es läuft stumm in
Endlosschleife; die Hintergrundfarbe (Farbe der linken oberen Ecke) wird durchsichtig gestanzt.
Am besten funktioniert ein einfarbiger Hintergrund (Grün, Schwarz, Weiß). Ohne Video erscheint
ein Platzhalter-Gesicht. Beim Sprechen pulsiert der Avatar leicht.

## Installieren

1. Unter **GitHub → Actions → „Android APK“** den neuesten Lauf öffnen und das Artefakt
   `avatar-overlay-apk` herunterladen (ZIP mit `app-debug.apk`).
2. APK aufs Handy kopieren und installieren („Installation aus unbekannten Quellen“ erlauben).
3. App öffnen → **„1. Bedienungshilfe aktivieren“** → „Avatar Overlay“ einschalten.
   Ist der Schalter ausgegraut (Android 13+): *Einstellungen → Apps → Avatar Overlay → ⋮ →
   „Eingeschränkte Einstellungen zulassen“*, dann nochmal versuchen.

## Avatar-Video einrichten

In der App unter **Avatar → „Avatar-Video auswählen“** das Video wählen. Mit **„Toleranz
Hintergrund“** einstellen, wie viel vom Hintergrund verschwindet (zu hoch = Avatar wird löchrig),
mit **„Größe“** die Größe. Änderungen greifen beim Loslassen des Reglers.

## Was wir testen

| Frage | Woran man es sieht |
|---|---|
| Kommt der Text im **Live-Modus** an? | Im Protokoll erscheinen `[KI] …`-Zeilen während ChatGPT spricht |
| Klappt es im **normalen Chat mit Diktieren**? | dito |
| Wie groß ist die **Verzögerung**? | Zeitstempel im Protokoll vs. wann ChatGPT den Text zeigt |
| Wird **dein** Text fälschlich vorgelesen? | `[DU]`-Zeilen dürfen nicht gesprochen werden |
| Wird beim **Scrollen** alter Verlauf vorgelesen? | sollte als „vermutlich gescrollt“ ignoriert werden |

ChatGPTs eigene Stimme dabei stumm schalten (bzw. im Text-Chat bleiben), sonst hörst du beide.

## Rückmeldung für die Auswertung

- **Protokoll kopieren** in der App → hier einfügen.
- Wenn etwas nicht erkannt wird: in ChatGPT auf dem betreffenden Bildschirm den **Avatar lange
  drücken** – das kopiert die Bildschirmstruktur in die Zwischenablage. Damit kann die Erkennung
  gezielt angepasst werden. (Achtung: enthält den sichtbaren Chat-Inhalt.)

## Bauen

```bash
cd android && ./gradlew assembleDebug
```
Baut automatisch per GitHub Actions bei jeder Änderung unter `android/`.
