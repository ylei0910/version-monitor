from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from packaging.version import InvalidVersion
from packaging.version import Version as PkgVersion

from app.config import (
    AppConfig,
    load_config,
    reload_services,
    save_services,
    save_setting_interval,
    save_secrets,
)
from app.database import close_db, get_all_versions, init_db, set_version
from app.github import get_last_fetch_time, get_latest_version
from app.models import (
    AppSettings,
    ConfigResponse,
    ConfigServiceMeta,
    NotifyResponse,
    SaveVersionRequest,
    SaveVersionResponse,
    ServiceConfig,
    ServiceListResponse,
    ServiceStatus,
    UpdateServicesRequest,
    UpdateSettingsRequest,
    BackupData,
    BackupSecrets,
)
from app.notifier import send_telegram_notification
from app.scheduler import create_scheduler, reschedule
from app.version import fetch_installed_version

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent.parent
STATIC_DIR = ROOT_DIR / "static"

APP_VERSION = (ROOT_DIR / "VERSION").read_text().strip()

_config: AppConfig
_http_client: httpx.AsyncClient
_scheduler = None
_config_lock = asyncio.Lock()


def _compare_versions(installed: str, latest: str) -> bool:
    """Return True if installed >= latest (up to date)."""
    a = installed.lstrip("v").strip()
    b = latest.lstrip("v").strip()
    try:
        return PkgVersion(a) >= PkgVersion(b)
    except InvalidVersion:
        return a == b


async def _build_service_statuses() -> list[ServiceStatus]:
    manual_versions = await get_all_versions()

    async with _config_lock:
        services = list(_config.services)
        token = _config.github_token
        ttl = _config.github_check_interval_minutes * 60

    async def fetch_one(svc: ServiceConfig) -> ServiceStatus:
        installed_version: Optional[str] = None
        latest_version: Optional[str] = None
        errors: list[str] = []

        if svc.version_url:
            fetched, err = await fetch_installed_version(
                svc.version_url, svc.version_key, svc.version_template, _http_client,
                basic_auth=svc.basic_auth,
            )
            if fetched:
                installed_version = fetched
            else:
                errors.append(err or "version fetch failed")
                installed_version = manual_versions.get(svc.name)
        else:
            installed_version = manual_versions.get(svc.name)

        if svc.github:
            latest_version, gh_err = await get_latest_version(
                svc.github, _http_client, token, ttl
            )
            if gh_err and not latest_version:
                errors.append(f"GitHub: {gh_err}")

        is_up_to_date: Optional[bool] = None
        if installed_version and latest_version:
            is_up_to_date = _compare_versions(installed_version, latest_version)

        return ServiceStatus(
            name=svc.name,
            installed_version=installed_version,
            latest_version=latest_version,
            is_up_to_date=is_up_to_date,
            is_manual=svc.version_url is None,
            has_github=svc.github is not None,
            error="; ".join(errors) if errors else None,
        )

    tasks = [fetch_one(svc) for svc in services]
    return await asyncio.gather(*tasks)


async def _run_check_and_notify() -> NotifyResponse:
    statuses = await _build_service_statuses()

    outdated = [s for s in statuses if s.is_up_to_date is False]
    fetch_errors = [
        s for s in statuses
        if s.error and s.is_up_to_date is None and s.installed_version is None
    ]

    sent, msg = await send_telegram_notification(
        _config.telegram_bot_token,
        _config.telegram_chat_id,
        outdated,
        fetch_errors,
        _http_client,
    )
    return NotifyResponse(
        sent=sent,
        message=msg,
        outdated_count=len(outdated),
        error_count=len(fetch_errors),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _config, _http_client, _scheduler

    _config = load_config()
    _http_client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0))
    await init_db()

    _scheduler = create_scheduler(_config, _run_check_and_notify)
    if _scheduler:
        _scheduler.start()

    yield

    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
    await _http_client.aclose()
    await close_db()


app = FastAPI(title="Version Monitor", version=APP_VERSION, lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "version": APP_VERSION}


@app.get("/api/services", response_model=ServiceListResponse)
async def list_services():
    statuses = await _build_service_statuses()
    return ServiceListResponse(
        services=statuses,
        last_updated=datetime.now(timezone.utc),
        last_github_fetch=get_last_fetch_time(),
    )


@app.post("/api/services/{name}/version", response_model=SaveVersionResponse)
async def save_service_version(name: str, body: SaveVersionRequest):
    async with _config_lock:
        known = {svc.name for svc in _config.services}
    if name not in known:
        raise HTTPException(status_code=404, detail=f"Service '{name}' not found")
    if not body.version.strip():
        raise HTTPException(status_code=422, detail="version must not be empty")
    await set_version(name, body.version.strip())
    return SaveVersionResponse(name=name, version=body.version.strip())


@app.post("/api/notify", response_model=NotifyResponse)
async def trigger_notify():
    return await _run_check_and_notify()


@app.get("/api/config", response_model=ConfigResponse)
async def get_config():
    async with _config_lock:
        services = list(_config.services)
        interval = _config.github_check_interval_minutes

    meta = [
        ConfigServiceMeta(
            name=svc.name,
            github=svc.github,
            version_url=svc.version_url,
            version_key=svc.version_key,
            version_template=svc.version_template,
            has_version_url=svc.version_url is not None,
            has_github=svc.github is not None,
            has_basic_auth=svc.basic_auth is not None,
        )
        for svc in services
    ]
    return ConfigResponse(
        services=meta,
        settings=AppSettings(
            github_check_interval_minutes=interval,
            scheduler_enabled=interval > 0,
        ),
    )


@app.post("/api/config/services", response_model=ConfigResponse)
async def update_services(body: UpdateServicesRequest):
    names = [s.name for s in body.services]
    if len(names) != len(set(names)):
        raise HTTPException(status_code=422, detail="Duplicate service names")

    # Preserve basic_auth from existing config — it is never sent via the UI
    async with _config_lock:
        existing = {svc.name: svc.basic_auth for svc in _config.services}
    merged = [
        svc.model_copy(update={"basic_auth": svc.basic_auth or existing.get(svc.name)})
        for svc in body.services
    ]

    try:
        save_services(merged)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write services.yaml: {e}")

    async with _config_lock:
        try:
            reload_services(_config)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Config reload failed: {e}")

    return await get_config()


@app.delete("/api/config/services/{name}", response_model=ConfigResponse)
async def delete_service(name: str):
    async with _config_lock:
        services = list(_config.services)

    new_services = [s for s in services if s.name != name]
    if len(new_services) == len(services):
        raise HTTPException(status_code=404, detail=f"Service '{name}' not found")

    try:
        save_services(new_services)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write services.yaml: {e}")

    async with _config_lock:
        reload_services(_config)

    return await get_config()


@app.post("/api/config/settings", response_model=ConfigResponse)
async def update_settings(body: UpdateSettingsRequest):
    if body.github_check_interval_minutes < 0:
        raise HTTPException(
            status_code=422,
            detail="github_check_interval_minutes must be 0 (disabled) or ≥1",
        )

    try:
        save_setting_interval(body.github_check_interval_minutes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update .env: {e}")

    async with _config_lock:
        _config.github_check_interval_minutes = body.github_check_interval_minutes

    if _scheduler:
        reschedule(_scheduler, _config, _run_check_and_notify)

    return await get_config()


@app.get("/api/backup")
async def backup(include_secrets: bool = False):
    async with _config_lock:
        services = list(_config.services)
        interval = _config.github_check_interval_minutes

    manual_versions = await get_all_versions()

    secrets = None
    if include_secrets:
        secrets = BackupSecrets(
            telegram_bot_token=_config.telegram_bot_token,
            telegram_chat_id=_config.telegram_chat_id,
            github_token=_config.github_token,
        )

    data = BackupData(
        exported_at=datetime.now(timezone.utc),
        services=services,
        manual_versions=manual_versions,
        settings=AppSettings(
            github_check_interval_minutes=interval,
            scheduler_enabled=interval > 0,
        ),
        secrets=secrets,
    )

    filename = f"version-monitor-backup-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    return JSONResponse(
        content=data.model_dump(mode="json"),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/restore", response_model=ConfigResponse)
async def restore(body: BackupData):
    # Restore services
    try:
        save_services(body.services)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to restore services: {e}")

    async with _config_lock:
        try:
            reload_services(_config)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Config reload failed: {e}")

    # Restore manual versions
    for name, version in body.manual_versions.items():
        await set_version(name, version)

    # Restore settings
    try:
        save_setting_interval(body.settings.github_check_interval_minutes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to restore settings: {e}")

    async with _config_lock:
        _config.github_check_interval_minutes = body.settings.github_check_interval_minutes

    if _scheduler:
        reschedule(_scheduler, _config, _run_check_and_notify)

    # Restore secrets if present
    if body.secrets:
        try:
            save_secrets(
                telegram_bot_token=body.secrets.telegram_bot_token or _config.telegram_bot_token,
                telegram_chat_id=body.secrets.telegram_chat_id or _config.telegram_chat_id,
                github_token=body.secrets.github_token,
            )
            async with _config_lock:
                if body.secrets.telegram_bot_token:
                    _config.telegram_bot_token = body.secrets.telegram_bot_token
                if body.secrets.telegram_chat_id:
                    _config.telegram_chat_id = body.secrets.telegram_chat_id
                if body.secrets.github_token is not None:
                    _config.github_token = body.secrets.github_token or None
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to restore secrets: {e}")

    return await get_config()


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
