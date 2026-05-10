from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

from app.models import ServiceStatus

logger = logging.getLogger(__name__)


def _build_message(
    outdated: list[ServiceStatus],
    errors: list[ServiceStatus],
) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    parts = [f"*Version Monitor — {now}*"]

    if outdated:
        parts.append("\n*Updates available:*")
        for svc in outdated:
            installed = svc.installed_version or "not set"
            latest = svc.latest_version or "unknown"
            parts.append(f"• *{svc.name}*: `{installed}` → `{latest}`")

    if errors:
        parts.append("\n*Check failures:*")
        for svc in errors:
            url_hint = ""
            parts.append(f"• *{svc.name}*: {svc.error or 'unknown error'}{url_hint}")

    summary_parts = []
    if outdated:
        summary_parts.append(f"{len(outdated)} update{'s' if len(outdated) != 1 else ''}")
    if errors:
        summary_parts.append(f"{len(errors)} failure{'s' if len(errors) != 1 else ''}")
    if summary_parts:
        parts.append("\n" + ", ".join(summary_parts))

    return "\n".join(parts)


async def send_telegram_notification(
    bot_token: str,
    chat_id: str,
    outdated: list[ServiceStatus],
    errors: list[ServiceStatus],
    client: httpx.AsyncClient,
) -> tuple[bool, Optional[str]]:
    """Return (sent, message_text_or_error)."""
    if not outdated and not errors:
        return False, None

    message = _build_message(outdated, errors)
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"

    try:
        resp = await client.post(
            url,
            json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"},
        )
        if resp.status_code != 200:
            detail = resp.text[:200]
            logger.error("Telegram API error %s: %s", resp.status_code, detail)
            return False, f"Telegram API error {resp.status_code}: {detail}"
    except Exception as e:
        logger.error("Failed to send Telegram notification: %s", e)
        return False, f"Telegram request failed: {e}"

    return True, message
