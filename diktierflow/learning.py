"""Selbstlernen: erkennt Korrekturen am eingefügten Text und wendet sie künftig an.

Ablauf:
1. Nach dem Einfügen wird das Textfeld später erneut gelesen (siehe textio.py).
2. `locate_inserted` sucht den eingefügten Abschnitt im aktuellen Feldinhalt.
3. `extract_corrections` vergleicht Wort für Wort und liefert kurze Ersetzungen
   ("Ergo vor ju" -> "ErgoForYou"). Inhaltliche Umformulierungen (anderes Wort,
   anderer Sinn) werden über eine Klang-/Schreibähnlichkeitsprüfung aussortiert,
   damit das Programm nicht "Montag -> Dienstag" lernt.
4. `apply_corrections` ersetzt gelernte Fehler im nächsten Rohtext, bevor der
   Text an Claude geht. Zusätzlich landen die Begriffe als Hinweis bei Whisper.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Iterable, Sequence

WORD_RE = re.compile(r"[\w][\w\-'’.@&+]*[\w]|[\w]", re.UNICODE)

# Funktionswörter: Änderungen nur zwischen diesen sind Grammatik, kein Hörfehler
STOPWORDS = {
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
    "eines", "und", "oder", "aber", "dass", "das", "ist", "sind", "war", "hat", "haben",
    "wird", "werden", "in", "im", "an", "am", "auf", "zu", "zum", "zur", "mit", "von",
    "vom", "für", "bei", "nach", "aus", "es", "er", "sie", "wir", "ihr", "ich", "du",
    "man", "nicht", "auch", "so", "wie", "als", "noch", "schon", "nur", "sich", "mir",
    "mich", "dir", "dich", "uns", "euch", "ihm", "ihn", "ihnen", "the", "a", "an", "of",
    "to", "and", "is", "be", "this", "that", "it",
}

MAX_SPAN_WORDS = 4


def tokenize(text: str) -> list[str]:
    return WORD_RE.findall(text)


# ------------------------------------------------------------------ Kölner Phonetik
_COLOGNE_GROUPS = [
    ("aeijouyäöü", "0"), ("h", ""), ("b", "1"), ("fvw", "3"), ("gkq", "4"),
    ("l", "5"), ("mn", "6"), ("r", "7"), ("szß", "8"),
]


def cologne_phonetic(word: str) -> str:
    """Kölner Phonetik – deutsches Gegenstück zu Soundex."""
    w = re.sub(r"[^a-zäöüß]", "", word.lower())
    if not w:
        return ""
    codes: list[str] = []
    for i, ch in enumerate(w):
        prev = w[i - 1] if i > 0 else "#"   # "#" statt "", da "" in "abc" wahr ist
        nxt = w[i + 1] if i + 1 < len(w) else "#"
        code = None
        if ch == "p":
            code = "3" if nxt == "h" else "1"
        elif ch in "dt":
            code = "8" if nxt in "csz" else "2"
        elif ch == "c":
            if i == 0:
                code = "4" if nxt in "ahkloqrux" else "8"
            else:
                code = "8" if (prev in "sz" or nxt not in "ahkoqux") else "4"
        elif ch == "x":
            code = "8" if prev in "ckq" else "48"
        else:
            for letters, c in _COLOGNE_GROUPS:
                if ch in letters:
                    code = c
                    break
        if code is None:
            code = ""
        codes.append(code)
    out = []
    for c in "".join(codes):
        if not out or out[-1] != c:
            out.append(c)
    s = "".join(out)
    return s[0] + s[1:].replace("0", "") if s else ""


def _norm(s: str) -> str:
    return re.sub(r"[\s\-'’.]", "", s.lower())


def sounds_similar(a: str, b: str) -> bool:
    """Ist b plausibel ein Hörfehler-Ersatz für a (oder umgekehrt)?"""
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    if na == nb:  # nur Schreibweise/Groß-Klein/Zusammenschreibung
        return True
    if SequenceMatcher(None, na, nb).ratio() >= 0.6:
        return True
    pa, pb = cologne_phonetic(na), cologne_phonetic(nb)
    return bool(pa and pb) and SequenceMatcher(None, pa, pb).ratio() >= 0.75


# ------------------------------------------------------------------- Diff-Logik
def locate_inserted(field_text: str, inserted: str) -> str | None:
    """Findet den (evtl. bearbeiteten) eingefügten Abschnitt im Feldinhalt."""
    inserted = inserted.strip()
    if not inserted or not field_text:
        return None
    if inserted in field_text:
        return inserted
    sm = SequenceMatcher(None, inserted, field_text, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size >= 3]
    if not blocks:
        return None
    matched = sum(b.size for b in blocks)
    if matched < 0.4 * len(inserted):
        return None  # Feld enthält etwas ganz anderes (Fokus gewechselt o. ä.)
    first, last = blocks[0], blocks[-1]
    start = max(0, first.b - first.a)
    end = min(len(field_text), last.b + last.size + (len(inserted) - (last.a + last.size)))
    # auf Wortgrenzen erweitern
    while start > 0 and not field_text[start - 1].isspace():
        start -= 1
    while end < len(field_text) and not field_text[end].isspace():
        end += 1
    return field_text[start:end].strip()


def extract_corrections(inserted: str, edited: str) -> list[tuple[str, str]]:
    """Liefert kurze Wort-Ersetzungen (falsch, richtig) zwischen zwei Fassungen."""
    a, b = tokenize(inserted), tokenize(edited)
    if not a or not b or a == b:
        return []
    sm = SequenceMatcher(None, [t.lower() for t in a], [t.lower() for t in b],
                         autojunk=False)
    # Komplett umgeschrieben -> nichts lernen
    if sm.ratio() < 0.5:
        return []
    starts = sentence_starts(edited)
    result: list[tuple[str, str]] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            # reine Groß-/Kleinschreibungs-Korrekturen (z. B. Eigennamen)
            for k, (x, y) in enumerate(zip(a[i1:i2], b[j1:j2])):
                if x != y and _is_name_fix(x, y, (j1 + k) in starts):
                    result.append((x, y))
            continue
        if op != "replace":
            continue
        if (i2 - i1) > MAX_SPAN_WORDS or (j2 - j1) > MAX_SPAN_WORDS:
            continue
        wrong = " ".join(a[i1:i2])
        right = " ".join(b[j1:j2])
        if _is_grammar_only(a[i1:i2], b[j1:j2]):
            continue
        if not sounds_similar(wrong, right):
            continue
        result.append((wrong, right))
    return result


def _is_name_fix(x: str, y: str, at_sentence_start: bool) -> bool:
    """Reine Groß-/Kleinschreibungs-Korrektur eines Namens, z. B. müller -> Müller."""
    if x.lower() != y.lower() or y.lower() in STOPWORDS:
        return False
    if any(c.isupper() for c in y[1:]):  # ergoforyou -> ErgoForYou
        return True
    return not at_sentence_start and x.islower() and y[:1].isupper() and len(y) > 3


def sentence_starts(text: str) -> set[int]:
    """Indizes der Tokens, die am Satzanfang stehen."""
    starts, prev_end = set(), None
    for i, m in enumerate(WORD_RE.finditer(text)):
        gap = text[prev_end:m.start()] if prev_end is not None else ""
        if prev_end is None or re.search(r"[.!?:\n]", gap):
            starts.add(i)
        prev_end = m.end()
    return starts


_ENDINGS = {"", "e", "n", "en", "er", "es", "s", "em", "r", "m", "ern", "ere"}


def _is_inflection(w: str, r: str) -> bool:
    """schöne -> schöner, Haus -> Hauses: nur die Endung unterscheidet sich."""
    w, r = w.lower(), r.lower()
    if w == r:
        return True
    p = 0
    while p < min(len(w), len(r)) and w[p] == r[p]:
        p += 1
    return p >= 3 and w[p:] in _ENDINGS and r[p:] in _ENDINGS


def _is_grammar_only(wrong: Sequence[str], right: Sequence[str]) -> bool:
    """Nur Artikel/Präpositionen/Endungen geändert -> Grammatik, kein Hörfehler."""
    content_w = [x for x in wrong if x.lower() not in STOPWORDS]
    content_r = [x for x in right if x.lower() not in STOPWORDS]
    if not content_w and not content_r:
        return True
    if len(content_w) != len(content_r):
        return False
    return all(_is_inflection(x, y) and x[:1].isupper() == y[:1].isupper()
               for x, y in zip(content_w, content_r))


def vocabulary_candidates(right: str) -> list[str]:
    """Begriffe aus einer Korrektur, die ins Wörterbuch gehören (Namen, Fachwörter)."""
    out = []
    for tok in tokenize(right):
        if tok.lower() in STOPWORDS or len(tok) < 3:
            continue
        inner_upper = any(c.isupper() for c in tok[1:])
        has_digit = any(c.isdigit() for c in tok)
        if inner_upper or has_digit or tok.isupper():
            out.append(tok)
    if len(tokenize(right)) > 1 and right[:1].isupper():
        out.append(right)  # mehrteiliger Eigenname
    return list(dict.fromkeys(out))


# ------------------------------------------------------------------ Anwenden
def apply_corrections(text: str, corrections: Iterable[tuple[str, str]]) -> str:
    """Ersetzt gelernte Fehler (ganze Wörter, Groß-/Kleinschreibung tolerant)."""
    pairs = sorted(corrections, key=lambda p: len(p[0]), reverse=True)
    for wrong, right in pairs:
        if not wrong or wrong == right:
            continue
        pattern = r"(?<![\w])" + r"\s+".join(re.escape(p) for p in wrong.split()) + r"(?![\w])"

        def repl(m: re.Match, right=right) -> str:
            found = m.group(0)
            # Satzanfang groß beibehalten
            if found[:1].isupper() and right[:1].islower():
                return right[:1].upper() + right[1:]
            return right

        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def build_stt_prompt(terms: Sequence[str], corrections: Sequence[tuple[str, str]],
                     max_chars: int = 600) -> str:
    """Kontext-Prompt für Whisper: bekannte Schreibweisen von Namen/Fachwörtern."""
    words = list(dict.fromkeys([*terms, *(r for _, r in corrections)]))
    out, size = [], 0
    for w in words:
        if size + len(w) + 2 > max_chars:
            break
        out.append(w)
        size += len(w) + 2
    return ", ".join(out)
