from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ServiceConfig(BaseModel):
    name: str
    github: Optional[str] = None
    version_url: Optional[str] = None
    version_key: Optional[str] = None
    version_template: Optional[str] = None
    version_metric: Optional[str] = None  # Prometheus metric name, e.g. "cs_info"
    version_label: Optional[str] = None   # label to extract (default: "version")
    version_regex: Optional[str] = None   # regex with one capture group applied to extracted value
    basic_auth: Optional[str] = None  # "username:password"


class ServiceStatus(BaseModel):
    name: str
    installed_version: Optional[str] = None
    latest_version: Optional[str] = None
    is_up_to_date: Optional[bool] = None
    is_manual: bool
    has_github: bool
    error: Optional[str] = None


class ServiceListResponse(BaseModel):
    services: list[ServiceStatus]
    last_updated: datetime
    last_github_fetch: Optional[datetime] = None


class SaveVersionRequest(BaseModel):
    version: str


class SaveVersionResponse(BaseModel):
    name: str
    version: str


class NotifyResponse(BaseModel):
    sent: bool
    message: Optional[str] = None
    outdated_count: int
    error_count: int


class ConfigServiceMeta(BaseModel):
    name: str
    github: Optional[str] = None
    version_url: Optional[str] = None
    version_key: Optional[str] = None
    version_template: Optional[str] = None
    version_metric: Optional[str] = None
    version_label: Optional[str] = None
    version_regex: Optional[str] = None
    has_version_url: bool
    has_github: bool
    has_basic_auth: bool
    basic_auth: Optional[str] = None


class AppSettings(BaseModel):
    github_check_interval_minutes: int
    scheduler_enabled: bool
    has_telegram_token: bool = False
    has_telegram_chat_id: bool = False
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None


class ConfigResponse(BaseModel):
    services: list[ConfigServiceMeta]
    settings: AppSettings


class UpdateServicesRequest(BaseModel):
    services: list[ServiceConfig]


class UpdateSettingsRequest(BaseModel):
    github_check_interval_minutes: int
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None


class BackupSecrets(BaseModel):
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    github_token: Optional[str] = None


class BackupData(BaseModel):
    backup_version: str = "1"
    exported_at: datetime
    services: list[ServiceConfig]
    manual_versions: dict[str, str]
    settings: AppSettings
    secrets: Optional[BackupSecrets] = None
