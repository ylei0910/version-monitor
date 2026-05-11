from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml
from dotenv import load_dotenv

from app.models import ServiceConfig

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent.parent
SERVICES_YAML = ROOT_DIR / "services.yaml"
ENV_FILE = ROOT_DIR / ".env"


@dataclass
class AppConfig:
    github_token: Optional[str]
    telegram_bot_token: str
    telegram_chat_id: str
    github_check_interval_minutes: int
    services: list[ServiceConfig] = field(default_factory=list)


def _load_services(path: Path) -> list[ServiceConfig]:
    if not path.exists():
        raise FileNotFoundError(
            f"services.yaml not found at {path}. "
            f"Copy services.yaml.example to services.yaml and configure your services."
        )
    try:
        with open(path) as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise ValueError(f"Invalid services.yaml: {e}") from e

    raw_services = (data or {}).get("services", [])
    services: list[ServiceConfig] = []
    seen_names: set[str] = set()

    for raw in raw_services:
        svc = ServiceConfig.model_validate(raw)
        if svc.name in seen_names:
            raise ValueError(f"Duplicate service name in services.yaml: '{svc.name}'")
        seen_names.add(svc.name)

        if svc.version_key and svc.version_template:
            logger.warning(
                "Service '%s' has both version_key and version_template — using version_key",
                svc.name,
            )
            svc = svc.model_copy(update={"version_template": None})

        services.append(svc)

    return services


def load_config() -> AppConfig:
    load_dotenv(ENV_FILE, override=False)

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

    if not bot_token or not chat_id:
        logger.warning(
            "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — "
            "notifications disabled until configured via Settings or Restore"
        )

    interval_raw = os.environ.get("GITHUB_CHECK_INTERVAL_MINUTES", "1440").strip()
    try:
        interval = int(interval_raw)
    except ValueError:
        logger.warning(
            "Invalid GITHUB_CHECK_INTERVAL_MINUTES='%s', defaulting to 1440", interval_raw
        )
        interval = 1440

    if interval < 0:
        logger.warning("GITHUB_CHECK_INTERVAL_MINUTES cannot be negative, defaulting to 1440")
        interval = 1440

    services = _load_services(SERVICES_YAML)

    return AppConfig(
        github_token=os.environ.get("GITHUB_TOKEN", "").strip() or None,
        telegram_bot_token=bot_token,
        telegram_chat_id=chat_id,
        github_check_interval_minutes=interval,
        services=services,
    )


def reload_services(cfg: AppConfig) -> None:
    """Hot-reload services from disk into an existing AppConfig instance."""
    cfg.services = _load_services(SERVICES_YAML)


def save_services(services: list[ServiceConfig]) -> None:
    """Write a new services list to services.yaml atomically."""
    data = {"services": [svc.model_dump(exclude_none=True) for svc in services]}
    tmp = SERVICES_YAML.with_suffix(".yaml.tmp")
    with open(tmp, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    tmp.replace(SERVICES_YAML)


def save_setting_interval(minutes: int) -> None:
    """Update GITHUB_CHECK_INTERVAL_MINUTES in the .env file."""
    lines: list[str] = []
    found = False

    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            lines = f.readlines()

    new_lines: list[str] = []
    for line in lines:
        if line.startswith("GITHUB_CHECK_INTERVAL_MINUTES="):
            new_lines.append(f"GITHUB_CHECK_INTERVAL_MINUTES={minutes}\n")
            found = True
        else:
            new_lines.append(line)

    if not found:
        new_lines.append(f"GITHUB_CHECK_INTERVAL_MINUTES={minutes}\n")

    with open(ENV_FILE, "w") as f:
        f.writelines(new_lines)

    os.environ["GITHUB_CHECK_INTERVAL_MINUTES"] = str(minutes)


def save_secrets(telegram_bot_token: str, telegram_chat_id: str, github_token: str | None) -> None:
    """Update credential env vars in the .env file."""
    updates = {
        "TELEGRAM_BOT_TOKEN": telegram_bot_token,
        "TELEGRAM_CHAT_ID": telegram_chat_id,
    }
    if github_token is not None:
        updates["GITHUB_TOKEN"] = github_token

    lines: list[str] = []
    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            lines = f.readlines()

    found = {k: False for k in updates}
    new_lines: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0]
        if key in updates:
            new_lines.append(f"{key}={updates[key]}\n")
            found[key] = True
        else:
            new_lines.append(line)

    for key, seen in found.items():
        if not seen:
            new_lines.append(f"{key}={updates[key]}\n")

    with open(ENV_FILE, "w") as f:
        f.writelines(new_lines)

    for key, value in updates.items():
        os.environ[key] = value
