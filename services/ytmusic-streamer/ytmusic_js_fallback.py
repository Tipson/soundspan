"""Opt-in JavaScript-client recovery inside an owned extraction deadline."""

import os
import re
import threading
import time
from collections.abc import Callable
from typing import Any, TypeVar

from yt_dlp.networking.exceptions import RequestError
from yt_dlp.utils import DownloadError
from ytmusic_extraction_budget import ExtractionAbandoned, ExtractionBudget
from ytmusic_runtime import log

T = TypeVar("T")


class SpoolLimitExceeded(RuntimeError):
    """A spool policy limit must not trigger another extraction attempt."""


def parse_bool_flag(raw: str | None) -> bool:
    """Enable the solver only for a recognized explicit opt-in value."""
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


JS_CLIENT_FALLBACK_ENABLED = parse_bool_flag(os.getenv("YTMUSIC_JS_CLIENT_FALLBACK"))
JS_FALLBACK_SLOT_WAIT_SECONDS = 15.0
_JS_FALLBACK_BUDGET = ExtractionBudget(1)
_MAX_EXCEPTION_CHAIN_LINKS = 10


def javascript_options(options: dict[str, Any], *, spool: bool) -> dict[str, Any]:
    """Preserve download limits/hooks while enabling one full JavaScript lookup."""
    extractors = options.get("extractor_args", {})
    youtube = extractors.get("youtube", {})
    return {
        **options,
        "js_runtimes": {"deno": {}},
        "extractor_args": {
            **extractors,
            "youtube": {
                **youtube,
                "player_client": ["default", "web_safari"] if spool else ["default"],
                "skip": [],
            },
        },
    }


def is_fallback_eligible(error: BaseException) -> bool:
    """Reject bounded chains containing age, transport, cancellation or limit failures."""
    if not isinstance(error, DownloadError):
        return False
    pending = [error]
    visited: set[int] = set()
    for _ in range(_MAX_EXCEPTION_CHAIN_LINKS):
        if not pending:
            return True
        current = pending.pop()
        if id(current) in visited:
            continue
        visited.add(id(current))
        if isinstance(current, (SpoolLimitExceeded, ExtractionAbandoned, OSError, RequestError)):
            return False
        message = str(current).lower()
        if any(
            marker in message
            for marker in (
                "confirm your age",
                "age-restricted",
                "inappropriate",
                "age_verification_required",
                "age_check_required",
            )
        ):
            return False
        if any(
            marker in message
            for marker in (
                "timed out",
                "connection reset",
                "connection refused",
                "network is unreachable",
            )
        ) or re.search(r"\bhttp error [45]\d{2}\b", message):
            return False
        pending.extend(
            cause
            for cause in (current.__cause__, current.__context__, getattr(current, "cause", None))
            if isinstance(cause, BaseException)
        )
        exc_info = getattr(current, "exc_info", None)
        if (
            isinstance(exc_info, tuple)
            and len(exc_info) > 1
            and isinstance(exc_info[1], BaseException)
        ):
            pending.append(exc_info[1])
    return not pending


def run_with_js_fallback(
    primary: Callable[[], T],
    fallback: Callable[[], T],
    *,
    label: str,
    deadline: float,
    cancel_event: threading.Event | None = None,
    priority: Callable[[], int] | None = None,
    check: Callable[[], None] = lambda: None,
    check_result: Callable[[], None] | None = None,
) -> T:
    """Try one eligible recovery without releasing its real worker's solver slot.

    The caller retains its outer extraction lease. This additional one-slot
    budget limits solver memory and reuses playback/preload/background order.
    """

    def check_active() -> None:
        check()
        if (cancel_event is not None and cancel_event.is_set()) or time.monotonic() >= deadline:
            raise ExtractionAbandoned("JavaScript extraction request was abandoned")

    def check_completed() -> None:
        if check_result is None:
            check_active()
        else:
            check_result()
            if cancel_event is not None and cancel_event.is_set():
                raise ExtractionAbandoned("JavaScript extraction request was abandoned")

    check_active()
    try:
        result = primary()
        check_completed()
        return result
    except Exception as original:
        if not JS_CLIENT_FALLBACK_ENABLED or not is_fallback_eligible(original):
            raise
        check_active()
        admitted = False
        try:
            with _JS_FALLBACK_BUDGET.lease(
                cancel_event=cancel_event,
                deadline=min(deadline, time.monotonic() + JS_FALLBACK_SLOT_WAIT_SECONDS),
                priority=priority,
            ):
                admitted = True
                check_active()
                log.info("Trying one bounded JavaScript-client recovery for %s", label)
                result = fallback()
                check_completed()
                return result
        except ExtractionAbandoned:
            if admitted:
                raise
            # Preserve a real request timeout/cancellation. A busy solver alone
            # must not extend the caller's deadline or replace its provider error.
            check_active()
            raise original from None
