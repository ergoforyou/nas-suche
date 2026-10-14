"""Deutsches Wörterbuch (Hunspell de_DE) + Fachbegriffe + Benutzerwörterbuch.

Wird von der Texterkennung (Umlaut-Rettung) und später von der
Rechtschreibprüfung genutzt. Fehlt das Wörterbuch, arbeiten beide einfach
ohne – nie mit Fehlermeldung.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

from ..benutzer.speicher import datenordner

# Häufige Fachbegriffe der Agentur, die in allgemeinen Wörterbüchern fehlen
FACHBEGRIFFE = """
Versicherungsschein Versicherungsnehmer Versicherungsvorschlag Versicherungssumme Versicherungsort
Beitragsrückerstattung Selbstbeteiligung Selbstbehalt Elementarschaden Elementarschäden Elementarversicherung
Unterversicherungsverzicht Wohngebäudeversicherung Hausratversicherung Glasversicherung Ökoschutzversicherung
Umwelthaftpflichtversicherung Betriebshaftpflichtversicherung Privathaftpflichtversicherung Tierhalterhaftpflicht
Kfz-Haftpflicht Teilkasko Vollkasko Schadenfreiheitsklasse SF-Klasse Rabattschutz Fahrerschutz Schutzbrief
Berufsunfähigkeitsversicherung Risikolebensversicherung Rentenversicherung Unfallversicherung Rechtsschutzversicherung
Zahnzusatzversicherung Krankenzusatzversicherung Pflegezusatzversicherung Beitragsanpassung Tarifwechsel
Hauptfälligkeit Zahlweise Lastschriftmandat SEPA-Lastschriftmandat Agenturnummer Vermittlernummer Vertragsnummer
Schadennummer Schadenmeldung Schadenanzeige Gutachten Sachverständiger Regulierung Neuwert Zeitwert Wiederbeschaffungswert
Gleitender Neuwertfaktor Wertermittlungsbogen Wohnfläche Nutzfläche Überspannungsschäden Ableitungsrohre
ERGO DEKRA Allianz Gothaer HUK-COBURG
""".split()


def _hunspell_pfad() -> Path | None:
    kandidaten = [os.environ.get("AGENTUR_PDF_HUNSPELL", "")]
    basis = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    kandidaten += [str(basis / "hunspell" / "de_DE"), str(Path(sys.executable).parent / "hunspell" / "de_DE")]
    # Wörterbuch aus dem mitgelieferten oder installierten LibreOffice
    for lo in (basis / "libreoffice", Path(sys.executable).parent / "libreoffice", *(
        Path(os.environ[v]) / "LibreOffice" for v in ("PROGRAMFILES", "PROGRAMFILES(X86)") if os.environ.get(v)
    )):
        kandidaten.append(str(lo / "share" / "extensions" / "dict-de" / "de_DE_frami"))
    kandidaten += ["/usr/share/hunspell/de_DE", "/usr/share/myspell/de_DE"]
    for k in kandidaten:
        if k and Path(k + ".dic").is_file() and Path(k + ".aff").is_file():
            return Path(k)
    return None


class Woerterbuch:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hunspell = None
        self._geladen = False
        self._eigene: set[str] = set(FACHBEGRIFFE)
        self._benutzer_datei = datenordner() / "woerterbuch.txt"
        self._benutzer_laden()

    def _benutzer_laden(self) -> None:
        try:
            self._eigene |= {z.strip() for z in self._benutzer_datei.read_text(encoding="utf-8").splitlines() if z.strip()}
        except OSError:
            pass

    def _laden(self) -> None:
        if self._geladen:
            return
        self._geladen = True
        pfad = _hunspell_pfad()
        if pfad is None:
            return
        try:
            from spylls.hunspell import Dictionary

            self._hunspell = Dictionary.from_files(str(pfad))
        except Exception:  # noqa: BLE001 – Wörterbuch ist optional
            self._hunspell = None

    @property
    def verfuegbar(self) -> bool:
        with self._lock:
            self._laden()
            return self._hunspell is not None

    def bekannt(self, wort: str) -> bool:
        if wort in self._eigene or wort.lower() in self._eigene:
            return True
        with self._lock:
            self._laden()
            if self._hunspell is None:
                return True  # ohne Wörterbuch nichts als falsch werten
            return bool(self._hunspell.lookup(wort))

    def vorschlaege(self, wort: str, anzahl: int = 5) -> list[str]:
        with self._lock:
            self._laden()
            if self._hunspell is None:
                return []
            ergebnis = []
            for v in self._hunspell.suggest(wort):
                ergebnis.append(v)
                if len(ergebnis) >= anzahl:
                    break
            return ergebnis

    def hinzufuegen(self, wort: str) -> None:
        wort = wort.strip()
        if not wort or wort in self._eigene:
            return
        self._eigene.add(wort)
        with open(self._benutzer_datei, "a", encoding="utf-8") as f:
            f.write(wort + "\n")


_INSTANZ: Woerterbuch | None = None


def woerterbuch() -> Woerterbuch:
    global _INSTANZ
    if _INSTANZ is None:
        _INSTANZ = Woerterbuch()
    return _INSTANZ
