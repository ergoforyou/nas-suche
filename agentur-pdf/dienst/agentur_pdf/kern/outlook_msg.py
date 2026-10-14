"""Minimaler Leser für Outlook-.msg-Dateien (OLE-Verbunddatei, MS-OXMSG).

Liest Betreff, Absender, Empfänger, Datum, Text-/HTML-Text und Anhänge –
genug, um eine Mail als PDF darzustellen. Bewusst ohne große Fremdbibliothek,
damit die Windows-Installation schlank und robust bleibt.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import BinaryIO

import olefile

# Eigenschaften (Property-IDs) aus MS-OXPROPS
BETREFF = 0x0037
ABSENDER_NAME = 0x0C1A
ABSENDER_ADRESSE = 0x0C1F
AN = 0x0E04
CC = 0x0E03
TEXT = 0x1000
HTML = 0x1013
SENDEZEIT = 0x0039  # PR_CLIENT_SUBMIT_TIME
EMPFANGSZEIT = 0x0E06  # PR_MESSAGE_DELIVERY_TIME
ANHANG_NAME_LANG = 0x3707
ANHANG_NAME = 0x3704
ANHANG_DATEN = 0x3701
ANHANG_MIME = 0x370E

TYP_UNICODE = 0x001F
TYP_ANSI = 0x001E
TYP_BINAER = 0x0102
TYP_ZEIT = 0x0040


@dataclass
class MsgAnhang:
    name: str
    daten: bytes
    mime: str = ""


@dataclass
class MsgNachricht:
    betreff: str = ""
    absender: str = ""
    an: str = ""
    cc: str = ""
    datum: datetime | None = None
    text: str = ""
    html: str = ""
    anhaenge: list[MsgAnhang] = field(default_factory=list)


def _stream_name(prop_id: int, typ: int) -> str:
    return f"__substg1.0_{prop_id:04X}{typ:04X}"


def filetime_zu_datum(wert: int) -> datetime | None:
    """Windows-FILETIME (100-ns-Schritte seit 1601) → datetime (UTC)."""
    if wert <= 0:
        return None
    try:
        return datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=wert // 10)
    except OverflowError:
        return None


def zeit_aus_eigenschaften(daten: bytes, prop_id: int, kopf: int) -> datetime | None:
    """Sucht in einem ``__properties_version1.0``-Stream eine Zeit-Eigenschaft.

    Aufbau: ``kopf`` Bytes Header, dann Einträge à 16 Bytes:
    Typ (2), ID (2), Flags (4), Wert (8).
    """
    for pos in range(kopf, len(daten) - 15, 16):
        typ, pid = struct.unpack_from("<HH", daten, pos)
        if pid == prop_id and typ == TYP_ZEIT:
            (wert,) = struct.unpack_from("<q", daten, pos + 8)
            return filetime_zu_datum(wert)
    return None


def _text_lesen(ole: olefile.OleFileIO, pfad: str, prop_id: int, codepage: str = "cp1252") -> str:
    for typ, kodierung in ((TYP_UNICODE, "utf-16-le"), (TYP_ANSI, codepage)):
        name = f"{pfad}{_stream_name(prop_id, typ)}"
        if ole.exists(name):
            return ole.openstream(name).read().decode(kodierung, errors="replace").rstrip("\x00")
    return ""


def _binaer_lesen(ole: olefile.OleFileIO, pfad: str, prop_id: int) -> bytes:
    name = f"{pfad}{_stream_name(prop_id, TYP_BINAER)}"
    return ole.openstream(name).read() if ole.exists(name) else b""


def msg_lesen(quelle: str | bytes | BinaryIO) -> MsgNachricht:
    if isinstance(quelle, bytes):
        import io

        quelle = io.BytesIO(quelle)
    if not olefile.isOleFile(quelle):
        raise ValueError("Keine gültige Outlook-Nachricht (.msg).")
    if hasattr(quelle, "seek"):
        quelle.seek(0)
    with olefile.OleFileIO(quelle) as ole:
        n = MsgNachricht()
        n.betreff = _text_lesen(ole, "", BETREFF)
        name = _text_lesen(ole, "", ABSENDER_NAME)
        adresse = _text_lesen(ole, "", ABSENDER_ADRESSE)
        n.absender = f"{name} <{adresse}>" if name and adresse and "@" in adresse else (name or adresse)
        n.an = _text_lesen(ole, "", AN)
        n.cc = _text_lesen(ole, "", CC)
        n.text = _text_lesen(ole, "", TEXT)
        html = _binaer_lesen(ole, "", HTML) or _text_lesen(ole, "", HTML).encode("utf-8")
        if html:
            n.html = _html_dekodieren(html)
        if ole.exists("__properties_version1.0"):
            props = ole.openstream("__properties_version1.0").read()
            n.datum = zeit_aus_eigenschaften(props, SENDEZEIT, 32) or zeit_aus_eigenschaften(props, EMPFANGSZEIT, 32)
        for eintrag in ole.listdir(streams=False, storages=True):
            if len(eintrag) != 1 or not eintrag[0].startswith("__attach_version1.0_"):
                continue
            pfad = eintrag[0] + "/"
            daten = _binaer_lesen(ole, pfad, ANHANG_DATEN)
            if not daten:
                continue  # eingebettete Nachricht/OLE-Objekt – nicht unterstützt
            anhang_name = _text_lesen(ole, pfad, ANHANG_NAME_LANG) or _text_lesen(ole, pfad, ANHANG_NAME) or "Anhang"
            n.anhaenge.append(MsgAnhang(anhang_name, daten, _text_lesen(ole, pfad, ANHANG_MIME)))
        return n


def _html_dekodieren(daten: bytes) -> str:
    import re

    kopf = daten[:2048].decode("ascii", errors="ignore")
    treffer = re.search(r"charset=[\"']?([\w-]+)", kopf, re.I)
    for kodierung in ([treffer.group(1)] if treffer else []) + ["utf-8", "cp1252"]:
        try:
            return daten.decode(kodierung)
        except (LookupError, UnicodeDecodeError):
            continue
    return daten.decode("utf-8", errors="replace")
