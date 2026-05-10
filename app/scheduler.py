from __future__ import annotations

import logging
from typing import Callable, Coroutine, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.config import AppConfig

logger = logging.getLogger(__name__)


def create_scheduler(
    config: AppConfig,
    check_and_notify_fn: Callable[[], Coroutine],
) -> Optional[AsyncIOScheduler]:
    if config.github_check_interval_minutes <= 0:
        logger.info("Scheduler disabled (GITHUB_CHECK_INTERVAL_MINUTES=0)")
        return None

    scheduler = AsyncIOScheduler()
    trigger = IntervalTrigger(minutes=config.github_check_interval_minutes)
    scheduler.add_job(
        check_and_notify_fn,
        trigger=trigger,
        id="version_check",
        name="Version check + notify",
        misfire_grace_time=60,
        coalesce=True,
    )
    logger.info(
        "Scheduler configured: check every %d minutes",
        config.github_check_interval_minutes,
    )
    return scheduler


def reschedule(
    scheduler: AsyncIOScheduler,
    config: AppConfig,
    check_and_notify_fn: Callable[[], Coroutine],
) -> None:
    """Update the scheduled interval after a settings change."""
    try:
        scheduler.remove_job("version_check")
    except Exception:
        pass

    if config.github_check_interval_minutes > 0:
        trigger = IntervalTrigger(minutes=config.github_check_interval_minutes)
        scheduler.add_job(
            check_and_notify_fn,
            trigger=trigger,
            id="version_check",
            name="Version check + notify",
            misfire_grace_time=60,
            coalesce=True,
        )
        logger.info(
            "Scheduler rescheduled: every %d minutes",
            config.github_check_interval_minutes,
        )
    else:
        logger.info("Scheduler paused (interval set to 0)")
