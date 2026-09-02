"""Stream extraction, proxying, regular-YouTube metadata, and caches."""

import asyncio
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from typing import Any, TypeVar, cast

from fastapi import HTTPException, Query, Request
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
YTDLP_EXTRACT_CONCURRENCY = max(1, min(16, env_int("YTMUSIC_YTDLP_EXTRACT_CONCURRENCY", "4")))
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
_yt_dlp_spool_executor = ThreadPoolExecutor(
    max_workers=YTMUSIC_SPOOL_CONCURRENCY,
    thread_name_prefix="yt-dlp-spool",
)
# The event loop owns all access, with no await between lookup and insertion.
_spool_tasks: dict[str, asyncio.Task[tuple[str, str]]] = {}
_spool_cancel_events: dict[str, threading.Event] = {}
_spool_waiters: dict[str, int] = {}
_spool_pending_jobs = 0
_spool_prune_lock = threading.Lock()
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


class _SpoolDownloadCancelled(Exception):
    """Stop a provider download after every HTTP waiter has disconnected."""


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


def _best_audio_stream_url(info: JsonObject) -> str | None:
    """Return the direct URL or the highest-bitrate audio-only format URL."""
    stream_url = info.get("url")
    if stream_url:
        return cast(str, stream_url)
    audio_formats = [
        item
        for item in info.get("formats", [])
        if item.get("acodec") != "none" and item.get("vcodec") in ("none", None)
    ]
    audio_formats.sort(key=lambda item: item.get("abr", 0) or 0, reverse=True)
    return audio_formats[0].get("url") if audio_formats else None


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
            stream_url = _best_audio_stream_url(info)
            if not stream_url:
                raise ValueError("No audio stream URL found")
            result = {
                "url": stream_url,
                "content_type": info.get("audio_ext", "m4a"),
                "duration": info.get("duration", 0),
                "title": info.get("title", ""),
                "artist": info.get("artist") or info.get("uploader", ""),
                "expires_at": time.time() + STREAM_CACHE_TTL,
                "abr": info.get("abr", 0),
                "acodec": info.get("acodec", ""),
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
        f"yt:{video_id}",
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
        f"{user_id}:{video_id}",
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
    try:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(_yt_dlp_extract_executor, func, *args)
        return await asyncio.wait_for(future, timeout=EXTRACT_TIMEOUT)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail=timeout_detail) from error


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


def _spool_candidates(video_id: str, quality: str) -> list[Path]:
    """Return completed spool files for one track, newest first."""
    if not YTMUSIC_SPOOL_DIR.exists():
        return []
    prefix = f"{video_id}-{quality}."
    candidates: list[tuple[float, Path]] = []
    for path in YTMUSIC_SPOOL_DIR.iterdir():
        if (
            not path.is_file()
            or not path.name.startswith(prefix)
            or ".part" in path.name
            or path.name.endswith(".ytdl")
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


def _find_spooled_file(video_id: str, quality: str) -> Path | None:
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
        if ".part" in path.name or path.name.endswith(".ytdl"):
            if now - stat.st_mtime > _SPOOL_PARTIAL_STALE_SECONDS:
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue
                log.debug("Removed stale YouTube Music spool partial %s", path.name)
            continue
        total += stat.st_size
        entries.append((stat.st_mtime, stat.st_size, path))
    return total, entries


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
        if isinstance(downloaded_bytes, int) and downloaded_bytes > YTMUSIC_SPOOL_TRACK_MAX_BYTES:
            raise RuntimeError(
                "YouTube Music spool downloaded bytes exceeded "
                f"{YTMUSIC_SPOOL_TRACK_MAX_BYTES} byte limit"
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
    fmt = _build_ytmusic_spool_format(quality, YTMUSIC_SPOOL_TRACK_MAX_BYTES)
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
        is_partial = ".part" in path.name or path.name.endswith(".ytdl")
        if path.name.startswith(prefix) and is_partial:
            with suppress(FileNotFoundError):
                path.unlink()


def _download_ytmusic_spool_sync(
    video_id: str,
    quality: str,
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
    ydl_opts = _build_ytmusic_spool_options(
        video_id,
        quality,
        match_filter=yt_dlp.utils.match_filter_func("!is_live"),
        progress_hook=_build_spool_progress_hook(started_at, cancel_event),
    )

    try:
        if cancel_event is not None and cancel_event.is_set():
            raise _SpoolDownloadCancelled("YouTube Music spool request was abandoned")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(
                f"https://music.youtube.com/watch?v={video_id}",
                download=True,
            )
            if not info:
                raise ValueError("No info extracted while spooling stream")

        completed = _find_spooled_file(video_id, quality)
        if completed is None:
            raise ValueError("yt-dlp completed without a spool file")
        completed_size = completed.stat().st_size
        if completed_size > YTMUSIC_SPOOL_MAX_BYTES:
            with suppress(FileNotFoundError):
                completed.unlink()
            raise ValueError("YouTube Music spool file exceeds the total spool byte budget")

        _prune_spool(exclude=completed)
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
    except Exception as error:
        # yt-dlp normally cleans these itself; remove leftovers after failures.
        _remove_failed_spool_partials(video_id, quality)
        raise _stream_extraction_http_error(
            video_id,
            f"yt-dlp spool for {video_id}",
            error,
        ) from error


async def _download_ytmusic_spool_bounded(video_id: str, quality: str) -> tuple[str, str]:
    """Run one spool download for the executor thread's full lifetime."""
    loop = asyncio.get_running_loop()
    # yt-dlp's socket timeout bounds the executor thread between network reads.
    return await loop.run_in_executor(
        _yt_dlp_spool_executor,
        _download_ytmusic_spool_sync,
        video_id,
        quality,
    )


def _remove_completed_spool_task(key: str, task: asyncio.Task[tuple[str, str]]) -> None:
    """Remove one completed single-flight task without disturbing a replacement."""
    global _spool_pending_jobs

    if _spool_tasks.get(key) is task:
        _spool_tasks.pop(key, None)
        _spool_cancel_events.pop(key, None)
    if _spool_pending_jobs > 0:
        _spool_pending_jobs -= 1
    else:
        log.error("YouTube Music spool pending-job counter underflow")
    if not task.cancelled():
        # Observe failures when every waiter disconnected before completion.
        _ = task.exception()


def _create_spool_task(key: str, video_id: str, quality: str) -> asyncio.Task[tuple[str, str]]:
    """Create one bounded event-loop-owned spool task."""
    global _spool_pending_jobs

    if _spool_pending_jobs >= _SPOOL_MAX_PENDING_JOBS:
        raise HTTPException(status_code=503, detail="YouTube Music spool queue is full")
    _spool_cancel_events[key] = threading.Event()
    task = asyncio.create_task(_download_ytmusic_spool_bounded(video_id, quality))
    _spool_tasks[key] = task
    _spool_pending_jobs += 1
    task.add_done_callback(lambda completed: _remove_completed_spool_task(key, completed))
    return task


def _try_get_or_create_spool_task(
    key: str, video_id: str, quality: str
) -> asyncio.Task[tuple[str, str]] | None:
    """Join or create a task, or return None when the queue is full.

    The event loop owns this helper. It contains no await between the final map
    lookup, capacity check, and insertion performed by ``_create_spool_task``.
    """
    task = _spool_tasks.get(key)
    if task is not None:
        return task
    if _spool_pending_jobs >= _SPOOL_MAX_PENDING_JOBS:
        return None
    return _create_spool_task(key, video_id, quality)


def _spooled_file_result(path: Path) -> tuple[str, str]:
    """Return the transport result for one completed spool file."""
    return str(path), _spool_content_type(path)


async def _find_spooled_result(video_id: str, quality: str) -> tuple[str, str] | None:
    """Find a spool file off the event loop and map it to a stream result."""
    existing = await asyncio.to_thread(_find_spooled_file, video_id, quality)
    return _spooled_file_result(existing) if existing is not None else None


async def _await_spool_task(task: asyncio.Task[tuple[str, str]]) -> tuple[str, str]:
    """Await one shared spool task without allowing a waiter to cancel it."""
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=YTMUSIC_SPOOL_TIMEOUT)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail="YouTube Music spool timed out") from error


async def _await_spool_task_for_request(
    key: str,
    task: asyncio.Future[tuple[str, str]],
    request: Request,
) -> tuple[str, str]:
    """Await a shared spool while cancelling work abandoned by every client."""
    _spool_waiters[key] = _spool_waiters.get(key, 0) + 1
    # A new listener may arrive just after the prior last waiter disconnected
    # but before the executor observed its cancellation event. Revive that
    # still-running single-flight instead of needlessly failing the new request.
    cancel_event = _spool_cancel_events.get(key)
    if cancel_event is not None:
        cancel_event.clear()
    deadline = time.monotonic() + YTMUSIC_SPOOL_TIMEOUT
    try:
        while not task.done():
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client disconnected")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="YouTube Music spool timed out")
            await asyncio.sleep(min(0.1, remaining))
        return task.result()
    finally:
        remaining = _spool_waiters.get(key, 1) - 1
        if remaining > 0:
            _spool_waiters[key] = remaining
        else:
            _spool_waiters.pop(key, None)
            if not task.done():
                cancel_event = _spool_cancel_events.get(key)
                if cancel_event is not None:
                    cancel_event.set()


async def _get_ytmusic_spooled_stream(
    video_id: str,
    quality: str,
    request: Request | None = None,
) -> tuple[str, str]:
    """Return a cached spool entry, coalescing concurrent requests per track."""
    key = f"{video_id}:{quality}"
    task = _spool_tasks.get(key)
    if task is not None:
        return (
            await _await_spool_task_for_request(key, task, request)
            if request is not None
            else await _await_spool_task(task)
        )

    existing = await _find_spooled_result(video_id, quality)
    if existing is not None:
        return existing

    # Re-check after the filesystem await. Map lookup, limit check, and insert
    # remain one event-loop-only critical section with no intervening await.
    task = _try_get_or_create_spool_task(key, video_id, quality)
    if task is not None:
        return (
            await _await_spool_task_for_request(key, task, request)
            if request is not None
            else await _await_spool_task(task)
        )

    # A prior task may have completed and removed itself after our preflight
    # miss. Retry disk once before reporting saturation.
    existing = await _find_spooled_result(video_id, quality)
    if existing is not None:
        return existing

    task = _spool_tasks.get(key)
    if task is not None:
        return (
            await _await_spool_task_for_request(key, task, request)
            if request is not None
            else await _await_spool_task(task)
        )
    raise HTTPException(status_code=503, detail="YouTube Music spool queue is full")


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
    video_id: str, user_id: str = Query(...), quality: str = "HIGH"
) -> JsonObject:
    """Get stream URL info for a video (metadata only, no proxy).

    When user_id is "__public__", skips OAuth verification.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    # Skip OAuth check for public/unauthenticated streaming
    if user_id != "__public__":
        _get_ytmusic(user_id)

    result = await _extract_stream_info_bounded(_get_stream_url_sync, user_id, video_id, quality)
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
) -> FileResponse:
    """Serve YouTube Music audio from a bounded local yt-dlp HLS spool.

    YouTube progressive signed URLs no longer reliably support continuation
    ranges. yt-dlp downloads the complete HLS audio first; Starlette then
    provides normal local-file Range semantics to the player.

    Concurrent requests for the same track share one download.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)

    if user_id != "__public__":
        _get_ytmusic(user_id)

    # FileResponse consumes Range from the ASGI request scope itself.
    _ = request
    path, content_type = await _get_ytmusic_spooled_stream(video_id, quality, request)
    return FileResponse(
        path,
        media_type=content_type,
        headers={"Accept-Ranges": "bytes"},
    )


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
