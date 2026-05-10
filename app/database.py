from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiosqlite

_conn: Optional[aiosqlite.Connection] = None
DB_PATH = Path(__file__).parent.parent / "data" / "versions.db"


async def init_db(path: Path = DB_PATH) -> None:
    global _conn
    path.parent.mkdir(parents=True, exist_ok=True)
    _conn = await aiosqlite.connect(path)
    _conn.row_factory = aiosqlite.Row
    await _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS manual_versions (
            service_name TEXT PRIMARY KEY,
            version      TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        )
        """
    )
    await _conn.commit()


async def close_db() -> None:
    global _conn
    if _conn:
        await _conn.close()
        _conn = None


async def get_version(service_name: str) -> Optional[str]:
    assert _conn is not None
    async with _conn.execute(
        "SELECT version FROM manual_versions WHERE service_name = ?", (service_name,)
    ) as cur:
        row = await cur.fetchone()
    return row["version"] if row else None


async def set_version(service_name: str, version: str) -> None:
    assert _conn is not None
    now = datetime.now(timezone.utc).isoformat()
    await _conn.execute(
        """
        INSERT INTO manual_versions (service_name, version, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(service_name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
        """,
        (service_name, version, now),
    )
    await _conn.commit()


async def get_all_versions() -> dict[str, str]:
    assert _conn is not None
    async with _conn.execute("SELECT service_name, version FROM manual_versions") as cur:
        rows = await cur.fetchall()
    return {row["service_name"]: row["version"] for row in rows}
