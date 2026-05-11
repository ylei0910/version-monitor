from __future__ import annotations

import logging
from typing import Callable, Coroutine, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.config import AppConfig

logger = logging.getLogger(__name__)

CHECK_JOB_ID = "version_check"
NOTIFY_JOB_ID = "version_notify"


def create_scheduler(
    config: AppConfig,
    check_fn: Callable[[], Coroutine],
    notify_fn: Callable[[], Coroutine],
) -> Optional[AsyncIOScheduler]:
    has_check = config.github_check_interval_minutes > 0
    has_notify = bool(config.notify_cron)

    if not has_check and not has_notify:
        logger.info("Scheduler disabled (no check interval or notify cron configured)")
        return None

    scheduler = AsyncIOScheduler()

    if has_check:
        scheduler.add_job(
            check_fn,
            IntervalTrigger(minutes=config.github_check_interval_minutes),
            id=CHECK_JOB_ID,
            name="Version check",
            misfire_grace_time=60,
            coalesce=True,
        )
        logger.info("Check job: every %d minutes", config.github_check_interval_minutes)

    if has_notify:
        try:
            trigger = CronTrigger.from_crontab(config.notify_cron)
            scheduler.add_job(
                notify_fn,
                trigger,
                id=NOTIFY_JOB_ID,
                name="Version notify",
                misfire_grace_time=60,
                coalesce=True,
            )
            logger.info("Notify job: cron '%s'", config.notify_cron)
        except ValueError as e:
            logger.warning("Invalid NOTIFY_CRON '%s': %s — notify job disabled", config.notify_cron, e)

    return scheduler


def reschedule(
    scheduler: AsyncIOScheduler,
    config: AppConfig,
    check_fn: Callable[[], Coroutine],
    notify_fn: Callable[[], Coroutine],
) -> None:
    """Update both jobs after a settings change."""
    for job_id in (CHECK_JOB_ID, NOTIFY_JOB_ID):
        try:
            scheduler.remove_job(job_id)
        except Exception:
            pass

    if config.github_check_interval_minutes > 0:
        scheduler.add_job(
            check_fn,
            IntervalTrigger(minutes=config.github_check_interval_minutes),
            id=CHECK_JOB_ID,
            name="Version check",
            misfire_grace_time=60,
            coalesce=True,
        )
        logger.info("Check job rescheduled: every %d minutes", config.github_check_interval_minutes)

    if config.notify_cron:
        try:
            trigger = CronTrigger.from_crontab(config.notify_cron)
            scheduler.add_job(
                notify_fn,
                trigger,
                id=NOTIFY_JOB_ID,
                name="Version notify",
                misfire_grace_time=60,
                coalesce=True,
            )
            logger.info("Notify job rescheduled: cron '%s'", config.notify_cron)
        except ValueError as e:
            logger.warning("Invalid NOTIFY_CRON '%s': %s — notify job disabled", config.notify_cron, e)
