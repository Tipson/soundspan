"""Stream extraction, proxying, regular-YouTube metadata, and caches."""

import asyncio
import os
import re
import tempfile
import threading
import time
from collections.abc import AsyncIterator, Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Literal, TypeVar, cast
from urllib.parse import urlsplit

import requests
from fastapi import HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from yt_download import (
    PROXY_AUDIO_FORMAT_SELECTORS,
    YT_PLAYER_CLIENTS,
    build_playlist_entries,
    classify_youtube_url,
    derive_proxy_audio_container,
)
from yt_download import (
    extract_video_id as _extract_video_id,
)
from ytmusic_client import _get_ytmusic
from ytmusic_extraction_budget import ExtractionAbandoned, ExtractionBudget
from ytmusic_runtime import (
    _USER_AGENT,
    JsonObject,
    _bound_cache,
    _sanitized_http_error,
    app,
    log,
)

from services.common.sidecar_runtime_utils import (
    ThreadSafeRatePacer,
    build_full_proxy_response,
    build_range_proxy_response,
    env_float,
    env_int,
)

T = TypeVar("T")

# Default cap for regular-YouTube playlist and channel enumeration.
YT_PLAYLIST_MAX_ENTRIES = max(1, env_int("YT_PLAYLIST_MAX_ENTRIES", "200"))

# Delay range and bounded executor for yt-dlp extraction.
EXTRACT_DELAY_MIN = env_float("YTMUSIC_EXTRACT_DELAY_MIN", "0.5")
EXTRACT_DELAY_MAX = env_float("YTMUSIC_EXTRACT_DELAY_MAX", "2.0")
_extract_pacer = ThreadSafeRatePacer(EXTRACT_DELAY_MIN, EXTRACT_DELAY_MAX)
EXTRACT_TIMEOUT = env_float("YTMUSIC_EXTRACT_TIMEOUT", "60")
YTDLP_EXTRACT_CONCURRENCY = max(1, min(16, env_int("YTMUSIC_YTDLP_EXTRACT_CONCURRENCY", "2")))
_extraction_budget = ExtractionBudget(YTDLP_EXTRACT_CONCURRENCY)
_metadata_admission = threading.BoundedSemaphore(8)
_yt_dlp_extract_executor = ThreadPoolExecutor(
    max_workers=YTDLP_EXTRACT_CONCURRENCY,
    thread_name_prefix="yt-dlp-extract",
)
BROWSE_TIMEOUT = env_float("YTMUSIC_BROWSE_TIMEOUT", "30")
YTDLP_SOCKET_TIMEOUT = env_float("YTMUSIC_YTDLP_SOCKET_TIMEOUT", "20")

# YouTube Music download spool. yt-dlp owns YouTube delivery; clients range-read
# the completed local file instead of continuation-reading signed URLs.
YTMUSIC_SPOOL_DIR = Path(
    os.getenv("YTMUSIC_SPOOL_DIR") or Path(tempfile.gettempdir()) / "soundspan-ytmusic-spool"
)
YTMUSIC_SPOOL_MAX_BYTES = max(
    16 * 1024 * 1024,
    env_int("YTMUSIC_SPOOL_MAX_BYTES", str(256 * 1024 * 1024)),
)
YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT = env_float("YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT", "300")
YTMUSIC_SPOOL_TRACK_MAX_BYTES = max(
    1 * 1024 * 1024,
    env_int("YTMUSIC_SPOOL_TRACK_MAX_BYTES", str(64 * 1024 * 1024)),
)
# Stay below the backend's 120-second timeout so callers receive this sidecar's 504.
YTMUSIC_SPOOL_TIMEOUT = env_float("YTMUSIC_SPOOL_TIMEOUT", "110")
YTMUSIC_SPOOL_CONCURRENCY = max(1, min(4, env_int("YTMUSIC_SPOOL_CONCURRENCY", "2")))
_PROVIDER_CHALLENGE_COOLDOWN_SECONDS = 90.0
_SPOOL_PARTIAL_STALE_SECONDS = 900
_SPOOL_EVICT_MIN_AGE_SECONDS = 60
_SPOOL_MAX_PENDING_JOBS = 8
_SPOOL_MAX_BACKGROUND_PENDING_JOBS = max(0, _SPOOL_MAX_PENDING_JOBS - 1)
_SPOOL_READ_CHUNK_BYTES = 64 * 1024
_SPOOL_CDN_RANGE_BYTES = 1024 * 1024
_SPOOL_PREFIX_PROBE_BYTES = 2 * 1024 * 1024
_SOUNDSPAN_PART_SUFFIX = ".soundspan-part"
_SPOOL_DRAIN_SECONDS = 5.0
_SPOOL_RENAME_RETRY_SECONDS = 0.01
_SPOOL_RENAME_MAX_ATTEMPTS = 21
_SPOOL_PROVIDER_IDENTITY = "public-spool"
_SPOOL_TRANSIENT_FAILURE_COOLDOWN_SECONDS = 5.0
_SPOOL_UNAVAILABLE_FAILURE_COOLDOWN_SECONDS = 5.0
_SPOOL_FAILURE_CACHE_MAX = 512
_SPOOL_FAILURE_STATUSES = frozenset({404, 408, 410, 429, 451, 502, 503, 504})
_PROGRESSIVE_SOURCE_REFRESH_STATUSES = frozenset({401, 403, 410})
# Waiting jobs are cheap threads held outside yt-dlp by the process-wide
# extraction budget. Let every admitted job reach that priority-aware queue;
# otherwise background waiters can occupy this executor and hide an urgent
# interactive start behind them.
_yt_dlp_spool_executor = ThreadPoolExecutor(
    max_workers=_SPOOL_MAX_PENDING_JOBS,
    thread_name_prefix="yt-dlp-spool",
)
# All admitted jobs must reach the priority-aware transfer budget. The budget,
# not this executor's worker count, owns the network concurrency limit.
_spool_transfer_executor = ThreadPoolExecutor(
    max_workers=_SPOOL_MAX_PENDING_JOBS,
    thread_name_prefix="ytmusic-spool-transfer",
)
_spool_transfer_budget = ExtractionBudget(YTMUSIC_SPOOL_CONCURRENCY)
# The event loop owns all access, with no await between lookup and insertion.
_spool_tasks: dict[str, asyncio.Task[tuple[str, str]]] = {}
_spool_cancel_events: dict[str, threading.Event] = {}
_spool_waiters: dict[str, int] = {}
_spool_sessions: dict[str, "_SpoolSession"] = {}
_spool_failure_cache: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_spool_pinned_paths: set[Path] = set()
_spool_pin_counts: dict[Path, int] = {}
_spool_pending_jobs = 0
_spool_background_pending_jobs = 0
_spool_reserved_bytes = 0
_spool_admitting = True
_spool_prune_lock = threading.Lock()
_spool_worker_context = threading.local()
_provider_challenge_lock = threading.Lock()
_provider_challenge_cooldown_until = 0.0


_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ALLOWED_STREAM_QUALITIES = {"LOW", "MEDIUM", "HIGH", "LOSSLESS"}
_PERMANENT_UNAVAILABLE_PATTERNS = (
    re.compile(r"\b(?:this\s+)?video\s+(?:is\s+)?unavailable\b", re.IGNORECASE),
    re.compile(
        r"\b(?:this\s+)?video\s+is\s+(?:no\s+longer|not)\s+available\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:this\s+video\s+is\s+private|private\s+video)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:this\s+)?(?:video|content)\s+(?:has\s+been|was|is)\s+(?:removed|deleted)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:youtube\s+)?(?:account|channel|uploader)\b[^\r\n]{0,160}\bterminated\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bterminated\b[^\r\n]{0,160}\b(?:youtube\s+)?(?:account|channel|uploader)\b",
        re.IGNORECASE,
    ),
)
# Keep the verified default client isolated. Combining several clients merges
# their format tables; yt-dlp can then select an android_vr URL that resolves
# successfully but returns HTTP 403 when its bytes are downloaded. The default
# client produced a complete spool for the same production track.
_YTMUSIC_PLAYER_CLIENTS = ["default"]
# Keep per-track fragment fan-out modest while shortening complete-file spool time.
_SPOOL_FRAGMENT_CONCURRENCY = 4
_SPOOL_QUALITY_ALTERNATION = "|".join(
    re.escape(quality) for quality in sorted(_ALLOWED_STREAM_QUALITIES)
)
_SPOOL_OWNED_NAME_RE = re.compile(rf"^[A-Za-z0-9_-]{{11}}-({_SPOOL_QUALITY_ALTERNATION})\.")

# Stream URL cache (in-memory, URLs expire after approximately six hours).
_stream_cache: dict[str, JsonObject] = {}
_stream_cache_lock = threading.Lock()
STREAM_CACHE_TTL = 5 * 60 * 60
STREAM_CACHE_MAX = env_int("YTMUSIC_STREAM_CACHE_MAX", "1024")


def _spool_failure_key(
    video_id: str,
    quality: str,
    purpose: str,
    *,
    provider_identity: str,
) -> tuple[str, str, str, str]:
    """Scope a short failure cooldown to the actual provider request context."""
    return provider_identity, video_id, quality, purpose


def _spool_failure_ttl(status_code: int) -> float | None:
    if status_code not in _SPOOL_FAILURE_STATUSES:
        return None
    if status_code in {404, 410, 451}:
        return _SPOOL_UNAVAILABLE_FAILURE_COOLDOWN_SECONDS
    return _SPOOL_TRANSIENT_FAILURE_COOLDOWN_SECONDS


def _clean_spool_failure_cache(now: float | None = None) -> None:
    observed_at = time.monotonic() if now is None else now
    expired = [
        key
        for key, entry in _spool_failure_cache.items()
        if float(entry["expires_at"]) <= observed_at
    ]
    for key in expired:
        _spool_failure_cache.pop(key, None)


def _cache_spool_failure(
    key: tuple[str, str, str, str],
    error: HTTPException,
) -> None:
    """Briefly coalesce classified provider failures without caching auth or aborts."""
    ttl = _spool_failure_ttl(error.status_code)
    if ttl is None:
        return
    now = time.monotonic()
    _clean_spool_failure_cache(now)
    _spool_failure_cache.pop(key, None)
    _spool_failure_cache[key] = {
        "expires_at": now + ttl,
        "status_code": error.status_code,
        "detail": error.detail,
        "headers": dict(error.headers) if error.headers else None,
    }
    while len(_spool_failure_cache) > _SPOOL_FAILURE_CACHE_MAX:
        _spool_failure_cache.pop(next(iter(_spool_failure_cache)))


def _raise_cached_spool_failure(key: tuple[str, str, str, str]) -> None:
    now = time.monotonic()
    _clean_spool_failure_cache(now)
    entry = _spool_failure_cache.pop(key, None)
    if entry is None:
        return
    _spool_failure_cache[key] = entry
    raise HTTPException(
        status_code=int(entry["status_code"]),
        detail=entry["detail"],
        headers=entry["headers"],
    )


def _clear_spool_failures(video_id: str, quality: str) -> None:
    """Let one successful provider attempt clear stale scoped failures for the track."""
    for key in tuple(_spool_failure_cache):
        if key[1:3] == (video_id, quality):
            _spool_failure_cache.pop(key, None)


class _SpoolDownloadCancelled(Exception):
    """Stop a provider download after every HTTP waiter has disconnected."""


def _spool_purpose_priority(purpose: str) -> int:
    """Map a request purpose to background, preload, or current playback."""
    if purpose == "interactive":
        return 2
    if purpose == "preload":
        return 1
    return 0


def _notify_spool_priority_change() -> None:
    """Wake both phase queues when a shared task gains an interactive owner."""
    for budget in (_extraction_budget, _spool_transfer_budget):
        notify = getattr(budget, "notify_priority_change", None)
        if callable(notify):
            notify()


def _pin_spool_path(path: Path) -> None:
    """Reference-count one completed or in-progress path against pruning."""
    with _spool_prune_lock:
        _pin_spool_path_locked(path)


def _pin_spool_path_locked(path: Path) -> None:
    """Pin a path while the caller owns ``_spool_prune_lock``."""
    _spool_pin_counts[path] = _spool_pin_counts.get(path, 0) + 1
    _spool_pinned_paths.add(path)


def _unpin_spool_path(path: Path) -> None:
    """Release one prune pin without disturbing concurrent readers."""
    with _spool_prune_lock:
        remaining = _spool_pin_counts.get(path, 1) - 1
        if remaining > 0:
            _spool_pin_counts[path] = remaining
        else:
            _spool_pin_counts.pop(path, None)
            _spool_pinned_paths.discard(path)


class _SpoolSession:
    """Coordinate one append-only spool writer and all of its readers."""

    def __init__(
        self,
        key: str,
        loop: asyncio.AbstractEventLoop,
        cancel_event: threading.Event,
        *,
        allow_growing: bool,
        priority: int = 2,
    ) -> None:
        self.key = key
        self.loop = loop
        self.cancel_event = cancel_event
        self.allow_growing = allow_growing
        self.task: asyncio.Task[tuple[str, str]] | None = None
        self.partial_path: Path | None = None
        self.content_type: str | None = None
        self.content_length: int | None = None
        self.readable = False
        self._proven_prefix: tuple[Path, str, int | None] | None = None
        self.lease_count = 0
        self._changed = asyncio.Event()
        self._pinned_paths: set[Path] = set()
        self._pin_lock = threading.Lock()
        self.failure_scopes: set[tuple[str, str]] = set()
        self.priority = max(0, min(2, priority))
        self.background_admission = self.priority < 2

    def current_priority(self) -> int:
        """Return the latest owner priority for worker-side budget admission."""
        return self.priority

    def register_failure_scope(self, purpose: str, provider_identity: str) -> None:
        """Remember request contexts that joined this globally shared provider task."""
        global _spool_background_pending_jobs

        self.failure_scopes.add((purpose, provider_identity))
        if purpose in {"interactive", "preload"} and not self.allow_growing:
            self.allow_growing = True
            # The writer may have proved the prefix before this listener joined.
            # Analysis still awaits task completion through its own response path.
            if self._proven_prefix is not None:
                self.publish_readable(*self._proven_prefix)
        promoted_priority = _spool_purpose_priority(purpose)
        if promoted_priority <= self.priority:
            return
        self.priority = promoted_priority
        if self.priority == 2 and self.background_admission:
            self.background_admission = False
            if _spool_background_pending_jobs > 0:
                _spool_background_pending_jobs -= 1
            else:
                log.error("YouTube Music spool background counter underflow")
        _notify_spool_priority_change()

    def _notify(self) -> None:
        changed = self._changed
        self._changed = asyncio.Event()
        changed.set()

    def pin_path(self, path: Path) -> None:
        """Protect a partial or completed path from concurrent pruning."""
        with self._pin_lock:
            if path in self._pinned_paths:
                return
            self._pinned_paths.add(path)
            _pin_spool_path(path)

    def release_pins(self) -> None:
        """Release every prune pin owned by this session."""
        with self._pin_lock:
            for path in self._pinned_paths:
                _unpin_spool_path(path)
            self._pinned_paths.clear()

    def publish_readable(
        self, path: Path, content_type: str, content_length: int | None = None
    ) -> None:
        """Publish a prefix only after the writer proved it browser-readable."""
        self._proven_prefix = (path, content_type, content_length)
        if not self.allow_growing:
            return
        self.pin_path(path)
        self.partial_path = path
        self.content_type = content_type
        self.content_length = content_length
        self.readable = True
        self._notify()

    def publish_readable_from_worker(
        self, path: Path, content_type: str, content_length: int | None = None
    ) -> None:
        """Thread-safely publish a proven append-only prefix."""
        self.pin_path(path)
        try:
            self.loop.call_soon_threadsafe(
                self.publish_readable, path, content_type, content_length
            )
        except RuntimeError:
            return

    def publish_growth(self) -> None:
        """Wake readers after bytes land or the writer completes."""
        self._notify()

    def publish_growth_from_worker(self) -> None:
        """Thread-safely wake readers after an append."""
        try:
            self.loop.call_soon_threadsafe(self.publish_growth)
        except RuntimeError:
            return

    async def wait_for_growth(self, wait_seconds: float = 0.1) -> None:
        """Wait for writer progress without depending on polling alone."""
        changed = self._changed
        with suppress(TimeoutError):
            await asyncio.wait_for(changed.wait(), timeout=wait_seconds)


class _SpoolLease:
    """Keep shared work alive until one HTTP reader has really finished."""

    def __init__(
        self,
        key: str,
        task: asyncio.Future[tuple[str, str]],
        cancel_event: threading.Event | None,
        session: _SpoolSession | None,
    ) -> None:
        self.key = key
        self.task = task
        self.cancel_event = cancel_event
        self.session = session
        self.closed = False
        _spool_waiters[key] = _spool_waiters.get(key, 0) + 1
        if session is not None:
            session.lease_count += 1

    def close(self) -> None:
        """Release this waiter and cancel only after the final waiter leaves."""
        if self.closed:
            return
        self.closed = True
        remaining = _spool_waiters.get(self.key, 1) - 1
        if remaining > 0:
            _spool_waiters[self.key] = remaining
        else:
            _spool_waiters.pop(self.key, None)
            if not self.task.done() and self.cancel_event is not None:
                self.cancel_event.set()
        if self.session is not None:
            self.session.lease_count = max(0, self.session.lease_count - 1)
            _cleanup_spool_session_if_unused(self.session)


class _PinnedFileResponse(FileResponse):
    """Keep a completed spool file pinned for the ASGI response lifetime."""

    def __init__(self, path: str, content_type: str, *, pin_owned: bool = False) -> None:
        self._spool_path = Path(path)
        self._pin_released = False
        if not pin_owned:
            _pin_spool_path(self._spool_path)
        try:
            super().__init__(
                path,
                media_type=content_type,
                headers={"Accept-Ranges": "bytes"},
            )
        except BaseException:
            self._release_pin()
            raise

    def _release_pin(self) -> None:
        if self._pin_released:
            return
        self._pin_released = True
        _unpin_spool_path(self._spool_path)

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._release_pin()


class _LeaseStreamingResponse(StreamingResponse):
    """Release a growing-spool lease even when ASGI sending is interrupted."""

    def __init__(
        self,
        content: AsyncIterator[bytes],
        content_type: str,
        lease: _SpoolLease,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._lease = lease
        super().__init__(
            content,
            media_type=content_type,
            status_code=status_code,
            headers={"Accept-Ranges": "bytes", "Cache-Control": "no-store", **(headers or {})},
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._lease.close()


def _validate_video_id(video_id: str) -> str:
    """Reject video ids that are not exactly 11 URL-safe characters."""
    if not _VIDEO_ID_RE.fullmatch(video_id or ""):
        raise HTTPException(status_code=400, detail="Invalid video_id")
    return video_id


def _validate_stream_quality(quality: str) -> str:
    """Normalize and validate a requested stream quality."""
    normalized = (quality or "").strip().upper()
    if normalized not in _ALLOWED_STREAM_QUALITIES:
        raise HTTPException(status_code=400, detail="Invalid quality")
    return normalized


def _is_permanently_unavailable_error(error_message: str) -> bool:
    """Return whether yt-dlp identified a permanently unusable video identity.

    Patterns require video/content/account context so format-selection and
    extractor availability errors remain transient 5xx failures.
    """
    return any(pattern.search(error_message) for pattern in _PERMANENT_UNAVAILABLE_PATTERNS)


def _is_provider_challenge_error(error_message: str) -> bool:
    """Detect YouTube's temporary anonymous-client verification challenge."""
    normalized = error_message.lower()
    return "sign in to confirm you" in normalized and "not a bot" in normalized


def _provider_challenge_http_error(video_id: str, retry_after: int) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "error": "provider_challenge",
            "message": "YouTube Music temporarily requires verification. Retry later.",
            "video_id": video_id,
        },
        headers={"Retry-After": str(retry_after)},
    )


def _arm_provider_challenge_cooldown() -> int:
    """Arm one process-wide cooldown and return its rounded retry delay."""
    global _provider_challenge_cooldown_until
    now = time.monotonic()
    with _provider_challenge_lock:
        _provider_challenge_cooldown_until = max(
            _provider_challenge_cooldown_until,
            now + _PROVIDER_CHALLENGE_COOLDOWN_SECONDS,
        )
        return max(1, int(_provider_challenge_cooldown_until - now + 0.999))


def _raise_if_provider_challenge_cooldown(video_id: str) -> None:
    """Avoid hammering YouTube while its verification challenge is active."""
    now = time.monotonic()
    with _provider_challenge_lock:
        remaining = _provider_challenge_cooldown_until - now
    if remaining > 0:
        raise _provider_challenge_http_error(video_id, max(1, int(remaining + 0.999)))


def _stream_extraction_http_error(
    video_id: str, error_label: str, error: Exception
) -> HTTPException:
    """Convert an extraction failure to the existing sanitized HTTP error."""
    error_str = str(error)
    age_restricted = "Sign in to confirm your age" in error_str or (
        "age" in error_str.lower() and "confirm" in error_str.lower()
    )
    if age_restricted:
        log.error(
            "%s failed: %s",
            error_label,
            error,
            exc_info=True,  # noqa: LOG014 -- called while handling the extraction exception
        )
        return HTTPException(
            status_code=451,
            detail={
                "error": "age_restricted",
                "message": "This content requires age verification and cannot be streamed.",
                "video_id": video_id,
            },
        )
    if _is_provider_challenge_error(error_str):
        retry_after = _arm_provider_challenge_cooldown()
        log.warning(
            "%s hit YouTube provider challenge; extraction paused for %ss",
            error_label,
            retry_after,
        )
        return _provider_challenge_http_error(video_id, retry_after)
    if _is_permanently_unavailable_error(error_str):
        log.error(
            "%s failed: %s",
            error_label,
            error,
            exc_info=True,  # noqa: LOG014 -- called while handling the extraction exception
        )
        return HTTPException(
            status_code=404,
            detail={
                "error": "content_unavailable",
                "message": "This content is unavailable and cannot be streamed.",
                "video_id": video_id,
            },
        )
    return _sanitized_http_error(error_label, error, 502, "Failed to extract stream")


def _selected_audio_stream(info: JsonObject) -> JsonObject | None:
    """Keep a selected URL paired with its protocol, container, and codec."""
    if info.get("url"):
        return info
    audio_formats = [
        item
        for item in info.get("formats", [])
        if item.get("acodec") != "none" and item.get("vcodec") in ("none", None)
    ]
    audio_formats.sort(key=lambda item: item.get("abr", 0) or 0, reverse=True)
    return cast(JsonObject, audio_formats[0]) if audio_formats else None


def _best_audio_stream_url(info: JsonObject) -> str | None:
    """Return the direct URL or the highest-bitrate audio-only format URL."""
    selected = _selected_audio_stream(info)
    return cast(str, selected.get("url")) if selected and selected.get("url") else None


def _extract_stream_info(
    cache_key: str,
    url: str,
    ydl_opts: JsonObject,
    video_id: str,
    error_label: str,
) -> JsonObject:
    """Extract a yt-dlp audio URL through the shared paced cache workflow.

    Performs cache lookup, paced extraction, result construction, cache store,
    and sanitized error mapping for both YouTube stream paths.
    """
    import yt_dlp

    with _stream_cache_lock:
        cached = _stream_cache.get(cache_key)
    if cached and cached.get("expires_at", 0) > time.time():
        log.debug(f"Stream URL cache hit for {cache_key}")
        return cached
    _raise_if_provider_challenge_cooldown(video_id)
    _extract_pacer.wait()
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                raise ValueError("No info extracted")
            selected = _selected_audio_stream(cast(JsonObject, info))
            if selected is None or not selected.get("url"):
                raise ValueError("No audio stream URL found")
            result = {
                "url": selected["url"],
                "content_type": selected.get("audio_ext")
                or selected.get("ext")
                or info.get("audio_ext", "m4a"),
                "duration": info.get("duration", 0),
                "title": info.get("title", ""),
                "artist": info.get("artist") or info.get("uploader", ""),
                "expires_at": time.time() + STREAM_CACHE_TTL,
                "abr": selected.get("abr", info.get("abr", 0)),
                "acodec": selected.get("acodec", info.get("acodec", "")),
                "protocol": selected.get("protocol", ""),
                "ext": selected.get("ext") or selected.get("audio_ext", ""),
            }
            with _stream_cache_lock:
                _stream_cache[cache_key] = result
                expired_count = _clean_stream_cache_locked()
                _bound_cache(_stream_cache, STREAM_CACHE_MAX)
            if expired_count:
                log.debug(f"Cleaned {expired_count} expired stream cache entries")
            log.debug(
                "Extracted stream URL for %s: %s @ %skbps",
                cache_key,
                result["acodec"],
                result["abr"],
            )
            return result
    except Exception as error:
        raise _stream_extraction_http_error(video_id, error_label, error) from error


def _music_stream_cache_key(video_id: str, quality: str) -> str:
    """Build the anonymous music-stream cache identity."""
    return f"music:{video_id}:{quality}"


def _cached_music_info(video_id: str, quality: str) -> JsonObject | None:
    """Read anonymous music metadata without starting provider work."""
    with _stream_cache_lock:
        cached = _stream_cache.get(_music_stream_cache_key(video_id, quality))
        return cached if cached and cached.get("expires_at", 0) > time.time() else None


def _invalidate_music_stream_url(video_id: str, quality: str, failed_url: str) -> bool:
    """Remove only the rejected URL, preserving a concurrent cache refresh."""
    cache_key = _music_stream_cache_key(video_id, quality)
    with _stream_cache_lock:
        cached = _stream_cache.get(cache_key)
        if cached is None or cached.get("url") != failed_url:
            return False
        del _stream_cache[cache_key]
        return True


def _cache_spool_info(video_id: str, quality: str, info: JsonObject) -> None:
    """Reuse the completed download's small metadata, not its full format table."""
    selected = _selected_audio_stream(info) or {}
    result = {
        "url": selected.get("url") or "",
        "content_type": selected.get("audio_ext")
        or selected.get("ext")
        or info.get("audio_ext")
        or info.get("ext", "m4a"),
        "duration": info.get("duration", 0),
        "expires_at": time.time() + STREAM_CACHE_TTL,
        "abr": selected.get("abr") or info.get("abr") or 0,
        "acodec": selected.get("acodec") or info.get("acodec") or "",
        "protocol": selected.get("protocol") or "",
        "ext": selected.get("ext") or selected.get("audio_ext") or "",
    }
    with _stream_cache_lock:
        _stream_cache[_music_stream_cache_key(video_id, quality)] = result
        _clean_stream_cache_locked()
        _bound_cache(_stream_cache, STREAM_CACHE_MAX)


def _get_yt_stream_url_sync(video_id: str, quality: str = "HIGH") -> JsonObject:
    """Extract a cached audio stream URL for a regular YouTube video."""
    fmt = PROXY_AUDIO_FORMAT_SELECTORS.get(quality, PROXY_AUDIO_FORMAT_SELECTORS["HIGH"])
    ydl_opts = {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {"youtube": {"player_client": YT_PLAYER_CLIENTS}},
    }
    return _extract_stream_info(
        f"yt:{video_id}:{quality}",
        f"https://www.youtube.com/watch?v={video_id}",
        ydl_opts,
        video_id,
        f"yt-dlp extraction for YT video {video_id}",
    )


def _build_ytmusic_stream_options(quality: str) -> JsonObject:
    """Build resilient options for an immediately playable music stream.

    Anonymous YouTube clients occasionally expose only a low-resolution
    combined A/V rendition. Audio-only remains preferred, while the bounded
    360p fallback keeps playback available during those provider transitions.
    """
    format_map = {
        "LOW": "ba[abr<=64]/worstaudio/ba/b[height<=360]/b",
        "MEDIUM": "ba[abr<=128]/ba[abr<=192]/ba/b[height<=360]/b",
        "HIGH": "ba[abr<=256]/ba/b[height<=360]/b",
        "LOSSLESS": "ba/bestaudio/b[height<=360]/b",
    }
    fmt = format_map.get(quality, format_map["HIGH"])
    return {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://music.youtube.com/",
        },
        "extractor_args": {"youtube": {"player_client": _YTMUSIC_PLAYER_CLIENTS}},
    }


def _get_stream_url_sync(user_id: str, video_id: str, quality: str = "HIGH") -> JsonObject:
    """Extract a cached audio stream URL for a YouTube Music video."""
    ydl_opts = _build_ytmusic_stream_options(quality)
    return _extract_stream_info(
        _music_stream_cache_key(video_id, quality),
        f"https://music.youtube.com/watch?v={video_id}",
        ydl_opts,
        video_id,
        f"yt-dlp extraction for {video_id}",
    )


async def _extract_yt_dlp_bounded(
    func: Callable[..., JsonObject], *args: Any, timeout_detail: str
) -> JsonObject:
    """Run sync yt-dlp work in its bounded pool with an overall deadline.

    Timed-out worker threads remain confined to the dedicated executor, and
    yt-dlp's socket_timeout bounds their network operations.
    """
    if not _metadata_admission.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="YouTube metadata queue is full")
    cancelled = threading.Event()
    try:
        worker = _yt_dlp_extract_executor.submit(
            _extraction_budget.run,
            partial(func, *args),
            cancel_event=cancelled,
            deadline=time.monotonic() + EXTRACT_TIMEOUT,
        )
    except BaseException:
        _metadata_admission.release()
        raise
    # Admission and heavy-work slots belong to the worker, not its HTTP waiter.
    worker.add_done_callback(lambda _done: _metadata_admission.release())
    try:
        return await asyncio.wait_for(asyncio.wrap_future(worker), timeout=EXTRACT_TIMEOUT)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail=timeout_detail) from error
    except ExtractionAbandoned as error:
        raise HTTPException(status_code=504, detail=timeout_detail) from error
    finally:
        cancelled.set()


async def _extract_stream_info_bounded(func: Callable[..., JsonObject], *args: Any) -> JsonObject:
    """Run a sync stream extraction through the shared yt-dlp bounds."""
    return await _extract_yt_dlp_bounded(
        func,
        *args,
        timeout_detail="Stream extraction timed out",
    )


async def _browse_public_bounded(func: Callable[..., T], *args: Any) -> T:
    """Run a sync public ytmusicapi browse call off the event loop with an overall deadline.

    asyncio.wait_for cancels the awaiting request after BROWSE_TIMEOUT seconds
    and maps it to HTTP 504. The orphaned worker thread is not force-killed,
    but the event loop and the client are unblocked.
    """
    try:
        return await asyncio.wait_for(asyncio.to_thread(func, *args), timeout=BROWSE_TIMEOUT)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail="YouTube Music request timed out") from error


_YTMUSIC_MAX_ABR = {
    "LOW": 64,
    "MEDIUM": 128,
    "HIGH": 256,
    "LOSSLESS": None,
}


def _build_ytmusic_spool_format(quality: str, max_bytes: int) -> str:
    """Prefer the best audio format that can complete inside the spool cap.

    yt-dlp often exposes both a large HLS rendition and smaller progressive
    audio for long ambient titles. The completed file is served locally, so a
    bounded progressive rendition is safe here even though its signed URL
    would not be safe to expose directly to a range-reading browser.
    """
    max_abr = _YTMUSIC_MAX_ABR.get(quality, _YTMUSIC_MAX_ABR["HIGH"])
    abr_filter = f"[abr<={max_abr}]" if max_abr is not None else ""
    # yt-dlp's numeric filters are strict. Add one byte so a file exactly at
    # the configured limit remains eligible, matching the progress hook.
    exclusive_limit = max_bytes + 1
    candidates = []
    # Progressive audio is normally faster and less fragile than downloading
    # many HLS fragments. HLS remains available when it is the only rendition.
    for protocol_filter in ("", "[protocol=m3u8_native]", "[protocol=m3u8]"):
        for size_field in ("filesize", "filesize_approx"):
            candidates.append(f"ba{protocol_filter}{abr_filter}[{size_field}<{exclusive_limit}]")
    # If upstream omits all size estimates, choose the smallest audio stream;
    # the progress hook still enforces the hard byte limit while downloading.
    candidates.append("wa")
    for size_field in ("filesize", "filesize_approx"):
        candidates.append(f"b[height<=360][{size_field}<{exclusive_limit}]")
    candidates.append("b[height<=360]")
    return "/".join(candidates)


def _progressive_source(info: JsonObject) -> tuple[str, str, str] | None:
    """Return a direct, append-only source that Soundspan can own safely."""
    stream_url = info.get("url")
    protocol = str(info.get("protocol") or "").lower()
    extension = str(info.get("ext") or info.get("content_type") or "").lower().lstrip(".")
    if not isinstance(stream_url, str) or not stream_url:
        return None
    if protocol not in {"http", "https"} or urlsplit(stream_url).scheme.lower() != protocol:
        return None
    if extension not in {"m4a", "mp4", "webm"}:
        return None
    content_type = "audio/webm" if extension == "webm" else "audio/mp4"
    return stream_url, extension, content_type


@dataclass(frozen=True, slots=True)
class _ProgressiveSpoolPlan:
    """Small resolved handoff from scarce provider work to bounded CDN I/O."""

    stream_url: str
    extension: str
    content_type: str
    info: JsonObject


class _ProgressiveSourceRefreshRequired(Exception):
    """Signal one rejected direct URL without exposing its signed query string."""

    def __init__(self, stream_url: str, status_code: int) -> None:
        super().__init__(f"Progressive source rejected direct URL with HTTP {status_code}")
        self.stream_url = stream_url
        self.status_code = status_code


def _resolve_progressive_spool_plan_sync(
    video_id: str,
    quality: str,
    session: _SpoolSession,
) -> _ProgressiveSpoolPlan | None:
    """Resolve a direct source without keeping its later byte transfer in this lane."""
    if session.cancel_event.is_set():
        raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
    info = _get_stream_url_sync("__public__", video_id, quality)
    if session.cancel_event.is_set():
        raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
    source = _progressive_source(info)
    if source is None:
        return None
    stream_url, extension, content_type = source
    return _ProgressiveSpoolPlan(stream_url, extension, content_type, info)


def _progressive_prefix_state(
    prefix: bytes,
    extension: str,
) -> Literal["pending", "readable", "rejected"]:
    """Prove whether a bounded prefix can start browser decoding safely."""
    if prefix.startswith(b"#EXTM3U"):
        return "rejected"
    if extension == "webm":
        if len(prefix) >= 4 and not prefix.startswith(b"\x1aE\xdf\xa3"):
            return "rejected"
        if prefix.startswith(b"\x1aE\xdf\xa3") and b"\x1fC\xb6u" in prefix:
            return "readable"
        return "pending"
    if extension not in {"m4a", "mp4"}:
        return "rejected"

    offset = 0
    saw_ftyp = False
    saw_moov = False
    while offset + 8 <= len(prefix):
        size = int.from_bytes(prefix[offset : offset + 4], "big")
        kind = prefix[offset + 4 : offset + 8]
        header_size = 8
        if size == 1:
            if offset + 16 > len(prefix):
                return "pending"
            size = int.from_bytes(prefix[offset + 8 : offset + 16], "big")
            header_size = 16
        if offset == 0 and kind != b"ftyp":
            return "rejected"
        if size != 0 and size < header_size:
            return "rejected"
        if kind == b"mdat":
            return "readable" if saw_ftyp and saw_moov else "rejected"
        if size == 0:
            return "rejected"
        box_end = offset + size
        if box_end > len(prefix):
            return "pending"
        if kind == b"ftyp":
            saw_ftyp = True
        elif kind == b"moov":
            saw_moov = True
        offset = box_end
    return "pending"


def _progressive_partial_path(video_id: str, quality: str, extension: str) -> Path:
    """Build the private filename for Soundspan's append-only writer."""
    return YTMUSIC_SPOOL_DIR / f"{video_id}-{quality}.{extension}{_SOUNDSPAN_PART_SUFFIX}"


def _replace_completed_spool(
    partial_path: Path,
    completed_path: Path,
    cancel_event: threading.Event,
) -> None:
    """Atomically publish a spool, tolerating a brief Windows reader collision."""
    for attempt in range(_SPOOL_RENAME_MAX_ATTEMPTS):
        try:
            os.replace(partial_path, completed_path)
            return
        except PermissionError:
            if attempt + 1 == _SPOOL_RENAME_MAX_ATTEMPTS:
                raise
            if cancel_event.is_set():
                raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
            time.sleep(_SPOOL_RENAME_RETRY_SECONDS)


def _iter_progressive_cdn_chunks(
    stream_url: str,
    headers: dict[str, str],
    session: _SpoolSession,
    byte_limit: int,
    started_at: float,
) -> Iterator[tuple[bytes, int | None]]:
    """Read contiguous bounded CDN ranges under one transfer/cancellation budget.

    Some CDN renditions pace an unbounded GET near playback speed. Bounded
    ranges fill the shared spool promptly without changing the audio format.
    An upstream ignoring Range is accepted only for the initial full response.
    """
    offset = 0
    total: int | None = None
    validator: str | None = None
    while total is None or offset < total:
        if session.cancel_event.is_set():
            raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
        remaining = YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT - (time.monotonic() - started_at)
        if remaining <= 0:
            raise RuntimeError("YouTube Music spool download timeout exceeded")
        end = min(offset + _SPOOL_CDN_RANGE_BYTES, total or byte_limit) - 1
        range_headers = {**headers, "Range": f"bytes={offset}-{end}"}
        if validator is not None:
            range_headers["If-Range"] = validator
        timeout = min(YTDLP_SOCKET_TIMEOUT, remaining)
        with requests.get(
            stream_url, headers=range_headers, stream=True, timeout=(timeout, timeout)
        ) as response:
            try:
                response.raise_for_status()
            except requests.HTTPError as error:
                # Restarting from zero after publishing bytes could corrupt readers.
                if response.status_code in _PROGRESSIVE_SOURCE_REFRESH_STATUSES and offset == 0:
                    raise _ProgressiveSourceRefreshRequired(
                        stream_url, response.status_code
                    ) from error
                raise
            if response.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
                raise ValueError("Progressive source unexpectedly used content encoding")
            declared = response.headers.get("Content-Length")
            length = int(declared) if declared is not None else None
            expected: int | None
            if response.status_code == 206:
                match = re.fullmatch(
                    r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", "")
                )
                if match is None:
                    raise ValueError("Progressive source returned an invalid content range")
                first, last, represented_total = map(int, match.groups())
                if (
                    first != offset
                    or last != min(end, represented_total - 1)
                    or last < first
                    or (total is not None and represented_total != total)
                ):
                    raise ValueError("Progressive source changed or skipped a byte range")
                expected = last - first + 1
                if length is not None and length != expected:
                    raise ValueError("Progressive range did not match its content length")
                total = represented_total
            elif response.status_code == 200 and offset == 0:
                total = length
                expected = length
            else:
                raise ValueError("Progressive source did not honor a continuation range")
            if total is not None and (total <= 0 or total > byte_limit):
                raise ValueError("Progressive source returned an invalid total length")
            current_validator = response.headers.get("ETag")
            if validator is not None and current_validator != validator:
                raise ValueError("Progressive source changed its representation")
            if current_validator and not current_validator.startswith("W/"):
                validator = current_validator
            received = 0
            for chunk in response.iter_content(chunk_size=_SPOOL_READ_CHUNK_BYTES):
                if not chunk:
                    continue
                if session.cancel_event.is_set():
                    raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
                if time.monotonic() - started_at > YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT:
                    raise RuntimeError("YouTube Music spool download timeout exceeded")
                received += len(chunk)
                if (expected is not None and received > expected) or offset + len(
                    chunk
                ) > byte_limit:
                    raise ValueError("Progressive source exceeded its declared byte range")
                yield chunk, total
                offset += len(chunk)
            if received == 0 or (expected is not None and received != expected):
                raise ValueError("Progressive source returned an incomplete byte range")
            if response.status_code == 200:
                return


def _download_progressive_spool_sync(
    video_id: str,
    quality: str,
    session: _SpoolSession,
    plan: _ProgressiveSpoolPlan | None = None,
) -> tuple[str, str, JsonObject] | None:
    """Download a proven direct source into a Soundspan-owned append-only file."""
    if plan is None:
        plan = _resolve_progressive_spool_plan_sync(video_id, quality, session)
    if plan is None:
        return None
    if session.cancel_event.is_set():
        raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
    stream_url = plan.stream_url
    extension = plan.extension
    content_type = plan.content_type
    partial_path = _progressive_partial_path(video_id, quality, extension)
    completed_path = YTMUSIC_SPOOL_DIR / f"{video_id}-{quality}.{extension}"
    with suppress(FileNotFoundError):
        partial_path.unlink()
    session.pin_path(partial_path)
    started_at = time.monotonic()
    byte_limit = _spool_track_byte_limit()
    prefix = bytearray()
    prefix_state: Literal["pending", "readable", "rejected"] = "pending"
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": "https://music.youtube.com/",
    }
    downloaded = 0
    total_bytes: int | None = None
    with partial_path.open("wb", buffering=0) as spool:
        for chunk, total_bytes in _iter_progressive_cdn_chunks(
            stream_url, headers, session, byte_limit, started_at
        ):
            downloaded += len(chunk)
            spool.write(chunk)
            if prefix_state == "pending":
                remaining = _SPOOL_PREFIX_PROBE_BYTES - len(prefix)
                if remaining > 0:
                    prefix.extend(chunk[:remaining])
                prefix_state = _progressive_prefix_state(bytes(prefix), extension)
                if prefix_state == "pending" and len(prefix) >= _SPOOL_PREFIX_PROBE_BYTES:
                    prefix_state = "rejected"
                if prefix_state == "readable":
                    session.publish_readable_from_worker(partial_path, content_type, total_bytes)
            if prefix_state == "readable":
                session.publish_growth_from_worker()

    if downloaded == 0:
        raise ValueError("Progressive source returned an empty body")
    if total_bytes is not None and downloaded != total_bytes:
        raise ValueError("Progressive source did not match its content length")
    if session.cancel_event.is_set():
        raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
    session.pin_path(completed_path)
    _replace_completed_spool(partial_path, completed_path, session.cancel_event)
    session.publish_growth_from_worker()
    return str(completed_path), content_type, plan.info


def _materialize_progressive_spool_sync(
    video_id: str,
    quality: str,
    session: _SpoolSession,
    plan: _ProgressiveSpoolPlan | None,
) -> tuple[str, str] | None:
    """Own aggregate disk capacity while materializing one progressive plan."""
    with _spool_byte_reservation():
        progressive = _download_progressive_spool_sync(video_id, quality, session, plan)
        if progressive is None:
            return None
        path, content_type, info = progressive
        progressive_completed = Path(path)
        completed_size = progressive_completed.stat().st_size
        _prune_spool(exclude=progressive_completed)
        _cache_spool_info(video_id, quality, info)
        log.info(
            "Spooled progressive YouTube Music track %s (%s, %.1f MiB)",
            video_id,
            quality,
            completed_size / (1024 * 1024),
        )
        return path, content_type


def _spool_candidates(video_id: str, quality: str) -> list[Path]:
    """Return completed spool files for one track, newest first."""
    if not YTMUSIC_SPOOL_DIR.exists():
        return []
    prefix = f"{video_id}-{quality}."
    candidates: list[tuple[float, Path]] = []
    for path in YTMUSIC_SPOOL_DIR.iterdir():
        if (
            not path.name.startswith(prefix)
            or ".part" in path.name
            or path.name.endswith(".ytdl")
            or path.name.endswith(_SOUNDSPAN_PART_SUFFIX)
            or not path.is_file()
        ):
            continue
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        if stat.st_size > 0:
            candidates.append((stat.st_mtime, path))
    return [path for _, path in sorted(candidates, reverse=True)]


def _require_spool_worker_thread() -> None:
    """Reject spool filesystem lookup from an event-loop thread."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError("Spool filesystem lookup must run off the event loop")


def _find_spooled_file(video_id: str, quality: str, *, pin: bool = False) -> Path | None:
    """Return and touch a valid spool entry from a worker thread.

    The prune lock makes the candidate snapshot and touch atomic with eviction.
    Neither this lookup nor ``_prune_spool`` calls the other while holding it.
    """
    _require_spool_worker_thread()
    with _spool_prune_lock:
        for path in _spool_candidates(video_id, quality):
            try:
                if path.stat().st_size > 0:
                    os.utime(path, None)
                    if pin:
                        _pin_spool_path_locked(path)
                    return path
            except FileNotFoundError:
                continue
    return None


def _spool_content_type(path: Path) -> str:
    """Map the downloaded container to a browser audio content type."""
    if path.suffix.lower() in {".mp4", ".m4a", ".aac"}:
        return "audio/mp4"
    if path.suffix.lower() in {".webm", ".opus"}:
        return "audio/webm"
    return "application/octet-stream"


def _collect_spool_entries() -> tuple[int, list[tuple[float, int, Path]]]:
    """Sweep stale partials and collect completed files for budget accounting."""
    entries: list[tuple[float, int, Path]] = []
    total = 0
    now = time.time()
    for path in YTMUSIC_SPOOL_DIR.iterdir():
        if not path.is_file() or not _SPOOL_OWNED_NAME_RE.match(path.name):
            continue
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        is_partial = (
            ".part" in path.name
            or path.name.endswith(".ytdl")
            or path.name.endswith(_SOUNDSPAN_PART_SUFFIX)
        )
        if is_partial:
            if (
                path not in _spool_pinned_paths
                and now - stat.st_mtime > _SPOOL_PARTIAL_STALE_SECONDS
            ):
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue
                log.debug("Removed stale YouTube Music spool partial %s", path.name)
            continue
        total += stat.st_size
        entries.append((stat.st_mtime, stat.st_size, path))
    return total, entries


def _spool_track_byte_limit() -> int:
    """Keep every individual writer inside both the track and aggregate caps."""
    return max(1, min(YTMUSIC_SPOOL_TRACK_MAX_BYTES, YTMUSIC_SPOOL_MAX_BYTES))


def _reserve_spool_bytes() -> int:
    """Reserve worst-case bytes for one active writer, evicting only unpinned files."""
    global _spool_reserved_bytes

    reserved = _spool_track_byte_limit()
    YTMUSIC_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    with _spool_prune_lock:
        total, entries = _collect_spool_entries()
        for _modified_at, size, path in sorted(entries):
            if total + _spool_reserved_bytes + reserved <= YTMUSIC_SPOOL_MAX_BYTES:
                break
            if path in _spool_pinned_paths:
                continue
            try:
                path.unlink()
                total -= size
                log.debug("Evicted YouTube Music spool file %s for writer capacity", path.name)
            except FileNotFoundError:
                continue
        if total + _spool_reserved_bytes + reserved > YTMUSIC_SPOOL_MAX_BYTES:
            raise HTTPException(status_code=503, detail="YouTube Music spool byte capacity is full")
        _spool_reserved_bytes += reserved
    return reserved


def _release_spool_bytes(reserved: int) -> None:
    """Release one active writer's aggregate byte reservation."""
    global _spool_reserved_bytes

    with _spool_prune_lock:
        _spool_reserved_bytes = max(0, _spool_reserved_bytes - reserved)


@contextmanager
def _spool_byte_reservation() -> Iterator[int]:
    """Own one active writer's disk allowance through success or failure."""
    reserved = _reserve_spool_bytes()
    try:
        yield reserved
    finally:
        _release_spool_bytes(reserved)


def _prune_spool(exclude: Path | None = None) -> None:
    """Sweep stale partials and evict completed files to the disk budget."""
    with _spool_prune_lock:
        if not YTMUSIC_SPOOL_DIR.exists():
            return

        total, entries = _collect_spool_entries()
        now = time.time()
        for modified_at, size, path in sorted(entries):
            if total <= YTMUSIC_SPOOL_MAX_BYTES:
                break
            if exclude is not None and path == exclude:
                continue
            if path in _spool_pinned_paths:
                continue
            # Young files may transiently push the spool over budget while a
            # completed download is about to be served or was just cache-hit.
            if now - modified_at < _SPOOL_EVICT_MIN_AGE_SECONDS:
                continue
            try:
                path.unlink()
                total -= size
                log.debug("Evicted YouTube Music spool file %s", path.name)
            except FileNotFoundError:
                continue


def _build_spool_progress_hook(
    started_at: float,
    cancel_event: threading.Event | None = None,
) -> Callable[[JsonObject], None]:
    """Build a yt-dlp hook that enforces download-progress limits.

    The elapsed deadline covers the download phase and is checked only at
    progress events. ``socket_timeout`` bounds individual stalled reads during
    extraction and download.
    """

    def enforce_spool_limits(status: JsonObject) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
        downloaded_bytes = status.get("downloaded_bytes", 0)
        byte_limit = _spool_track_byte_limit()
        if isinstance(downloaded_bytes, int) and downloaded_bytes > byte_limit:
            raise RuntimeError(
                f"YouTube Music spool downloaded bytes exceeded {byte_limit} byte limit"
            )
        if time.monotonic() - started_at > YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT:
            raise RuntimeError(
                "YouTube Music spool download timeout exceeded "
                f"{YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT:g} seconds"
            )

    return enforce_spool_limits


def _build_ytmusic_spool_options(
    video_id: str,
    quality: str,
    *,
    match_filter: Callable[..., str | None],
    progress_hook: Callable[[JsonObject], None],
) -> JsonObject:
    """Build yt-dlp options for one validated spool request."""
    fmt = _build_ytmusic_spool_format(quality, _spool_track_byte_limit())
    outtmpl = str(YTMUSIC_SPOOL_DIR / f"{video_id}-{quality}.%(ext)s")
    return {
        "format": fmt,
        "outtmpl": outtmpl,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "noplaylist": True,
        "concurrent_fragment_downloads": _SPOOL_FRAGMENT_CONCURRENCY,
        "match_filter": match_filter,
        "progress_hooks": [progress_hook],
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://music.youtube.com/",
        },
        "extractor_args": {
            "youtube": {
                "player_client": _YTMUSIC_PLAYER_CLIENTS,
            },
        },
        "js_runtimes": {"deno": {}},
    }


def _remove_failed_spool_partials(video_id: str, quality: str) -> None:
    """Remove yt-dlp partials for one failed single-flight download."""
    if not YTMUSIC_SPOOL_DIR.exists():
        return
    prefix = f"{video_id}-{quality}."
    for path in YTMUSIC_SPOOL_DIR.iterdir():
        is_partial = (
            ".part" in path.name
            or path.name.endswith(".ytdl")
            or path.name.endswith(_SOUNDSPAN_PART_SUFFIX)
        )
        if path.name.startswith(prefix) and is_partial:
            # A growing response may briefly have the file open on Windows. It is
            # already unpinned after the final lease and stale-prune can retry.
            with suppress(OSError):
                path.unlink()


def _extract_spool_with_retry(
    video_id: str, options: JsonObject, cancel_event: threading.Event | None
) -> JsonObject:
    """Retry a transient missing-format table once within the same worker slot."""
    import yt_dlp

    for attempt in range(2):
        if cancel_event is not None and cancel_event.is_set():
            raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(
                    f"https://music.youtube.com/watch?v={video_id}", download=True
                )
            if not info:
                raise ValueError("No info extracted while spooling stream")
            return cast(JsonObject, info)
        except yt_dlp.utils.DownloadError as error:
            if attempt or "requested format is not available" not in str(error).lower():
                raise
            log.warning("Retrying transient YouTube format extraction for %s", video_id)
            _extract_pacer.wait()
    raise RuntimeError("Unreachable spool retry state")


def _download_ytmusic_spool_sync(
    video_id: str,
    quality: str,
    *,
    progressive_plan: _ProgressiveSpoolPlan | None = None,
    progressive_only: bool = False,
) -> tuple[str, str]:
    """Download a complete YouTube Music stream into the bounded spool."""
    import yt_dlp

    YTMUSIC_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    _prune_spool()

    existing = _find_spooled_file(video_id, quality)
    if existing is not None:
        return str(existing), _spool_content_type(existing)

    _raise_if_provider_challenge_cooldown(video_id)

    started_at = time.monotonic()
    cancel_event = _spool_cancel_events.get(f"{video_id}:{quality}")
    try:
        session = cast(_SpoolSession | None, getattr(_spool_worker_context, "session", None))
        if session is not None:
            progressive = _materialize_progressive_spool_sync(
                video_id,
                quality,
                session,
                progressive_plan,
            )
            if progressive is not None:
                return progressive
        if progressive_only:
            raise RuntimeError("Resolved progressive source did not produce a spool")
        ydl_opts = _build_ytmusic_spool_options(
            video_id,
            quality,
            match_filter=yt_dlp.utils.match_filter_func("!is_live"),
            progress_hook=_build_spool_progress_hook(started_at, cancel_event),
        )
        with _spool_byte_reservation():
            info = _extract_spool_with_retry(video_id, ydl_opts, cancel_event)

            completed = _find_spooled_file(video_id, quality)
            if completed is None:
                raise ValueError("yt-dlp completed without a spool file")
            completed_size = completed.stat().st_size
            if completed_size > _spool_track_byte_limit():
                with suppress(FileNotFoundError):
                    completed.unlink()
                raise ValueError("YouTube Music spool file exceeds the total spool byte budget")

            _prune_spool(exclude=completed)
            _cache_spool_info(video_id, quality, info)
            log.info(
                "Spooled YouTube Music track %s (%s, %.1f MiB)",
                video_id,
                quality,
                completed_size / (1024 * 1024),
            )
            return str(completed), _spool_content_type(completed)
    except _SpoolDownloadCancelled:
        _remove_failed_spool_partials(video_id, quality)
        log.info("Cancelled abandoned YouTube Music spool for %s", video_id)
        raise
    except _ProgressiveSourceRefreshRequired:
        _remove_failed_spool_partials(video_id, quality)
        raise
    except HTTPException:
        _remove_failed_spool_partials(video_id, quality)
        raise
    except Exception as error:
        # yt-dlp normally cleans these itself; remove leftovers after failures.
        _remove_failed_spool_partials(video_id, quality)
        raise _stream_extraction_http_error(
            video_id,
            f"yt-dlp spool for {video_id}",
            error,
        ) from error


def _run_spool_download_sync(
    video_id: str,
    quality: str,
    session: _SpoolSession | None,
    progressive_plan: _ProgressiveSpoolPlan | None = None,
    progressive_only: bool = False,
) -> tuple[str, str]:
    """Bind one event-loop session to its executor thread without changing writers."""
    _spool_worker_context.session = session
    try:
        if progressive_plan is not None or progressive_only:
            return _download_ytmusic_spool_sync(
                video_id,
                quality,
                progressive_plan=progressive_plan,
                progressive_only=progressive_only,
            )
        return _download_ytmusic_spool_sync(video_id, quality)
    finally:
        with suppress(AttributeError):
            del _spool_worker_context.session


async def _download_ytmusic_spool_bounded(
    video_id: str,
    quality: str,
    *,
    playback: bool = True,
    session: _SpoolSession | None = None,
) -> tuple[str, str]:
    """Resolve in the scarce provider lane, then transfer in bounded CDN I/O."""
    loop = asyncio.get_running_loop()
    cancel_event = _spool_cancel_events.get(f"{video_id}:{quality}")
    priority = session.current_priority if session is not None else None

    def run_extraction(
        operation: Callable[[], tuple[str, str] | _ProgressiveSpoolPlan | None],
    ) -> Any:
        if priority is None:
            return _extraction_budget.run(
                operation,
                playback=playback,
                cancel_event=cancel_event,
            )
        return _extraction_budget.run(
            operation,
            cancel_event=cancel_event,
            priority=priority,
        )

    async def resolve_progressive_plan(
        active_session: _SpoolSession,
    ) -> _ProgressiveSpoolPlan | None:
        resolved = await loop.run_in_executor(
            _yt_dlp_spool_executor,
            partial(
                run_extraction,
                partial(
                    _resolve_progressive_spool_plan_sync,
                    video_id,
                    quality,
                    active_session,
                ),
            ),
        )
        return cast(_ProgressiveSpoolPlan | None, resolved)

    async def transfer_progressive_plan(
        active_session: _SpoolSession,
        plan: _ProgressiveSpoolPlan,
    ) -> tuple[str, str]:
        return await loop.run_in_executor(
            _spool_transfer_executor,
            partial(
                _spool_transfer_budget.run,
                partial(
                    _run_spool_download_sync,
                    video_id,
                    quality,
                    active_session,
                    plan,
                    True,
                ),
                cancel_event=cancel_event,
                priority=priority,
            ),
        )

    # yt-dlp's socket timeout bounds the executor thread between network reads.
    try:
        # Complete-file consumers also release extraction capacity before CDN
        # transfer. allow_growing controls publication, not the download lane.
        if session is not None:
            progressive_plan = await resolve_progressive_plan(session)
            if progressive_plan is not None:
                try:
                    return await transfer_progressive_plan(session, progressive_plan)
                except _ProgressiveSourceRefreshRequired as rejected:
                    _invalidate_music_stream_url(
                        video_id,
                        quality,
                        rejected.stream_url,
                    )
                    refreshed_plan = await resolve_progressive_plan(session)
                    if refreshed_plan is not None:
                        try:
                            return await transfer_progressive_plan(session, refreshed_plan)
                        except _ProgressiveSourceRefreshRequired as repeated:
                            _invalidate_music_stream_url(
                                video_id,
                                quality,
                                repeated.stream_url,
                            )
                            raise _stream_extraction_http_error(
                                video_id,
                                f"progressive spool for {video_id}",
                                repeated,
                            ) from repeated
        return await loop.run_in_executor(
            _yt_dlp_spool_executor,
            partial(
                run_extraction,
                partial(_run_spool_download_sync, video_id, quality, None),
            ),
        )
    except (ExtractionAbandoned, _SpoolDownloadCancelled) as error:
        raise HTTPException(status_code=499, detail="Client disconnected") from error


def _cleanup_spool_session_if_unused(session: _SpoolSession) -> None:
    """Drop one terminal session after its final response lease closes."""
    if session.lease_count or (session.task is not None and not session.task.done()):
        return
    if _spool_sessions.get(session.key) is session:
        _spool_sessions.pop(session.key, None)
    session.release_pins()


def _remove_completed_spool_task(
    key: str,
    task: asyncio.Task[tuple[str, str]],
    session: _SpoolSession,
) -> None:
    """Remove one completed single-flight task without disturbing a replacement."""
    global _spool_background_pending_jobs, _spool_pending_jobs

    if _spool_tasks.get(key) is task:
        _spool_tasks.pop(key, None)
        _spool_cancel_events.pop(key, None)
    if _spool_pending_jobs > 0:
        _spool_pending_jobs -= 1
    else:
        log.error("YouTube Music spool pending-job counter underflow")
    if session.background_admission:
        session.background_admission = False
        if _spool_background_pending_jobs > 0:
            _spool_background_pending_jobs -= 1
        else:
            log.error("YouTube Music spool background counter underflow")
    session.publish_growth()
    if task.cancelled():
        if session.partial_path is not None:
            with suppress(OSError):
                session.partial_path.unlink()
    else:
        # Observe failures when every waiter disconnected before completion.
        error = task.exception()
        if error is not None and session.partial_path is not None:
            with suppress(OSError):
                session.partial_path.unlink()
        if isinstance(error, HTTPException):
            for purpose, provider_identity in session.failure_scopes:
                _cache_spool_failure(
                    _spool_failure_key(
                        key.rsplit(":", 1)[0],
                        key.rsplit(":", 1)[1],
                        purpose,
                        provider_identity=provider_identity,
                    ),
                    error,
                )
        elif error is None and session.lease_count:
            completed_path, _content_type = task.result()
            session.pin_path(Path(completed_path))
        if error is None:
            video_id, quality = key.rsplit(":", 1)
            _clear_spool_failures(video_id, quality)
    _cleanup_spool_session_if_unused(session)


def _spool_has_admission(purpose: str) -> bool:
    """Reserve one pending-job slot for a current interactive request."""
    if not _spool_admitting or _spool_pending_jobs >= _SPOOL_MAX_PENDING_JOBS:
        return False
    return purpose == "interactive" or (
        _spool_background_pending_jobs < _SPOOL_MAX_BACKGROUND_PENDING_JOBS
    )


def _create_spool_task(
    key: str,
    video_id: str,
    quality: str,
    *,
    playback: bool = True,
    purpose: Literal["interactive", "preload", "analysis"] = "interactive",
    provider_identity: str = _SPOOL_PROVIDER_IDENTITY,
) -> asyncio.Task[tuple[str, str]]:
    """Create one bounded event-loop-owned spool task."""
    global _spool_background_pending_jobs, _spool_pending_jobs

    if not _spool_has_admission(purpose):
        raise HTTPException(status_code=503, detail="YouTube Music spool queue is full")
    cancel_event = threading.Event()
    _spool_cancel_events[key] = cancel_event
    session = _SpoolSession(
        key,
        asyncio.get_running_loop(),
        cancel_event,
        allow_growing=playback,
        priority=_spool_purpose_priority(purpose),
    )
    _spool_pending_jobs += 1
    if session.background_admission:
        _spool_background_pending_jobs += 1
    session.register_failure_scope(purpose, provider_identity)
    task = asyncio.create_task(
        _download_ytmusic_spool_bounded(
            video_id,
            quality,
            playback=playback,
            session=session,
        )
    )
    session.task = task
    _spool_sessions[key] = session
    _spool_tasks[key] = task
    task.add_done_callback(lambda completed: _remove_completed_spool_task(key, completed, session))
    return task


def _try_get_or_create_spool_task(
    key: str,
    video_id: str,
    quality: str,
    *,
    playback: bool = True,
    purpose: Literal["interactive", "preload", "analysis"] = "interactive",
    provider_identity: str = _SPOOL_PROVIDER_IDENTITY,
) -> asyncio.Task[tuple[str, str]] | None:
    """Join or create a task, or return None when the queue is full.

    The event loop owns this helper. It contains no await between the final map
    lookup, capacity check, and insertion performed by ``_create_spool_task``.
    """
    task = _spool_tasks.get(key)
    if task is not None:
        session = _spool_sessions.get(key)
        if session is not None:
            session.register_failure_scope(purpose, provider_identity)
        return task
    if not _spool_has_admission(purpose):
        return None
    return _create_spool_task(
        key,
        video_id,
        quality,
        playback=playback,
        purpose=purpose,
        provider_identity=provider_identity,
    )


def _spooled_file_result(path: Path) -> tuple[str, str]:
    """Return the transport result for one completed spool file."""
    return str(path), _spool_content_type(path)


async def _find_spooled_result(
    video_id: str,
    quality: str,
    *,
    pin: bool = False,
) -> tuple[str, str] | None:
    """Find a spool file off-loop, optionally transferring an atomic pin."""
    if pin:
        lookup = asyncio.create_task(
            asyncio.to_thread(
                _find_spooled_file,
                video_id,
                quality,
                pin=True,
            )
        )
        try:
            existing = await asyncio.shield(lookup)
        except asyncio.CancelledError:
            # The worker cannot be cancelled after it acquires the prune lock.
            # Reclaim any pin it returns after its abandoned waiter is gone.
            def release_abandoned_pin(completed: asyncio.Task[Path | None]) -> None:
                with suppress(BaseException):
                    abandoned = completed.result()
                    if abandoned is not None:
                        _unpin_spool_path(abandoned)

            lookup.add_done_callback(release_abandoned_pin)
            raise
    else:
        existing = await asyncio.to_thread(_find_spooled_file, video_id, quality)
    return _spooled_file_result(existing) if existing is not None else None


async def _await_spool_task(
    task: asyncio.Task[tuple[str, str]], *, deadline: float | None = None
) -> tuple[str, str]:
    """Await one shared spool task without allowing a waiter to cancel it."""
    try:
        timeout = YTMUSIC_SPOOL_TIMEOUT if deadline is None else max(0, deadline - time.monotonic())
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail="YouTube Music spool timed out") from error


async def _await_spool_task_for_request(
    key: str,
    task: asyncio.Future[tuple[str, str]],
    request: Request,
    *,
    pin_result: bool = False,
    deadline: float | None = None,
) -> tuple[str, str]:
    """Await a shared spool while cancelling work abandoned by every client."""
    cancel_event = _spool_cancel_events.get(key)
    lease = _SpoolLease(key, task, cancel_event, _spool_sessions.get(key))
    if deadline is None:
        deadline = time.monotonic() + YTMUSIC_SPOOL_TIMEOUT
    try:
        while not task.done():
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client disconnected")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="YouTube Music spool timed out")
            await asyncio.sleep(min(0.1, remaining))
        result = task.result()
        if pin_result:
            video_id, quality = key.rsplit(":", 1)
            pinned = await _find_spooled_result(video_id, quality, pin=True)
            if pinned is None:
                raise HTTPException(status_code=503, detail="YouTube Music spool file unavailable")
            return pinned
        return result
    finally:
        lease.close()


async def _find_or_start_spool_task(
    video_id: str,
    quality: str,
    *,
    purpose: Literal["interactive", "preload", "analysis"] = "interactive",
    provider_identity: str = _SPOOL_PROVIDER_IDENTITY,
    pin_completed: bool = False,
    request: Request | None = None,
    deadline: float | None = None,
) -> tuple[tuple[str, str] | None, asyncio.Task[tuple[str, str]] | None]:
    """Join live work, waiting for an abandoned writer to fully close before retry."""
    if deadline is None:
        deadline = time.monotonic() + YTMUSIC_SPOOL_TIMEOUT
    key = f"{video_id}:{quality}"
    while True:
        completed, task = await _find_or_start_spool_task_once(
            video_id,
            quality,
            purpose=purpose,
            provider_identity=provider_identity,
            pin_completed=pin_completed,
        )
        cancel_event = _spool_cancel_events.get(key)
        if task is None or cancel_event is None or not cancel_event.is_set():
            return completed, task
        # Cancellation is irreversible: the worker may already be unwinding
        # its network context. Never clear it or overlap replacement writers.
        while not task.done():
            if request is not None and await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client disconnected")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="YouTube Music spool timed out")
            await asyncio.sleep(min(0.1, remaining))
        # Its registered completion callback owns cleanup, pins, and counters.
        await asyncio.sleep(0)
        if request is not None and await request.is_disconnected():
            raise HTTPException(status_code=499, detail="Client disconnected")
        if time.monotonic() >= deadline:
            raise HTTPException(status_code=504, detail="YouTube Music spool timed out")


async def _find_or_start_spool_task_once(
    video_id: str,
    quality: str,
    *,
    purpose: Literal["interactive", "preload", "analysis"] = "interactive",
    provider_identity: str = _SPOOL_PROVIDER_IDENTITY,
    pin_completed: bool = False,
) -> tuple[tuple[str, str] | None, asyncio.Task[tuple[str, str]] | None]:
    """Find a completed entry or atomically join/start its single-flight task."""
    if not _spool_admitting:
        raise HTTPException(status_code=503, detail="YouTube Music spool is shutting down")
    key = f"{video_id}:{quality}"
    task = _spool_tasks.get(key)
    if task is not None:
        session = _spool_sessions.get(key)
        if session is not None:
            session.register_failure_scope(purpose, provider_identity)
        return None, task

    existing = (
        await _find_spooled_result(video_id, quality, pin=True)
        if pin_completed
        else await _find_spooled_result(video_id, quality)
    )
    if existing is not None:
        return existing, None

    failure_key = _spool_failure_key(
        video_id,
        quality,
        purpose,
        provider_identity=provider_identity,
    )
    _raise_cached_spool_failure(failure_key)

    # Re-check after the filesystem await. Map lookup, limit check, and insert
    # remain one event-loop-only critical section with no intervening await.
    task = _try_get_or_create_spool_task(
        key,
        video_id,
        quality,
        # Preloading still exposes progressive readiness, while the session's
        # three-level priority keeps current playback above speculative work.
        playback=purpose != "analysis",
        purpose=purpose,
        provider_identity=provider_identity,
    )
    if task is not None:
        return None, task

    # A prior task may have completed and removed itself after our preflight
    # miss. Retry disk once before reporting saturation.
    existing = (
        await _find_spooled_result(video_id, quality, pin=True)
        if pin_completed
        else await _find_spooled_result(video_id, quality)
    )
    if existing is not None:
        return existing, None

    task = _spool_tasks.get(key)
    if task is not None:
        session = _spool_sessions.get(key)
        if session is not None:
            session.register_failure_scope(purpose, provider_identity)
        return None, task
    _raise_cached_spool_failure(failure_key)
    raise HTTPException(status_code=503, detail="YouTube Music spool queue is full")


async def _get_ytmusic_spooled_stream(
    video_id: str,
    quality: str,
    request: Request | None = None,
    *,
    purpose: Literal["interactive", "preload", "analysis"] = "interactive",
    pin_result: bool = False,
) -> tuple[str, str]:
    """Return a cached spool entry, coalescing concurrent requests per track."""
    deadline = time.monotonic() + YTMUSIC_SPOOL_TIMEOUT
    completed, task = await _find_or_start_spool_task(
        video_id,
        quality,
        purpose=purpose,
        pin_completed=pin_result,
        request=request,
        deadline=deadline,
    )
    if completed is not None:
        return completed
    if task is None:
        raise RuntimeError("Spool resolution returned neither a file nor a task")
    key = f"{video_id}:{quality}"
    return (
        await _await_spool_task_for_request(
            key,
            task,
            request,
            pin_result=pin_result,
            deadline=deadline,
        )
        if request is not None
        else await _await_spool_task(task, deadline=deadline)
    )


async def is_ytmusic_spooled(video_id: str, quality: str) -> bool:
    """Report whether an atomic completed spool currently exists."""
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    return await _find_spooled_result(video_id, quality) is not None


async def warm_ytmusic_spool(
    video_id: str,
    quality: str,
    on_readable: Callable[[], None],
) -> None:
    """Warm one shared spool while exposing only readiness, never audio bytes."""
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    deadline = time.monotonic() + YTMUSIC_SPOOL_TIMEOUT
    completed, task = await _find_or_start_spool_task(
        video_id,
        quality,
        purpose="preload",
        deadline=deadline,
    )
    if completed is not None:
        return
    if task is None:
        raise RuntimeError("Warmup spool resolution returned neither a file nor a task")

    key = f"{video_id}:{quality}"
    session = _spool_sessions.get(key)
    if session is None:
        await _await_spool_task(task, deadline=deadline)
        return

    lease = _SpoolLease(key, task, session.cancel_event, session)
    notified_readable = False
    try:
        while not task.done():
            if session.readable and not notified_readable:
                notified_readable = True
                try:
                    on_readable()
                except Exception:
                    log.exception("YouTube Music warmup readiness callback failed for %s", video_id)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="YouTube Music spool timed out")
            await session.wait_for_growth(min(0.1, remaining))
        task.result()
    finally:
        lease.close()


def _read_spool_chunk(path: Path, offset: int) -> bytes:
    """Read one bounded chunk while allowing an atomic writer rename on Windows."""
    for attempt in range(_SPOOL_RENAME_MAX_ATTEMPTS):
        try:
            with path.open("rb") as spool:
                spool.seek(offset)
                return spool.read(_SPOOL_READ_CHUNK_BYTES)
        except FileNotFoundError:
            return b""
        except PermissionError:
            if attempt + 1 == _SPOOL_RENAME_MAX_ATTEMPTS:
                raise
            time.sleep(_SPOOL_RENAME_RETRY_SECONDS)
    raise RuntimeError("unreachable spool read retry state")


async def _stream_growing_spool(
    session: _SpoolSession,
    task: asyncio.Task[tuple[str, str]],
    lease: _SpoolLease,
    *,
    byte_limit: int | None = None,
) -> AsyncIterator[bytes]:
    """Tail an append-only partial, switching to the atomic final path at EOF."""
    offset = 0
    try:
        while True:
            if byte_limit is not None and offset >= byte_limit:
                return
            path: Path | None
            if task.done():
                path_text, _content_type = task.result()
                path = Path(path_text)
            else:
                path = session.partial_path
            if path is not None:
                chunk = await asyncio.to_thread(_read_spool_chunk, path, offset)
                if chunk:
                    if byte_limit is not None:
                        chunk = chunk[: byte_limit - offset]
                    offset += len(chunk)
                    yield chunk
                    continue
            if task.done():
                completed_path = Path(task.result()[0])
                if path != completed_path:
                    # The writer may have atomically renamed the partial after
                    # the path selection but before this read. Make one pass
                    # over the completed path instead of ending with a 200 and
                    # an empty (or truncated) response.
                    continue
                if byte_limit is not None and offset < byte_limit:
                    raise RuntimeError("Completed spool ended before the requested range")
                return
            await session.wait_for_growth()
    finally:
        lease.close()


async def _growing_spool_response(
    video_id: str,
    quality: str,
    request: Request,
    *,
    purpose: Literal["interactive", "preload"],
    range_end: int | None = None,
) -> Response:
    """Return at a proven prefix, or fall back to the completed local file."""
    deadline = time.monotonic() + YTMUSIC_SPOOL_TIMEOUT
    completed, task = await _find_or_start_spool_task(
        video_id,
        quality,
        purpose=purpose,
        pin_completed=True,
        request=request,
        deadline=deadline,
    )
    if completed is not None:
        return _PinnedFileResponse(*completed, pin_owned=True)
    if task is None:
        raise RuntimeError("Growing spool resolution returned neither a file nor a task")
    key = f"{video_id}:{quality}"
    session = _spool_sessions.get(key)
    if session is None:
        path, content_type = await _await_spool_task_for_request(
            key,
            task,
            request,
            pin_result=True,
            deadline=deadline,
        )
        return _PinnedFileResponse(path, content_type, pin_owned=True)

    lease = _SpoolLease(key, task, session.cancel_event, session)
    try:
        while not task.done() and (
            not session.readable or (range_end is not None and session.content_length is None)
        ):
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client disconnected")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="YouTube Music spool timed out")
            await session.wait_for_growth(min(0.1, remaining))
        if task.done():
            path, content_type = task.result()
            response = _PinnedFileResponse(path, content_type)
            lease.close()
            return response
        if session.content_type is None:
            raise RuntimeError("Readable spool session has no content type")
        if range_end is not None:
            if session.content_length is None or session.content_length <= 0:
                raise RuntimeError("Readable ranged spool session has no valid content length")
            byte_limit = min(range_end + 1, session.content_length)
            return _LeaseStreamingResponse(
                _stream_growing_spool(session, task, lease, byte_limit=byte_limit),
                session.content_type,
                lease,
                status_code=206,
                headers={
                    "Content-Range": f"bytes 0-{byte_limit - 1}/{session.content_length}",
                    "Content-Length": str(byte_limit),
                },
            )
        return _LeaseStreamingResponse(
            _stream_growing_spool(session, task, lease),
            session.content_type,
            lease,
        )
    except BaseException:
        lease.close()
        raise


def _drain_spool_executors(
    drained: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Drain both bounded spool phases and notify the event loop."""
    for label, executor in (
        ("extraction", _yt_dlp_spool_executor),
        ("transfer", _spool_transfer_executor),
    ):
        try:
            executor.shutdown(wait=True, cancel_futures=True)
        except Exception:
            log.exception("YouTube Music spool %s executor drain failed", label)
    try:
        loop.call_soon_threadsafe(drained.set)
    except RuntimeError:
        return


async def shutdown_stream_provider() -> None:
    """Stop spool admission, signal writers, and bound executor draining."""
    global _spool_admitting

    _spool_admitting = False
    for cancel_event in tuple(_spool_cancel_events.values()):
        cancel_event.set()

    active_tasks = tuple(_spool_tasks.values())
    if active_tasks:
        done, pending = await asyncio.wait(active_tasks, timeout=_SPOOL_DRAIN_SECONDS)
        for task in done:
            if not task.cancelled():
                _ = task.exception()
        if pending:
            log.warning(
                "YouTube Music spool task drain exceeded %.1f seconds (%d active)",
                _SPOOL_DRAIN_SECONDS,
                len(pending),
            )

    loop = asyncio.get_running_loop()
    drained = asyncio.Event()
    drain_thread = threading.Thread(
        target=_drain_spool_executors,
        args=(drained, loop),
        name="ytmusic-spool-shutdown",
        daemon=True,
    )
    drain_thread.start()
    try:
        async with asyncio.timeout(_SPOOL_DRAIN_SECONDS):
            await drained.wait()
    except TimeoutError:
        log.warning(
            "YouTube Music spool executor drain exceeded %.1f seconds",
            _SPOOL_DRAIN_SECONDS,
        )
    _spool_failure_cache.clear()


def _clean_stream_cache_locked() -> int:
    """Remove expired stream entries while the owning lock is held."""
    now = time.time()
    expired = [k for k, v in _stream_cache.items() if v.get("expires_at", 0) <= now]
    for k in expired:
        del _stream_cache[k]
    return len(expired)


def _clean_stream_cache() -> None:
    """Remove expired entries from stream cache."""
    with _stream_cache_lock:
        expired_count = _clean_stream_cache_locked()
    if expired_count:
        log.debug(f"Cleaned {expired_count} expired stream cache entries")


@app.get("/stream/{video_id}")
async def get_stream_info(
    video_id: str, user_id: str = Query(...), quality: str = "HIGH", cached_only: bool = False
) -> JsonObject:
    """Get stream URL info for a video (metadata only, no proxy).

    When user_id is "__public__", skips OAuth verification. Quality badges use
    cached_only to avoid a second extraction; an unknown bitrate is zero.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    # Skip OAuth check for public/unauthenticated streaming
    if user_id != "__public__":
        _get_ytmusic(user_id)

    result = _cached_music_info(video_id, quality)
    if result is None:
        if cached_only:
            result = {"url": "", "content_type": "", "duration": 0, "expires_at": 0}
        else:
            result = await _extract_stream_info_bounded(
                _get_stream_url_sync, user_id, video_id, quality
            )
    return {
        "videoId": video_id,
        "url": result["url"],
        "content_type": result["content_type"],
        "duration": result["duration"],
        "abr": result.get("abr", 0),
        "acodec": result.get("acodec", ""),
        "expires_at": result["expires_at"],
    }


@app.get("/proxy/{video_id}")
async def proxy_stream(
    video_id: str,
    request: Request,
    user_id: str = Query(...),
    quality: str = "HIGH",
    purpose: Literal["interactive", "preload", "analysis"] = Query("interactive"),
) -> Response:
    """Serve YouTube Music audio from a bounded local spool.

    Soundspan tails only direct progressive sources whose container prefix has
    been validated. Initial bounded ranges can tail sources with a known length.
    HLS, analysis, and other range reads wait for the completed atomic local file.

    Concurrent requests for the same track share one download.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)

    if user_id != "__public__":
        _get_ytmusic(user_id)

    range_header = request.headers.get("range", "").strip().lower()
    # Keep conditional, suffix, seek, multipart, and unusually large ranges on
    # FileResponse's completed-file parser and validator handling.
    initial_range = re.fullmatch(r"bytes=0-([0-9]{1,20})", range_header)
    range_end = (
        int(initial_range.group(1))
        if initial_range is not None and "if-range" not in request.headers
        else None
    )
    if purpose in {"interactive", "preload"} and (
        range_header in {"", "bytes=0-"} or range_end is not None
    ):
        return await _growing_spool_response(
            video_id,
            quality,
            request,
            purpose=purpose,
            range_end=range_end,
        )

    # FileResponse consumes completed-file Range from the ASGI scope itself.
    path, content_type = await _get_ytmusic_spooled_stream(
        video_id,
        quality,
        request,
        purpose=purpose,
        pin_result=True,
    )
    return _PinnedFileResponse(path, content_type, pin_owned=True)


@app.get("/yt/info")
async def yt_video_info(url: str = Query(...)) -> JsonObject:
    """
    Return metadata for a regular YouTube video.
    No authentication required — uses yt-dlp anonymous extraction.
    """
    import yt_dlp

    try:
        video_id = _extract_video_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ydl_opts = {
        # Select the exact format the /yt/ stream proxy serves at its
        # default quality so the audioFormat hint below matches the bytes
        # the player will receive.
        "format": PROXY_AUDIO_FORMAT_SELECTORS["HIGH"],
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "skip_download": True,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {
            "youtube": {
                "player_client": YT_PLAYER_CLIENTS,
            },
        },
    }

    try:

        def _extract() -> Any:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(
                    f"https://www.youtube.com/watch?v={video_id}",
                    download=False,
                )

        info = await _extract_yt_dlp_bounded(
            _extract,
            timeout_detail="YouTube extraction timed out",
        )
        if not info:
            raise HTTPException(status_code=404, detail="Video not found")

        thumbnails = info.get("thumbnails", [])
        best_thumb = thumbnails[-1]["url"] if thumbnails else None

        return {
            "videoId": info.get("id", video_id),
            "title": info.get("title", ""),
            "uploader": info.get("uploader", ""),
            "duration": info.get("duration", 0),
            "thumbnail": best_thumb,
            "uploadDate": info.get("upload_date", ""),
            # Container the /yt/ stream proxy serves — derived from the
            # same format selection (and acodec mapping) the proxy uses,
            # so the player's decode hint (webm vs mp4) always matches.
            "audioFormat": derive_proxy_audio_container(info),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"yt-dlp info extraction for {url}",
            e,
            502,
            "Failed to fetch video info",
        ) from e


@app.get("/yt/playlist-info")
async def yt_playlist_info(url: str = Query(...)) -> JsonObject:
    """
    Enumerate a YouTube playlist or channel into a bounded list of video
    entries for the bulk-download UI. No authentication required — uses
    yt-dlp anonymous flat extraction (fast: it lists entries without
    resolving each video's formats).

    Rejects single-video URLs (use /yt/info) and auto-generated radio/mix
    lists (list=RD*, which YouTube does not expose as a static set) with 422
    so the UI can explain why.
    """
    import yt_dlp

    classification = classify_youtube_url(url)
    kind = classification.get("kind")

    if kind == "mix":
        raise HTTPException(
            status_code=422,
            detail=(
                "This is an auto-generated YouTube mix/radio, which can't be "
                "downloaded as a set. Paste the individual video instead."
            ),
        )
    if kind not in ("playlist", "channel"):
        raise HTTPException(
            status_code=422,
            detail="URL is not a YouTube playlist or channel.",
        )

    enumerate_url = classification["enumerate_url"]
    # Fetch one past the cap so truncation is detectable even when yt-dlp
    # does not report a playlist_count (common for channel tabs): the extra
    # entry tips build_playlist_entries into truncated=True.
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "playlistend": YT_PLAYLIST_MAX_ENTRIES + 1,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {
            "youtube": {
                "player_client": YT_PLAYER_CLIENTS,
            },
        },
    }

    try:

        def _extract() -> Any:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(enumerate_url, download=False)

        info = await _extract_yt_dlp_bounded(
            _extract,
            timeout_detail="YouTube extraction timed out",
        )
        if not info:
            raise HTTPException(status_code=404, detail="Playlist or channel not found")

        summary = build_playlist_entries(info, YT_PLAYLIST_MAX_ENTRIES)
        if summary["count"] == 0:
            raise HTTPException(
                status_code=422,
                detail="No downloadable videos found in this playlist or channel.",
            )

        return {
            "kind": kind,
            "playlistId": classification.get("playlist_id"),
            "channel": classification.get("channel"),
            "sourceUrl": enumerate_url,
            **summary,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"yt-dlp playlist enumeration for {url}",
            e,
            502,
            "Failed to enumerate playlist/channel",
        ) from e


@app.get("/yt/proxy/{video_id}")
async def yt_proxy_stream(
    video_id: str,
    request: Request,
    quality: str = "HIGH",
) -> StreamingResponse:
    """
    Proxy audio stream from a regular YouTube video.
    No OAuth required — uses anonymous yt-dlp extraction.
    Same Range-request handling as the YouTube Music proxy.
    """
    # This path still range-proxies progressive URLs. SABR is breaking that flow,
    # so regular YouTube should eventually move to the same spool mechanism.
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    stream_info = await _extract_stream_info_bounded(_get_yt_stream_url_sync, video_id, quality)
    stream_url = stream_info["url"]

    acodec = stream_info.get("acodec", "")
    if "opus" in acodec:
        content_type = "audio/webm"
    elif "mp4a" in acodec or "aac" in acodec:
        content_type = "audio/mp4"
    else:
        content_type = "audio/mp4"

    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
    }
    if request and "range" in request.headers:
        headers["Range"] = request.headers["range"]

    if headers.get("Range"):
        return await build_range_proxy_response(
            stream_url, headers, content_type, _USER_AGENT, log, video_id
        )
    return build_full_proxy_response(stream_url, headers, content_type, _USER_AGENT, log, video_id)
