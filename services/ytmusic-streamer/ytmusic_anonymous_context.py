"""Reuse bounded anonymous YouTube context, never account cookies or audio URLs.

The private capture hook is enabled only for the tested yt-dlp release. A stale
context falls back once to ordinary extraction, within the caller's work slot.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import yt_dlp
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.version import __version__


class VisitorContext:
    """One anonymous value with fixed TTL, bounded size and rejection backoff."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._value: str | None = None
        self._expires = 0.0
        self._blocked_until = 0.0
        self._lock = threading.Lock()

    def get(self) -> str | None:
        """Return live context without extending its ten-minute lifetime."""
        with self._lock:
            now = self._clock()
            return self._value if self._blocked_until <= now < self._expires else None

    def put(self, value: str) -> None:
        """Store context only after a successful ordinary extraction."""
        if not value or len(value) > 4096:
            return
        with self._lock:
            self._value = value
            self._expires = self._clock() + 600

    def reject(self, value: str) -> None:
        """Invalidate the failed value without erasing a concurrent replacement."""
        with self._lock:
            if self._value == value:
                self._value = None
                self._blocked_until = self._clock() + 60


_context = VisitorContext()


class _CapturingYoutubeIE(YoutubeIE):  # type: ignore[misc,no-any-unimported]  # Upstream is untyped.
    visitor: str | None = None

    @classmethod
    def ie_key(cls) -> str:
        return "Youtube"

    def _extract_visitor_data(self, *args: Any) -> Any:
        value = super()._extract_visitor_data(*args)
        if isinstance(value, str):
            self.visitor = value
        return value


def extract_music(
    ydl: Any,
    url: str,
    options: dict[str, Any],
    ordinary: Callable[[Any, str, dict[str, Any]], Any],
    pace: Callable[[], Any],
) -> Any:
    """Resolve HIGH Opus through one player request, retaining ordinary fallback.

    Other qualities, authenticated instances and unknown upstream versions do
    not use the shortcut. A transport failure is not retried. Rejected context
    or missing equivalent audio returns to the original selection policy.
    """
    if (
        __version__ != "2026.08.19"
        or not callable(getattr(ydl, "add_info_extractor", None))
        or any(
            options.get(key) for key in ("cookiefile", "cookiesfrombrowser", "username", "password")
        )
        or getattr(ydl, "cookiejar", None)
    ):
        return ordinary(ydl, url, options)
    capture = _CapturingYoutubeIE()
    ydl.add_info_extractor(capture)
    visitor = _context.get()
    if visitor and options.get("format") == "ba[abr<=256]/ba/b[height<=360]/b":
        extractor_args = options.get("extractor_args", {})
        fast_options = {
            **options,
            "extractor_args": {
                **extractor_args,
                "youtube": {
                    **extractor_args.get("youtube", {}),
                    "player_client": ["visionos"],
                    "player_skip": ["webpage", "configs", "initial_data"],
                    "visitor_data": [visitor],
                },
            },
        }
        try:
            with yt_dlp.YoutubeDL(fast_options) as fast:
                info = fast.extract_info(url, download=False)
            if (
                info
                and info.get("format_id") == "251"
                and info.get("acodec") == "opus"
                and info.get("vcodec") == "none"
                and info.get("protocol") == "https"
                and info.get("url")
            ):
                return info
        except yt_dlp.utils.DownloadError as error:
            message = str(error).lower()
            if "not a bot" not in message and "requested format is not available" not in message:
                raise
        _context.reject(visitor)
        pace()
    result = ordinary(ydl, url, options)
    if result and capture.visitor:
        _context.put(capture.visitor)
    return result
