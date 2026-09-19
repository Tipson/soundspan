"""Optional, anonymous PO-token recovery after a bot challenge, never a primary client.

Installing the pinned bgutil HTTP plugin opts an image into this fallback. Its
provider must run on loopback; ordinary images without the plugin stay unchanged.
One process-wide probe runs at a time, inside the caller's extraction budget.
"""

import math
import threading
import time
from collections.abc import Callable
from functools import lru_cache
from importlib import import_module
from typing import Any, TypeVar

from yt_dlp.utils import DownloadError

T = TypeVar("T")


@lru_cache(maxsize=1)
def provider_available() -> bool:
    """Fail closed unless the explicitly packaged plugin/version is present."""
    try:
        plugin = import_module("yt_dlp_plugins.extractor.getpot_bgutil_http")
        return bool(plugin.BgUtilHTTPPTP.PROVIDER_VERSION == "2.0.0")
    except (ImportError, AttributeError):
        return False


class FallbackDeferred(Exception):
    """Reject duplicate probes without extending the ordinary provider cooldown."""

    def __init__(self, retry_after: int) -> None:
        super().__init__("PO recovery is busy or cooling down")
        self.retry_after = retry_after


class PoFallback:
    """Serialize recovery attempts and cool down for 90 seconds after failure."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._retry_at = 0.0

    def run(
        self,
        primary: Callable[[], T],
        probe: Callable[[], T],
        *,
        check: Callable[[], None] = lambda: None,
    ) -> T:
        """Try one probe only for a recognized bot challenge, preserving cancellation."""
        try:
            return primary()
        except DownloadError as original:
            message = str(original).lower()
            if not (
                "sign in to confirm you" in message
                and "not a bot" in message
                and provider_available()
            ):
                raise
            check()
            if not self._lock.acquire(blocking=False):
                raise FallbackDeferred(2) from None
            try:
                remaining = self._retry_at - time.monotonic()
                if remaining > 0:
                    raise FallbackDeferred(max(1, math.ceil(remaining))) from None
                check()
                try:
                    result = probe()
                    check()
                    return result
                except Exception:
                    # Cancellation must not become a provider failure or another retry.
                    check()
                    self._retry_at = time.monotonic() + 90
                    raise original from None
            finally:
                self._lock.release()


class _QuietTokenLogger:
    """Do not forward upstream trace messages that can contain signed URLs/tokens."""

    def debug(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


def primary_options(options: dict[str, Any]) -> dict[str, Any]:
    """Prevent an installed provider from doing token work outside the recovery gate."""
    extractors = options.get("extractor_args", {})
    return {
        **options,
        "extractor_args": {
            **extractors,
            "youtube": {**extractors.get("youtube", {}), "fetch_pot": ["never"]},
        },
    }


def token_options(options: dict[str, Any]) -> dict[str, Any]:
    """Preserve quality/size/hooks while replacing anonymous-client shortcuts."""
    return {
        **options,
        "extractor_args": {
            "youtube": {"player_client": ["mweb"]},
            "youtubepot-bgutilhttp": {"base_url": ["http://127.0.0.1:4416"]},
        },
        "retries": 0,
        "extractor_retries": 0,
        "fragment_retries": 0,
        "logger": _QuietTokenLogger(),
        "verbose": False,
    }
