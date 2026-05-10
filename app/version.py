from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


def _extract_by_key(data: dict, key: str) -> Optional[str]:
    """Dot-notation traversal. 'server.version' → data['server']['version']."""
    current: object = data
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return str(current) if current is not None else None


def _extract_by_template(data: dict, template: str) -> Optional[str]:
    """{major}.{minor}.{patch} filled from flat JSON dict."""
    try:
        return template.format(**{k: str(v) for k, v in data.items()})
    except (KeyError, ValueError):
        return None


async def fetch_installed_version(
    version_url: str,
    version_key: Optional[str],
    version_template: Optional[str],
    client: httpx.AsyncClient,
) -> tuple[Optional[str], Optional[str]]:
    """Return (version, error)."""
    try:
        resp = await client.get(version_url)
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        return None, f"unreachable ({type(e).__name__})"
    except Exception as e:
        return None, f"request error: {e}"

    if resp.status_code != 200:
        return None, f"HTTP {resp.status_code}"

    try:
        data = resp.json()
    except Exception:
        return None, "invalid JSON response"

    if not isinstance(data, dict):
        return None, "unexpected response format (not a JSON object)"

    if version_key:
        version = _extract_by_key(data, version_key)
        if version is None:
            return None, f"version_key '{version_key}' not found in response"
        return version, None

    if version_template:
        version = _extract_by_template(data, version_template)
        if version is None:
            return None, f"version_template fields missing from response"
        return version, None

    return None, "no version_key or version_template configured"
