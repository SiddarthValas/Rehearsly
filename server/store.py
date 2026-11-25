"""SQLite persistence: interviews survive restarts and feed the progress dashboard."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(os.getenv("REHEARSLY_DB", Path(__file__).resolve().parents[1] / "data" / "rehearsly.db"))
_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def init() -> None:
    with _lock, _connect() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                data TEXT NOT NULL
            )"""
        )


def save(session: dict) -> None:
    session["updatedAt"] = time.time()
    payload = json.dumps(session, ensure_ascii=False)
    with _lock, _connect() as db:
        db.execute(
            "INSERT INTO sessions (id, created_at, updated_at, data) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data",
            (session["id"], session["createdAt"], session["updatedAt"], payload),
        )


def load(session_id: str) -> dict | None:
    with _lock, _connect() as db:
        row = db.execute("SELECT data FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return json.loads(row[0]) if row else None


def all_sessions() -> list[dict]:
    with _lock, _connect() as db:
        rows = db.execute("SELECT data FROM sessions ORDER BY created_at DESC").fetchall()
    return [json.loads(row[0]) for row in rows]


def delete(session_id: str) -> bool:
    with _lock, _connect() as db:
        cursor = db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return cursor.rowcount > 0


class SQLiteRepo:
    """Server-side persistence (local installs)."""

    def load(self, session_id: str) -> dict | None:
        return load(session_id)

    def save(self, session: dict) -> None:
        save(session)

    def all_sessions(self) -> list[dict]:
        return all_sessions()

    def delete(self, session_id: str) -> bool:
        return delete(session_id)


class MemoryRepo:
    """Request-scoped storage for the hosted (Vercel) mode: the browser keeps each
    person's sessions and sends what a request needs; the server stays stateless."""

    def __init__(self, sessions: list | None = None):
        self.items: dict[str, dict] = {}
        for item in sessions or []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                item.setdefault("createdAt", 0)
                item.setdefault("messages", [])
                item.setdefault("topics", [])
                self.items[item["id"]] = item

    def load(self, session_id: str) -> dict | None:
        return self.items.get(session_id)

    def save(self, session: dict) -> None:
        session["updatedAt"] = time.time()
        self.items[session["id"]] = session

    def all_sessions(self) -> list[dict]:
        return sorted(self.items.values(), key=lambda s: s.get("createdAt", 0), reverse=True)

    def delete(self, session_id: str) -> bool:
        return self.items.pop(session_id, None) is not None


DEFAULT = SQLiteRepo()
