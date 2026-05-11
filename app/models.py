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
    has_version_url: bool
    has_github: bool
    has_basic_auth: bool


class AppSettings(BaseModel):
    github_check_interval_minutes: int
    scheduler_enabled: bool


class ConfigResponse(BaseModel):
    services: list[ConfigServiceMeta]
    settings: AppSettings


class UpdateServicesRequest(BaseModel):
    services: list[ServiceConfig]


class UpdateSettingsRequest(BaseModel):
    github_check_interval_minutes: int
