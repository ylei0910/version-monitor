from __future__ import annotations

import logging
import re
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


def _post_process(version: str, regex: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    if not regex:
        return version, None
    result = _apply_regex(version, regex)
    if result is None:
        return None, f"version_regex '{regex}' did not match '{version}'"
    return result, None


def _apply_regex(value: str, pattern: str) -> Optional[str]:
    """Apply a regex with one capture group; return the first match or None."""
    m = re.search(pattern, value)
    if not m:
        return None
    return m.group(1) if m.lastindex else m.group(0)


def _extract_from_metrics(text: str, metric_name: str, label: str = "version") -> Optional[str]:
    """Extract a label value from a Prometheus text-format metrics response."""
    pattern = re.compile(
        rf'^{re.escape(metric_name)}\{{[^}}]*{re.escape(label)}="([^"]+)"'
    )
    for line in text.splitlines():
        m = pattern.match(line)
        if m:
            return m.group(1)
    return None


def _extract_by_template(data: dict, template: str) -> Optional[str]:
    """{major}.{minor}.{patch} filled from flat JSON dict."""
    try:
        return template.format(**{k: str(v) for k, v in data.items()})
    except (KeyError, ValueError):
        return None


async def fetch_latest_from_url(
    latest_url: str,
    latest_key: Optional[str],
    client: httpx.AsyncClient,
    basic_auth: Optional[str] = None,
    auth_header: Optional[str] = None,
    latest_regex: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Return (version, error) by fetching the latest version from a REST API."""
    auth = None
    headers: dict[str, str] = {}
    if auth_header:
        headers["Authorization"] = auth_header
    elif basic_auth and ":" in basic_auth:
        username, _, password = basic_auth.partition(":")
        auth = (username, password)

    try:
        resp = await client.get(latest_url, auth=auth, headers=headers)
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

    if not latest_key:
        return None, "latest_key is required when using latest_url"

    version = _extract_by_key(data, latest_key)
    if version is None:
        return None, f"latest_key '{latest_key}' not found in response"
    return _post_process(version, latest_regex)


async def fetch_installed_version(
    version_url: str,
    version_key: Optional[str],
    version_template: Optional[str],
    client: httpx.AsyncClient,
    basic_auth: Optional[str] = None,
    auth_header: Optional[str] = None,
    version_metric: Optional[str] = None,
    version_label: Optional[str] = None,
    version_regex: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Return (version, error)."""
    auth = None
    headers: dict[str, str] = {}
    if auth_header:
        headers["Authorization"] = auth_header
    elif basic_auth and ":" in basic_auth:
        username, _, password = basic_auth.partition(":")
        auth = (username, password)

    try:
        resp = await client.get(version_url, auth=auth, headers=headers)
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        return None, f"unreachable ({type(e).__name__})"
    except Exception as e:
        return None, f"request error: {e}"

    if resp.status_code != 200:
        return None, f"HTTP {resp.status_code}"

    if version_metric:
        label = version_label or "version"
        version = _extract_from_metrics(resp.text, version_metric, label)
        if version is None:
            return None, f"metric '{version_metric}' with label '{label}' not found in response"
        return _post_process(version, version_regex)

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
        return _post_process(version, version_regex)

    if version_template:
        version = _extract_by_template(data, version_template)
        if version is None:
            return None, "version_template fields missing from response"
        return _post_process(version, version_regex)

    return None, "no version_key, version_template, or version_metric configured"
