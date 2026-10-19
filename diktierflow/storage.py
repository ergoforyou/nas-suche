"""Lokale SQLite-Datenbank: Verlauf, gelernte Korrekturen, Wörterbuch, Textbausteine."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS dictations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    REAL NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'dictate',
    app           TEXT,
    window_title  TEXT,
    style         TEXT,
    stt_engine    TEXT,
    duration_s    REAL,
    raw_text      TEXT NOT NULL DEFAULT '',
    final_text    TEXT NOT NULL DEFAULT '',
    edited_text   TEXT,
    variants_json TEXT,
    audio_path    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dictations_created ON dictations(created_at DESC);

CREATE TABLE IF NOT EXISTS corrections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    wrong      TEXT NOT NULL,
    right      TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    confirmed  INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT 'auto',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE(wrong, right)
);

CREATE TABLE IF NOT EXISTS vocabulary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    term       TEXT NOT NULL UNIQUE,
    source     TEXT NOT NULL DEFAULT 'manual',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS snippets (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    text  TEXT NOT NULL
);
"""


@dataclass
class Dictation:
    id: int
    created_at: float
    mode: str
    app: str | None
    window_title: str | None
    style: str | None
    stt_engine: str | None
    duration_s: float | None
    raw_text: str
    final_text: str
    edited_text: str | None
    variants: list[dict] | None
    audio_path: str | None

    @property
    def best_text(self) -> str:
        return self.edited_text or self.final_text


@dataclass
class Correction:
    id: int
    wrong: str
    right: str
    count: int
    confirmed: bool
    source: str


class Storage:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ Verlauf
    def add_dictation(self, *, raw_text: str, final_text: str, mode: str = "dictate",
                      app: str | None = None, window_title: str | None = None,
                      style: str | None = None, stt_engine: str | None = None,
                      duration_s: float | None = None, variants: list[dict] | None = None,
                      audio_path: str | None = None) -> int:
        with self._lock:
            cur = self._db.execute(
                """INSERT INTO dictations (created_at, mode, app, window_title, style,
                   stt_engine, duration_s, raw_text, final_text, variants_json, audio_path)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (time.time(), mode, app, window_title, style, stt_engine, duration_s,
                 raw_text, final_text,
                 json.dumps(variants, ensure_ascii=False) if variants else None,
                 audio_path),
            )
            self._db.commit()
            return int(cur.lastrowid)

    def update_dictation(self, dictation_id: int, **values) -> None:
        allowed = {"final_text", "edited_text", "raw_text", "audio_path", "stt_engine"}
        cols = [k for k in values if k in allowed]
        if not cols:
            return
        with self._lock:
            self._db.execute(
                f"UPDATE dictations SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                [values[c] for c in cols] + [dictation_id],
            )
            self._db.commit()

    def get_dictation(self, dictation_id: int) -> Dictation | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM dictations WHERE id=?",
                                   (dictation_id,)).fetchone()
        return self._row_to_dictation(row) if row else None

    def list_dictations(self, search: str = "", limit: int = 200) -> list[Dictation]:
        with self._lock:
            if search:
                like = f"%{search}%"
                rows = self._db.execute(
                    """SELECT * FROM dictations
                       WHERE final_text LIKE ? OR raw_text LIKE ? OR edited_text LIKE ?
                             OR app LIKE ?
                       ORDER BY created_at DESC LIMIT ?""",
                    (like, like, like, like, limit),
                ).fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM dictations ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._row_to_dictation(r) for r in rows]

    def last_dictation(self) -> Dictation | None:
        items = self.list_dictations(limit=1)
        return items[0] if items else None

    def delete_dictation(self, dictation_id: int) -> str | None:
        d = self.get_dictation(dictation_id)
        with self._lock:
            self._db.execute("DELETE FROM dictations WHERE id=?", (dictation_id,))
            self._db.commit()
        return d.audio_path if d else None

    def stats(self) -> dict:
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) AS n, COALESCE(SUM(duration_s),0) AS secs FROM dictations"
            ).fetchone()
            texts = self._db.execute("SELECT final_text FROM dictations").fetchall()
        words = sum(len((r["final_text"] or "").split()) for r in texts)
        return {"dictations": row["n"], "seconds": row["secs"], "words": words,
                # ~40 Wörter/Minute Tippen vs. gesprochen
                "saved_minutes": max(0.0, words / 40 - row["secs"] / 60)}

    @staticmethod
    def _row_to_dictation(row: sqlite3.Row) -> Dictation:
        return Dictation(
            id=row["id"], created_at=row["created_at"], mode=row["mode"], app=row["app"],
            window_title=row["window_title"], style=row["style"],
            stt_engine=row["stt_engine"], duration_s=row["duration_s"],
            raw_text=row["raw_text"], final_text=row["final_text"],
            edited_text=row["edited_text"],
            variants=json.loads(row["variants_json"]) if row["variants_json"] else None,
            audio_path=row["audio_path"],
        )

    # -------------------------------------------------------------- Korrekturen
    def record_correction(self, wrong: str, right: str, *, source: str = "auto",
                          confirm: bool = False) -> Correction:
        now = time.time()
        with self._lock:
            self._db.execute(
                """INSERT INTO corrections (wrong, right, count, confirmed, source,
                                            created_at, updated_at)
                   VALUES (?,?,1,?,?,?,?)
                   ON CONFLICT(wrong, right) DO UPDATE SET
                     count = count + 1,
                     confirmed = MAX(confirmed, excluded.confirmed),
                     updated_at = excluded.updated_at""",
                (wrong, right, int(confirm), source, now, now),
            )
            self._db.commit()
            row = self._db.execute("SELECT * FROM corrections WHERE wrong=? AND right=?",
                                   (wrong, right)).fetchone()
        return self._row_to_correction(row)

    def set_correction_confirmed(self, correction_id: int, confirmed: bool) -> None:
        with self._lock:
            self._db.execute("UPDATE corrections SET confirmed=? WHERE id=?",
                             (int(confirmed), correction_id))
            self._db.commit()

    def delete_correction(self, correction_id: int) -> None:
        with self._lock:
            self._db.execute("DELETE FROM corrections WHERE id=?", (correction_id,))
            self._db.commit()

    def list_corrections(self) -> list[Correction]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM corrections ORDER BY confirmed DESC, count DESC, updated_at DESC"
            ).fetchall()
        return [self._row_to_correction(r) for r in rows]

    def active_corrections(self, threshold: int) -> list[Correction]:
        """Korrekturen, die automatisch angewendet werden."""
        return [c for c in self.list_corrections() if c.confirmed or c.count >= threshold]

    @staticmethod
    def _row_to_correction(row: sqlite3.Row) -> Correction:
        return Correction(id=row["id"], wrong=row["wrong"], right=row["right"],
                          count=row["count"], confirmed=bool(row["confirmed"]),
                          source=row["source"])

    # --------------------------------------------------------------- Wörterbuch
    def add_term(self, term: str, source: str = "manual") -> None:
        term = term.strip()
        if not term:
            return
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO vocabulary (term, source, created_at) VALUES (?,?,?)",
                (term, source, time.time()),
            )
            self._db.commit()

    def remove_term(self, term: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM vocabulary WHERE term=?", (term,))
            self._db.commit()

    def list_terms(self) -> list[str]:
        with self._lock:
            rows = self._db.execute("SELECT term FROM vocabulary ORDER BY term COLLATE NOCASE"
                                    ).fetchall()
        return [r["term"] for r in rows]

    # ----------------------------------------------------------- Textbausteine
    def set_snippet(self, name: str, text: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO snippets (name, text) VALUES (?,?) "
                "ON CONFLICT(name) DO UPDATE SET text=excluded.text",
                (name.strip(), text),
            )
            self._db.commit()

    def delete_snippet(self, name: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM snippets WHERE name=?", (name,))
            self._db.commit()

    def snippets(self) -> dict[str, str]:
        with self._lock:
            rows = self._db.execute("SELECT name, text FROM snippets ORDER BY name").fetchall()
        return {r["name"]: r["text"] for r in rows}
