"""Bounded CPU isolation for one anonymous player request, never recovery.

The calling thread retains the shared extraction slot and pacing policy until
the real worker finishes. CAPTCHA, format fallback and cache ownership remain
in the parent. Workers receive no account credentials and retain no audio URLs.
"""

import multiprocessing
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Any
from urllib.parse import parse_qs, urlsplit

import yt_dlp

_pool: ProcessPoolExecutor | None = None
_pool_lock = threading.Lock()
_closed = False
_admission = threading.BoundedSemaphore(16)
_RESULT_FIELDS = frozenset(
    {
        "format_id",
        "acodec",
        "vcodec",
        "protocol",
        "url",
        "ext",
        "audio_ext",
        "abr",
        "duration",
        "title",
        "artist",
        "uploader",
    }
)


def _initialize_probe_worker() -> None:
    """Load the pinned extraction modules without contacting any provider."""
    from ytmusic_anonymous_context import _AudioOnlyYoutubeIE

    with yt_dlp.YoutubeDL({"allowed_extractors": ["youtube"], "quiet": True}) as downloader:
        downloader.add_info_extractor(_AudioOnlyYoutubeIE())


def _probe_ready() -> bool:
    return True


def _get_pool(workers: int) -> ProcessPoolExecutor:
    """Return the process-wide pool while the caller holds the lifecycle lock."""
    global _pool
    if _closed:
        raise RuntimeError("Anonymous player workers are shutting down")
    if _pool is None:
        _pool = ProcessPoolExecutor(
            max_workers=min(8, workers),
            mp_context=multiprocessing.get_context("spawn"),
            initializer=_initialize_probe_worker,
        )
    return _pool


def warm_fast_probes(*, workers: int = 1) -> None:
    """Prestart bounded CPU workers, never prefetch tracks or account data."""
    # yt-dlp's global plugin registration is not safe to initialize in several
    # request threads at once. Prime the parent before accepting HTTP traffic.
    _initialize_probe_worker()
    if workers <= 1:
        return
    with _pool_lock:
        pool = _get_pool(workers)
        ready = [pool.submit(_probe_ready) for _ in range(min(8, workers))]
    for future in ready:
        future.result(timeout=30)


def _probe_once(url: str, options: dict[str, Any]) -> dict[str, Any]:
    """Resolve once in an owned downloader and return a small serializable result."""
    from ytmusic_anonymous_context import _AudioOnlyYoutubeIE
    from ytmusic_po_fallback import _QuietTokenLogger

    try:
        with yt_dlp.YoutubeDL({**options, "logger": _QuietTokenLogger()}) as downloader:
            visitor = options.get("extractor_args", {}).get("youtube", {}).get("visitor_data", [])
            if visitor:
                extractor = _AudioOnlyYoutubeIE()
                downloader.add_info_extractor(extractor)
                extractor.initialize()
                video_id = extractor.extract_id(url)
                response = extractor._extract_player_response(
                    "visionos", video_id, {}, {}, None, {}, visitor[0], None, None
                )
                info = _select_direct_audio(response, video_id)
            else:
                # Preserve the ordinary entry point for non-shortcut callers.
                downloader.add_info_extractor(_AudioOnlyYoutubeIE())
                info = downloader.extract_info(url, download=False)
        return {
            "info": {key: value for key, value in (info or {}).items() if key in _RESULT_FIELDS}
        }
    except (yt_dlp.utils.DownloadError, yt_dlp.utils.ExtractorError) as error:
        # Exception tracebacks are not safe to pickle. The parent applies the
        # same error classification and single recovery gate as inline work.
        return {"download_error": str(error)[:2048]}


def _select_direct_audio(response: Any, video_id: str) -> dict[str, Any]:
    """Accept only one unsigned-transform-free original Opus rendition.

    The caller pins the upstream hook version. Ambiguous languages, live audio,
    cipher/n transforms and changed schemas return to full format extraction.
    """
    if not isinstance(response, dict):
        return {}
    try:
        details = response["videoDetails"]
        if (
            response["playabilityStatus"]["status"] != "OK"
            or details["videoId"] != video_id
            or details.get("isLiveContent")
        ):
            return {}
        formats = [f for f in response["streamingData"]["adaptiveFormats"] if f.get("itag") == 251]
        if len(formats) != 1:
            return {}
        selected = formats[0]
        source = urlsplit(selected["url"])
        bitrate = float(selected["bitrate"]) / 1000
        duration = float(details["lengthSeconds"])
        if (
            selected["mimeType"] != 'audio/webm; codecs="opus"'
            or selected.get("signatureCipher")
            or selected.get("cipher")
            or selected.get("drmFamilies")
            or selected.get("audioTrack")
            or source.scheme != "https"
            or not (source.hostname or "").endswith(".googlevideo.com")
            or source.netloc.lower() not in {source.hostname, f"{source.hostname}:443"}
            or "n" in parse_qs(source.query)
            or not 0 < bitrate <= 256
            or not 0 < duration < 86400
        ):
            return {}
        return {
            "url": selected["url"],
            "format_id": "251",
            "acodec": "opus",
            "vcodec": "none",
            "protocol": "https",
            "ext": "webm",
            "audio_ext": "webm",
            "abr": bitrate,
            "duration": duration,
            "title": details.get("title", ""),
            "uploader": details.get("author", ""),
        }
    except (KeyError, TypeError, ValueError, AttributeError):
        return {}


def extract_fast(url: str, options: dict[str, Any], *, workers: int = 1) -> dict[str, Any]:
    """Run one bounded probe; low-concurrency deployments retain inline work."""
    global _pool

    if workers <= 1:
        result = _probe_once(url, options)
    else:
        with _admission:
            pool = None
            try:
                with _pool_lock:
                    pool = _get_pool(workers)
                    future = pool.submit(_probe_once, url, options)
                # Do not free admission on an HTTP waiter's timeout: the process
                # still owns real work, bounded by the upstream socket timeout.
                result = future.result()
            except BrokenProcessPool:
                # A crashed pool cannot accept any future request. Detach only
                # this generation; never replay its work or erase a replacement.
                with _pool_lock:
                    if _pool is pool:
                        _pool = None
                if pool is not None:
                    pool.shutdown(wait=False, cancel_futures=True)
                raise
    if "download_error" in result:
        raise yt_dlp.utils.DownloadError(result["download_error"])
    return dict(result["info"])


def shutdown_fast_probes() -> None:
    """Reject new work and cancel unstarted probes without blocking the event loop."""
    global _closed, _pool

    with _pool_lock:
        _closed = True
        pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)
