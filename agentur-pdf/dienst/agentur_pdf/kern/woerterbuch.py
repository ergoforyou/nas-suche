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
        self._vorschlag_cache: dict[str, list[str]] = {}
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

    def vorschlaege(self, wort: str, anzahl: int = 5, zeitlimit: float = 3.0) -> list[str]:
        """Korrekturvorschläge für einen Tippfehler.

        Hunspells eigene Vorschlagssuche braucht in der reinen Python-Fassung
        bis zu 40 s je Wort. Stattdessen werden die typischen Tippfehler
        (Umlaut umschrieben, vertauscht, Buchstabe zu viel/fehlt/falsch) in der
        Reihenfolge ihrer Häufigkeit durchprobiert und je mit dem Wörterbuch
        geprüft – mit Zeitlimit.
        """
        import time

        with self._lock:
            self._laden()
            if self._hunspell is None:
                return []
            if wort in self._vorschlag_cache:
                return self._vorschlag_cache[wort][:anzahl]
            ende = time.monotonic() + zeitlimit
            gefunden: list[str] = [b for b in sorted(self._eigene) if _aehnlich(wort, b)][:anzahl]
            geprueft: set[str] = {wort, *gefunden}
            letzte_stufe = 0
            for stufe, kandidat in _tippfehler_varianten(wort):
                if stufe != letzte_stufe and gefunden:
                    break  # wahrscheinlichere Fehlerart hat schon Treffer gebracht
                letzte_stufe = stufe
                if len(gefunden) >= anzahl or time.monotonic() > ende:
                    break
                if kandidat in geprueft:
                    continue
                geprueft.add(kandidat)
                try:
                    if self._hunspell.lookup(kandidat):
                        gefunden.append(kandidat)
                except Exception:  # noqa: BLE001
                    continue
            if time.monotonic() <= ende:
                self._vorschlag_cache[wort] = gefunden  # nur vollständige Ergebnisse merken
            return gefunden[:anzahl]

    def hinzufuegen(self, wort: str) -> None:
        wort = wort.strip()
        if not wort or wort in self._eigene:
            return
        self._eigene.add(wort)
        with open(self._benutzer_datei, "a", encoding="utf-8") as f:
            f.write(wort + "\n")


HAEUFIGE_BUCHSTABEN = "enirstadhulgcomwbfkzpvüäößjyxq"
_UMSCHREIBUNGEN = (("ae", "ä"), ("oe", "ö"), ("ue", "ü"), ("ss", "ß"), ("Ae", "Ä"), ("Oe", "Ö"), ("Ue", "Ü"))


def _tippfehler_varianten(wort: str):
    """Kandidaten in sinnvoller Reihenfolge: erst wahrscheinliche Fehler."""
    n = len(wort)
    for alt, neu in _UMSCHREIBUNGEN:  # „Beitragsrueckerstattung“
        if alt in wort:
            yield 1, wort.replace(alt, neu)
        if neu in wort:
            yield 1, wort.replace(neu, alt)
    for i in range(n - 1):  # vertauscht
        yield 1, wort[:i] + wort[i + 1] + wort[i] + wort[i + 2 :]
    for i in range(n):  # Buchstabe zu viel (doppelte zuerst)
        if i + 1 < n and wort[i] == wort[i + 1]:
            yield 1, wort[:i] + wort[i + 1 :]
    for i in range(n):
        yield 1, wort[:i] + wort[i + 1 :]
    for b in HAEUFIGE_BUCHSTABEN:  # Buchstabe fehlt
        for i in range(1, n + 1):
            yield 2, wort[:i] + b + wort[i:]
    for b in HAEUFIGE_BUCHSTABEN:  # Buchstabe falsch
        for i in range(n):
            if wort[i].lower() != b:
                ersatz = b.upper() if wort[i].isupper() else b
                yield 3, wort[:i] + ersatz + wort[i + 1 :]


def _aehnlich(a: str, b: str) -> bool:
    """Höchstens zwei Bearbeitungsschritte Abstand (für Fachbegriffe)."""
    a, b = a.lower(), b.lower()
    if abs(len(a) - len(b)) > 2 or a == b:
        return False
    vorher = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        aktuell = [i]
        for j, cb in enumerate(b, 1):
            aktuell.append(min(vorher[j] + 1, aktuell[j - 1] + 1, vorher[j - 1] + (ca != cb)))
        if min(aktuell) > 2:
            return False
        vorher = aktuell
    return vorher[-1] <= 2


_INSTANZ: Woerterbuch | None = None


def woerterbuch() -> Woerterbuch:
    global _INSTANZ
    if _INSTANZ is None:
        _INSTANZ = Woerterbuch()
    return _INSTANZ
