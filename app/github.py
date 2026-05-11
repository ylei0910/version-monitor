from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_cache: dict[str, "_CacheEntry"] = {}
_lock = asyncio.Lock()


def clear_cache() -> None:
    _cache.clear()


@dataclass
class _CacheEntry:
    version: Optional[str]
    fetched_at: float          # monotonic, for TTL math
    fetched_at_wall: datetime  # wall-clock, for display
    error: Optional[str]


async def get_latest_version(
    repo: str,
    client: httpx.AsyncClient,
    token: Optional[str],
    ttl_seconds: int,
) -> tuple[Optional[str], Optional[str]]:
    """Return (version, error)."""
    now = time.monotonic()

    async with _lock:
        entry = _cache.get(repo)
        if entry and (now - entry.fetched_at) < ttl_seconds:
            return entry.version, entry.error

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = f"https://api.github.com/repos/{repo}/releases/latest"
    try:
        resp = await client.get(url, headers=headers)
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        error = f"network error: {type(e).__name__}"
        logger.warning("GitHub fetch failed for %s: %s", repo, error)
        async with _lock:
            stale = _cache.get(repo)
            if stale and stale.version:
                return stale.version, error
        return None, error

    if resp.status_code == 404:
        version, error = None, "no releases found"
    elif resp.status_code in (403, 429):
        error = f"rate limited (HTTP {resp.status_code})"
        logger.warning("GitHub rate limited for %s", repo)
        async with _lock:
            stale = _cache.get(repo)
            if stale and stale.version:
                return stale.version, error
        return None, error
    elif resp.status_code != 200:
        version, error = None, f"HTTP {resp.status_code}"
    else:
        try:
            data = resp.json()
            tag = data.get("tag_name", "")
            version = tag if tag else None
            error = None if version else "missing tag_name in response"
        except Exception as e:
            version, error = None, f"parse error: {e}"

    async with _lock:
        _cache[repo] = _CacheEntry(
            version=version,
            fetched_at=time.monotonic(),
            fetched_at_wall=datetime.now(timezone.utc),
            error=error,
        )

    return version, error


def get_last_fetch_time() -> Optional[datetime]:
    """Return the most recent wall-clock time any GitHub release was fetched."""
    if not _cache:
        return None
    return max(entry.fetched_at_wall for entry in _cache.values())


def clear_cache(repo: Optional[str] = None) -> None:
    """Evict one repo or the entire cache (for testing / manual refresh)."""
    if repo:
        _cache.pop(repo, None)
    else:
        _cache.clear()
