"""Behavioral tests for the YouTube Music stream spool."""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import HTTPException
from httpx import AsyncClient, Response

VIDEO_ID = "dQw4w9WgXcQ"
QUALITY = "HIGH"


def _wake_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Wake the Python 3.14 test loop after a worker callback queues work."""
    if loop.is_closed():
        raise AssertionError("Cannot wake a closed event loop")

    def schedule_wakes() -> None:
        loop.call_later(0.001, lambda: None)
        loop.call_later(0.002, lambda: None)

    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if running_loop is loop:
        schedule_wakes()
    else:
        loop.call_soon_threadsafe(schedule_wakes)


def _signal_async_event(loop: asyncio.AbstractEventLoop, event: asyncio.Event) -> None:
    """Set an event from a worker thread and wake its waiter."""
    loop.call_soon_threadsafe(event.set)
    _wake_event_loop(loop)


async def _await_file_response(task: asyncio.Task[Response]) -> Response:
    """Keep the Python 3.14 test loop waking while FileResponse uses AnyIO threads."""
    for _ in range(200):
        if task.done():
            return await task
        await asyncio.sleep(0.01)
    raise TimeoutError("FileResponse test did not finish")


async def _await_async_event(event: asyncio.Event) -> None:
    """Keep the Python 3.14 test loop waking until a worker signals an event."""
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise TimeoutError("Worker event was not signaled")


async def _run_inline(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run an asyncio.to_thread target inline for deterministic unit tests."""
    return function(*args, **kwargs)


class CapturingExecutor:
    """Thread executor that exposes the latest submitted future to tests."""

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=2)
        self.latest: Future[Any] | None = None
        self.shutdown_calls = 0

    def submit(self, function: Callable[..., Any], /, *args: Any) -> Future[Any]:
        self.latest = self._executor.submit(function, *args)
        return self.latest

    def wake_loop_on_completion(self, loop: asyncio.AbstractEventLoop) -> None:
        """Wake the loop after its executor-future callback is queued."""
        if self.latest is None:
            raise AssertionError("No spool download was submitted")
        self.latest.add_done_callback(lambda _finished: _wake_event_loop(loop))

    def shutdown(self, *, wait: bool = True, cancel_futures: bool = True) -> None:
        """Join all worker threads owned by this test executor."""
        self.shutdown_calls += 1
        self._executor.shutdown(wait=wait, cancel_futures=cancel_futures)


class GatedSpoolDownload:
    """Controllable async spool download used to exercise task callbacks."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.failing_keys: set[str] = set()

    async def __call__(
        self,
        video_id: str,
        quality: str,
        *,
        playback: bool = True,
        session: Any | None = None,
    ) -> tuple[str, str]:
        _ = playback, session
        self.started.set()
        await self.release.wait()
        if f"{video_id}:{quality}" in self.failing_keys:
            raise HTTPException(status_code=502, detail="download failed")
        return (f"{video_id}-{quality}.m4a", "audio/mp4")

    def reset(self, *failing_keys: str) -> None:
        """Close the prior phase and prepare a new gated phase."""
        self.started.clear()
        self.release.clear()
        self.failing_keys = set(failing_keys)


async def _assert_spool_task_completion_lifecycle(
    stream_module: Any, download: GatedSpoolDownload
) -> None:
    """Prove success and failure callbacks both decrement pending jobs."""
    success = stream_module._create_spool_task("success:HIGH", "success", "HIGH")
    await asyncio.wait_for(download.started.wait(), timeout=1)
    assert stream_module._spool_pending_jobs == 1
    download.release.set()
    assert await success == ("success-HIGH.m4a", "audio/mp4")
    assert stream_module._spool_pending_jobs == 0

    download.reset("failure:HIGH")
    failure = stream_module._create_spool_task("failure:HIGH", "failure", "HIGH")
    await asyncio.wait_for(download.started.wait(), timeout=1)
    assert stream_module._spool_pending_jobs == 1
    download.release.set()
    with pytest.raises(HTTPException, match="download failed"):
        await failure
    assert stream_module._spool_pending_jobs == 0
    assert stream_module._spool_tasks == {}


async def _start_same_key_waiter(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    capacity_tasks: list[asyncio.Task[tuple[str, str]]],
) -> asyncio.Task[tuple[str, str]]:
    """Start and observe a same-key waiter while the queue is full."""
    real_await_spool_task = stream_module._await_spool_task
    existing_joined = asyncio.Event()

    async def record_existing_join(
        task: asyncio.Task[tuple[str, str]], *, deadline: float | None = None
    ) -> tuple[str, str]:
        if task is capacity_tasks[0]:
            existing_joined.set()
        return cast(tuple[str, str], await real_await_spool_task(task, deadline=deadline))

    monkeypatch.setattr(stream_module, "_await_spool_task", record_existing_join)
    waiter = asyncio.create_task(stream_module._get_ytmusic_spooled_stream("video-0", "HIGH"))
    await asyncio.wait_for(existing_joined.wait(), timeout=1)
    assert not waiter.done()
    return waiter


def _install_preflight_miss(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> tuple[Path, dict[str, int]]:
    """Install a lookup whose first miss races with a completed file landing."""
    cached_path = tmp_path / f"{VIDEO_ID}-LOW.m4a"
    lookup_counts: dict[str, int] = {}

    def find_after_preflight_miss(video_id: str, quality: str) -> Path | None:
        key = f"{video_id}:{quality}"
        lookup_counts[key] = lookup_counts.get(key, 0) + 1
        if key == f"{VIDEO_ID}:LOW" and lookup_counts[key] == 1:
            cached_path.write_bytes(b"cached")
            return None
        return cached_path if key == f"{VIDEO_ID}:LOW" else None

    monkeypatch.setattr(stream_module, "_find_spooled_file", find_after_preflight_miss)
    return cached_path, lookup_counts


@pytest.fixture()
def stream_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Any]:
    """Provide isolated spool state for one test."""
    import ytmusic_stream

    ytmusic_stream._spool_tasks.clear()
    ytmusic_stream._spool_cancel_events.clear()
    ytmusic_stream._spool_waiters.clear()
    ytmusic_stream._spool_sessions.clear()
    ytmusic_stream._spool_failure_cache.clear()
    ytmusic_stream._stream_cache.clear()
    ytmusic_stream._spool_pinned_paths.clear()
    ytmusic_stream._spool_pin_counts.clear()
    ytmusic_stream._spool_pending_jobs = 0
    ytmusic_stream._spool_background_pending_jobs = 0
    ytmusic_stream._spool_reserved_bytes = 0
    ytmusic_stream._spool_admitting = True
    ytmusic_stream._provider_challenge_cooldown_until = 0.0
    monkeypatch.setattr(ytmusic_stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    executor = CapturingExecutor()
    transfer_executor = CapturingExecutor()
    try:
        monkeypatch.setattr(ytmusic_stream, "_yt_dlp_spool_executor", executor)
        monkeypatch.setattr(
            ytmusic_stream,
            "_spool_transfer_executor",
            transfer_executor,
            raising=False,
        )
        yield ytmusic_stream
    finally:
        ytmusic_stream._spool_tasks.clear()
        ytmusic_stream._spool_cancel_events.clear()
        ytmusic_stream._spool_waiters.clear()
        ytmusic_stream._spool_sessions.clear()
        ytmusic_stream._spool_failure_cache.clear()
        ytmusic_stream._stream_cache.clear()
        ytmusic_stream._spool_pinned_paths.clear()
        ytmusic_stream._spool_pin_counts.clear()
        ytmusic_stream._spool_pending_jobs = 0
        ytmusic_stream._spool_background_pending_jobs = 0
        ytmusic_stream._spool_reserved_bytes = 0
        ytmusic_stream._spool_admitting = True
        ytmusic_stream._provider_challenge_cooldown_until = 0.0
        executor.shutdown()
        transfer_executor.shutdown()


@pytest.mark.parametrize(
    ("suffix", "expected"),
    [
        (".m4a", "audio/mp4"),
        (".mp4", "audio/mp4"),
        (".aac", "audio/mp4"),
        (".webm", "audio/webm"),
        (".opus", "audio/webm"),
        (".bin", "application/octet-stream"),
    ],
)
def test_spool_content_type_maps_audio_containers(
    stream_module: Any, suffix: str, expected: str
) -> None:
    path = Path(f"track{suffix}")

    assert stream_module._spool_content_type(path) == expected


def test_spool_candidates_return_newest_valid_file(stream_module: Any, tmp_path: Path) -> None:
    missing_dir = tmp_path / "missing"
    stream_module.YTMUSIC_SPOOL_DIR = missing_dir
    assert stream_module._spool_candidates(VIDEO_ID, QUALITY) == []
    assert stream_module._find_spooled_file(VIDEO_ID, QUALITY) is None

    missing_dir.mkdir()
    oldest = missing_dir / f"{VIDEO_ID}-{QUALITY}.m4a"
    newest = missing_dir / f"{VIDEO_ID}-{QUALITY}.webm"
    zero_byte = missing_dir / f"{VIDEO_ID}-{QUALITY}.aac"
    partial = missing_dir / f"{VIDEO_ID}-{QUALITY}.m4a.part"
    auxiliary = missing_dir / f"{VIDEO_ID}-{QUALITY}.webm.ytdl"
    unrelated = missing_dir / "unrelated.m4a"
    for path, body in (
        (oldest, b"old"),
        (newest, b"new"),
        (zero_byte, b""),
        (partial, b"partial"),
        (auxiliary, b"aux"),
        (unrelated, b"other"),
    ):
        path.write_bytes(body)
    now = time.time()
    os.utime(oldest, (now - 20, now - 20))
    os.utime(newest, (now - 10, now - 10))

    assert stream_module._spool_candidates(VIDEO_ID, QUALITY) == [newest, oldest]
    assert stream_module._find_spooled_file(VIDEO_ID, QUALITY) == newest


def test_spool_candidates_filter_unrelated_names_before_filesystem_metadata(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    matching = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    unrelated = [tmp_path / f"unrelated-{index}.m4a" for index in range(100)]
    matching.write_bytes(b"audio")
    for path in unrelated:
        path.write_bytes(b"other")
    real_is_file = Path.is_file
    metadata_paths: list[Path] = []

    def record_is_file(path: Path) -> bool:
        metadata_paths.append(path)
        return real_is_file(path)

    monkeypatch.setattr(Path, "is_file", record_is_file)

    assert stream_module._spool_candidates(VIDEO_ID, QUALITY) == [matching]
    assert metadata_paths == [matching]


def test_spool_lookup_holds_prune_lock_while_scanning_and_touching(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    path.write_bytes(b"audio")
    lock_state = {"held": False}

    class TrackingLock:
        def __enter__(self) -> None:
            assert not lock_state["held"]
            lock_state["held"] = True

        def __exit__(self, *args: object) -> None:
            lock_state["held"] = False

    def guarded_candidates(video_id: str, quality: str) -> list[Path]:
        assert lock_state["held"]
        return [path]

    def guarded_touch(candidate: Path, times: object) -> None:
        assert candidate == path
        assert times is None
        assert lock_state["held"]

    monkeypatch.setattr(stream_module, "_spool_prune_lock", TrackingLock())
    monkeypatch.setattr(stream_module, "_spool_candidates", guarded_candidates)
    monkeypatch.setattr(stream_module.os, "utime", guarded_touch)

    assert stream_module._find_spooled_file(VIDEO_ID, QUALITY) == path
    assert not lock_state["held"]


def test_prune_spool_evicts_oldest_completed_files(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 12)
    paths = [tmp_path / f"AAAAAAAAAA{index}-{QUALITY}.m4a" for index in range(3)]
    now = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 10
    for index, path in enumerate(paths):
        path.write_bytes(b"123456")
        os.utime(path, (now + index, now + index))

    stream_module._prune_spool()

    assert not paths[0].exists()
    assert paths[1].exists()
    assert paths[2].exists()


def test_prune_spool_honors_exclude(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 12)
    paths = [tmp_path / f"BBBBBBBBBB{index}-{QUALITY}.m4a" for index in range(3)]
    now = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 10
    for index, path in enumerate(paths):
        path.write_bytes(b"123456")
        os.utime(path, (now + index, now + index))

    stream_module._prune_spool(exclude=paths[0])

    assert paths[0].exists()
    assert not paths[1].exists()
    assert paths[2].exists()


def test_prune_spool_removes_only_stale_partials(stream_module: Any, tmp_path: Path) -> None:
    stale_part = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a.part"
    stale_aux = tmp_path / f"{VIDEO_ID}-LOW.webm.ytdl"
    fresh_part = tmp_path / f"{VIDEO_ID}-MEDIUM.m4a.part"
    for path in (stale_part, stale_aux, fresh_part):
        path.write_bytes(b"partial")
    stale_time = time.time() - stream_module._SPOOL_PARTIAL_STALE_SECONDS - 1
    os.utime(stale_part, (stale_time, stale_time))
    os.utime(stale_aux, (stale_time, stale_time))

    stream_module._prune_spool()

    assert not stale_part.exists()
    assert not stale_aux.exists()
    assert fresh_part.exists()


def test_prune_spool_keeps_young_completed_files(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 1)
    path = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    path.write_bytes(b"over budget")

    stream_module._prune_spool()

    assert path.exists()

    old = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 1
    os.utime(path, (old, old))
    stream_module._prune_spool()

    assert not path.exists()


def test_prune_spool_ignores_files_it_does_not_own(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 1)
    owned_completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    owned_partial = tmp_path / f"{VIDEO_ID}-LOW.webm.part"
    unowned_paths = [
        tmp_path / "shared-data.m4a",
        tmp_path / f"{VIDEO_ID}-ULTRA.m4a",
        tmp_path / "shared-data.webm.part",
        tmp_path / f"{VIDEO_ID}-ULTRA.webm.ytdl",
    ]
    for path in (owned_completed, owned_partial, *unowned_paths):
        path.write_bytes(b"shared")
    old = time.time() - stream_module._SPOOL_PARTIAL_STALE_SECONDS - 1
    for path in (owned_completed, owned_partial, *unowned_paths):
        os.utime(path, (old, old))

    total, entries = stream_module._collect_spool_entries()

    assert total == owned_completed.stat().st_size
    assert [entry[2] for entry in entries] == [owned_completed]
    assert not owned_partial.exists()

    stream_module._prune_spool()

    assert not owned_completed.exists()
    assert all(path.exists() for path in unowned_paths)


def test_spool_byte_reservation_counts_pins_and_recovers_after_release(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 10)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 6)
    pinned = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    pinned.write_bytes(b"12345")
    stream_module._pin_spool_path(pinned)

    try:
        with pytest.raises(HTTPException) as full, stream_module._spool_byte_reservation():
            raise AssertionError("a pinned completed spool must consume capacity")
        assert full.value.status_code == 503
        assert stream_module._spool_reserved_bytes == 0
        assert pinned.exists()
    finally:
        stream_module._unpin_spool_path(pinned)

    with stream_module._spool_byte_reservation() as reserved:
        assert reserved == 6
        assert stream_module._spool_reserved_bytes == 6
        assert not pinned.exists()
        with pytest.raises(HTTPException) as overcommitted, stream_module._spool_byte_reservation():
            raise AssertionError("aggregate reservations must stay under the spool cap")
        assert overcommitted.value.status_code == 503

    assert stream_module._spool_reserved_bytes == 0
    with stream_module._spool_byte_reservation():
        assert stream_module._spool_reserved_bytes == 6


def test_spool_download_limit_never_exceeds_total_capacity(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 4)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 10)

    assert stream_module._spool_track_byte_limit() == 4
    hook = stream_module._build_spool_progress_hook(time.monotonic())
    with pytest.raises(RuntimeError, match="4 byte limit"):
        hook({"downloaded_bytes": 5})


def test_spool_formats_prefer_audio_that_fits_the_per_track_budget(
    stream_module: Any,
) -> None:
    selector = stream_module._build_ytmusic_spool_format("HIGH", 64 * 1024 * 1024)

    assert "protocol=m3u8" in selector
    assert "abr<=256" in selector
    assert "filesize_approx<67108865" in selector
    assert "filesize<67108865" in selector
    assert "/wa/" in selector
    assert "b[height<=360]" in selector


def test_music_extraction_keeps_a_low_resolution_combined_fallback(
    stream_module: Any,
) -> None:
    options = stream_module._build_ytmusic_stream_options("HIGH")

    assert options["format"].endswith("/b[height<=360]/b")
    assert options["extractor_args"]["youtube"]["player_client"] == ["default"]


def _mp4_box(kind: bytes, payload: bytes = b"") -> bytes:
    """Build one small top-level ISO BMFF box for prefix validation tests."""
    return (len(payload) + 8).to_bytes(4, "big") + kind + payload


def test_progressive_prefix_requires_a_browser_decodable_start(
    stream_module: Any,
) -> None:
    fast_start_mp4 = _mp4_box(b"ftyp") + _mp4_box(b"moov") + _mp4_box(b"mdat")
    late_moov_mp4 = _mp4_box(b"ftyp") + _mp4_box(b"mdat") + _mp4_box(b"moov")
    progressive_webm = b"\x1aE\xdf\xa3metadata\x1fC\xb6ucluster"

    assert stream_module._progressive_prefix_state(fast_start_mp4, "m4a") == "readable"
    assert stream_module._progressive_prefix_state(late_moov_mp4, "m4a") == "rejected"
    assert stream_module._progressive_prefix_state(progressive_webm, "webm") == "readable"
    assert stream_module._progressive_prefix_state(b"#EXTM3U\n", "m4a") == "rejected"


def test_progressive_source_requires_direct_http_and_owned_container(
    stream_module: Any,
) -> None:
    assert stream_module._progressive_source(
        {"url": "https://rr.example/audio", "protocol": "https", "ext": "webm"}
    ) == ("https://rr.example/audio", "webm", "audio/webm")
    assert (
        stream_module._progressive_source(
            {"url": "https://rr.example/manifest", "protocol": "m3u8_native", "ext": "m4a"}
        )
        is None
    )
    assert (
        stream_module._progressive_source(
            {"url": "https://rr.example/audio", "protocol": "https", "ext": "opus"}
        )
        is None
    )


def test_slim_spool_cache_preserves_progressive_source_identity(stream_module: Any) -> None:
    stream_module._stream_cache.clear()
    info = {
        "duration": 180,
        "protocol": "m3u8_native",
        "ext": "m4a",
        "formats": [
            {
                "url": "https://rr.example/audio",
                "protocol": "https",
                "ext": "webm",
                "audio_ext": "webm",
                "abr": 160,
                "acodec": "opus",
                "vcodec": "none",
            }
        ],
    }

    stream_module._cache_spool_info(VIDEO_ID, QUALITY, info)
    cached = stream_module._get_stream_url_sync("__public__", VIDEO_ID, QUALITY)

    assert cached.keys() == {
        "url",
        "content_type",
        "duration",
        "expires_at",
        "abr",
        "acodec",
        "protocol",
        "ext",
    }
    assert stream_module._progressive_source(cached) == (
        "https://rr.example/audio",
        "webm",
        "audio/webm",
    )


def test_selected_audio_metadata_stays_with_its_fallback_url(stream_module: Any) -> None:
    selected = stream_module._selected_audio_stream(
        {
            "formats": [
                {
                    "url": "https://rr.example/low",
                    "protocol": "https",
                    "ext": "m4a",
                    "abr": 64,
                    "acodec": "mp4a",
                    "vcodec": "none",
                },
                {
                    "url": "https://rr.example/high",
                    "protocol": "https",
                    "ext": "webm",
                    "abr": 160,
                    "acodec": "opus",
                    "vcodec": "none",
                },
            ]
        }
    )

    assert selected is not None
    assert selected["url"] == "https://rr.example/high"
    assert selected["ext"] == "webm"
    assert selected["protocol"] == "https"


@pytest.mark.anyio
async def test_progressive_writer_owns_bytes_and_atomically_completes(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    prefix = b"\x1aE\xdf\xa3metadata\x1fC\xb6ucluster-one"
    tail = b"cluster-two"
    request_options: dict[str, Any] = {}
    real_replace = stream_module.os.replace
    replace_attempts = 0

    class FakeResponse:
        def __init__(self) -> None:
            self.status_code = 200
            self.headers = {
                "Content-Encoding": "identity",
                "Content-Length": str(len(prefix + tail)),
            }

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, *, chunk_size: int) -> Iterator[bytes]:
            assert chunk_size == stream_module._SPOOL_READ_CHUNK_BYTES
            yield prefix
            yield tail

    def get_source(url: str, **options: Any) -> FakeResponse:
        assert url == "https://rr.example/audio"
        request_options.update(options)
        return FakeResponse()

    def replace_with_one_windows_collision(source: Path, destination: Path) -> None:
        nonlocal replace_attempts
        replace_attempts += 1
        if replace_attempts == 1:
            raise PermissionError("simulated reader holding the spool file")
        real_replace(source, destination)

    monkeypatch.setattr(
        stream_module,
        "_get_stream_url_sync",
        lambda *_args: {
            "url": "https://rr.example/audio",
            "protocol": "https",
            "ext": "webm",
        },
    )
    monkeypatch.setattr(stream_module.requests, "get", get_source)
    monkeypatch.setattr(stream_module.os, "replace", replace_with_one_windows_collision)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )

    result = await asyncio.to_thread(
        stream_module._download_progressive_spool_sync,
        VIDEO_ID,
        QUALITY,
        session,
    )
    await asyncio.sleep(0)

    completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.webm"
    assert result is not None
    assert result[:2] == (str(completed), "audio/webm")
    assert completed.read_bytes() == prefix + tail
    assert not (tmp_path / f"{VIDEO_ID}-{QUALITY}.webm.soundspan-part").exists()
    assert session.readable
    assert session.content_length == len(prefix + tail)
    assert request_options["stream"] is True
    assert request_options["headers"]["Accept-Encoding"] == "identity"
    assert "Range" not in request_options["headers"]
    assert replace_attempts == 2
    session.release_pins()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status_code", "declared_length"),
    [(206, 23), (200, 0), (200, -1), (200, 22), (200, 24)],
)
async def test_progressive_writer_rejects_unreliable_total_length(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    status_code: int,
    declared_length: int,
) -> None:
    payload = b"\x1aE\xdf\xa3metadata\x1fC\xb6ucluster"
    upstream = stream_module.requests.Response()
    upstream.status_code = status_code
    upstream.headers["Content-Length"] = str(declared_length)
    upstream._content = payload
    upstream._content_consumed = True
    monkeypatch.setattr(stream_module.requests, "get", lambda *_args, **_kwargs: upstream)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )
    plan = stream_module._ProgressiveSpoolPlan("https://cdn.test/audio", "webm", "audio/webm", {})
    try:
        with pytest.raises(ValueError):
            await asyncio.to_thread(
                stream_module._download_progressive_spool_sync, VIDEO_ID, QUALITY, session, plan
            )
        assert not (tmp_path / f"{VIDEO_ID}-{QUALITY}.webm").exists()
    finally:
        session.release_pins()


@pytest.mark.parametrize("rejected_status", [401, 403, 410])
@pytest.mark.anyio
async def test_cached_progressive_http_rejection_refreshes_once(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    rejected_status: int,
) -> None:
    import requests
    import yt_dlp

    old_url = "https://cdn.test/expired"
    fresh_url = "https://cdn.test/fresh"
    payload = _mp4_box(b"ftyp") + _mp4_box(b"moov") + _mp4_box(b"mdat", b"audio")
    requested_urls: list[str] = []
    extraction_urls: list[str] = []

    class FakeYoutubeDL:
        def __init__(self, _options: dict[str, object]) -> None:
            pass

        def __enter__(self) -> FakeYoutubeDL:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def extract_info(self, url: str, *, download: bool) -> dict[str, object]:
            assert download is False
            extraction_urls.append(url)
            return {"url": fresh_url, "protocol": "https", "ext": "m4a"}

    class FakeResponse:
        def __init__(self, url: str) -> None:
            self.url = url
            self.status_code = rejected_status if url == old_url else 200
            self.headers = {
                "Content-Encoding": "identity",
                "Content-Length": str(len(payload)),
            }

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            if self.status_code != 200:
                raise requests.HTTPError(
                    f"HTTP {self.status_code}",
                    response=cast(Any, self),
                )

        def iter_content(self, *, chunk_size: int) -> Iterator[bytes]:
            assert chunk_size == stream_module._SPOOL_READ_CHUNK_BYTES
            yield payload

    def get_source(url: str, **_options: Any) -> FakeResponse:
        requested_urls.append(url)
        return FakeResponse(url)

    cache_key = f"music:{VIDEO_ID}:{QUALITY}"
    stream_module._stream_cache.clear()
    stream_module._stream_cache[cache_key] = {
        "url": old_url,
        "protocol": "https",
        "ext": "m4a",
        "expires_at": time.time() + 3600,
    }
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)
    monkeypatch.setattr(stream_module._extract_pacer, "wait", lambda: None)
    monkeypatch.setattr(stream_module.requests, "get", get_source)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )
    stream_module._spool_cancel_events[session.key] = session.cancel_event
    try:
        result = await stream_module._download_ytmusic_spool_bounded(
            VIDEO_ID,
            QUALITY,
            session=session,
        )
    finally:
        stream_module._spool_cancel_events.pop(session.key, None)
        session.release_pins()

    completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    assert result == (str(completed), "audio/mp4")
    assert completed.read_bytes() == payload
    assert requested_urls == [old_url, fresh_url]
    assert extraction_urls == [f"https://music.youtube.com/watch?v={VIDEO_ID}"]
    assert stream_module._stream_cache[cache_key]["url"] == fresh_url
    stream_module._stream_cache.clear()


@pytest.mark.anyio
async def test_progressive_source_refresh_is_bounded_to_one_retry(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old_url = "https://cdn.test/expired"
    fresh_url = "https://cdn.test/still-rejected"
    cache_key = f"music:{VIDEO_ID}:{QUALITY}"
    stream_module._stream_cache.clear()
    stream_module._stream_cache[cache_key] = {
        "url": old_url,
        "expires_at": time.time() + 3600,
    }
    resolved_urls: list[str] = []
    transferred_urls: list[str] = []

    def resolve(_video_id: str, _quality: str, _session: Any) -> Any:
        stream_url = old_url if not resolved_urls else fresh_url
        resolved_urls.append(stream_url)
        info = {"url": stream_url, "protocol": "https", "ext": "m4a"}
        if stream_url == fresh_url:
            stream_module._stream_cache[cache_key] = {
                **info,
                "expires_at": time.time() + 3600,
            }
        return stream_module._ProgressiveSpoolPlan(
            stream_url,
            "m4a",
            "audio/mp4",
            info,
        )

    def reject_transfer(
        _video_id: str,
        _quality: str,
        _session: Any,
        plan: Any,
        _progressive_only: bool,
    ) -> tuple[str, str]:
        transferred_urls.append(plan.stream_url)
        raise stream_module._ProgressiveSourceRefreshRequired(plan.stream_url, 403)

    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", resolve)
    monkeypatch.setattr(stream_module, "_run_spool_download_sync", reject_transfer)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )

    with pytest.raises(HTTPException) as rejected:
        await stream_module._download_ytmusic_spool_bounded(
            VIDEO_ID,
            QUALITY,
            session=session,
        )

    assert rejected.value.status_code == 502
    assert resolved_urls == [old_url, fresh_url]
    assert transferred_urls == [old_url, fresh_url]
    assert cache_key not in stream_module._stream_cache


@pytest.mark.anyio
async def test_non_refreshable_progressive_http_error_keeps_cached_url(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import requests

    cached_url = "https://cdn.test/not-found"
    cache_key = f"music:{VIDEO_ID}:{QUALITY}"
    stream_module._stream_cache.clear()
    stream_module._stream_cache[cache_key] = {
        "url": cached_url,
        "protocol": "https",
        "ext": "m4a",
        "expires_at": time.time() + 3600,
    }
    requested_urls: list[str] = []

    class NotFoundResponse:
        status_code = 404

        def __init__(self) -> None:
            self.headers: dict[str, str] = {}

        def __enter__(self) -> NotFoundResponse:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            raise requests.HTTPError("HTTP 404", response=cast(Any, self))

    def get_source(url: str, **_options: Any) -> NotFoundResponse:
        requested_urls.append(url)
        return NotFoundResponse()

    monkeypatch.setattr(stream_module.requests, "get", get_source)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )

    with pytest.raises(HTTPException) as rejected:
        await stream_module._download_ytmusic_spool_bounded(
            VIDEO_ID,
            QUALITY,
            session=session,
        )

    assert rejected.value.status_code == 502
    assert requested_urls == [cached_url]
    assert stream_module._stream_cache[cache_key]["url"] == cached_url
    stream_module._stream_cache.clear()


def test_progressive_cache_invalidation_preserves_concurrent_refresh(stream_module: Any) -> None:
    cache_key = f"music:{VIDEO_ID}:{QUALITY}"
    fresh_url = "https://cdn.test/concurrent-fresh"
    stream_module._stream_cache.clear()
    stream_module._stream_cache[cache_key] = {
        "url": fresh_url,
        "expires_at": time.time() + 3600,
    }

    invalidated = stream_module._invalidate_music_stream_url(
        VIDEO_ID,
        QUALITY,
        "https://cdn.test/expired",
    )

    assert invalidated is False
    assert stream_module._stream_cache[cache_key]["url"] == fresh_url
    stream_module._stream_cache.clear()


@pytest.mark.anyio
async def test_cancelled_progressive_refresh_never_opens_second_cdn(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    old_url = "https://cdn.test/expired"
    cache_key = f"music:{VIDEO_ID}:{QUALITY}"
    stream_module._stream_cache.clear()
    stream_module._stream_cache[cache_key] = {
        "url": old_url,
        "expires_at": time.time() + 3600,
    }
    budget = ExtractionBudget(1)
    blocker_started = threading.Event()
    release_blocker = threading.Event()
    invalidated = threading.Event()
    resolve_calls = 0
    transfer_calls = 0
    blocker_executor = ThreadPoolExecutor(max_workers=1)
    blocker_future: Future[None] | None = None
    real_invalidate = stream_module._invalidate_music_stream_url

    def resolve(_video_id: str, _quality: str, _session: Any) -> Any:
        nonlocal resolve_calls
        resolve_calls += 1
        info = {"url": old_url, "protocol": "https", "ext": "m4a"}
        return stream_module._ProgressiveSpoolPlan(
            old_url,
            "m4a",
            "audio/mp4",
            info,
        )

    def reject_transfer(*_args: Any) -> tuple[str, str]:
        nonlocal transfer_calls
        transfer_calls += 1
        raise stream_module._ProgressiveSourceRefreshRequired(old_url, 403)

    def hold_provider_slot() -> None:
        blocker_started.set()
        if not release_blocker.wait(timeout=2):
            raise TimeoutError("test provider blocker was not released")

    def invalidate_and_block(video_id: str, quality: str, failed_url: str) -> bool:
        nonlocal blocker_future
        result = bool(real_invalidate(video_id, quality, failed_url))
        blocker_future = blocker_executor.submit(budget.run, hold_provider_slot, playback=True)
        assert blocker_started.wait(timeout=1)
        invalidated.set()
        return result

    monkeypatch.setattr(stream_module, "_extraction_budget", budget)
    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", resolve)
    monkeypatch.setattr(stream_module, "_run_spool_download_sync", reject_transfer)
    monkeypatch.setattr(stream_module, "_invalidate_music_stream_url", invalidate_and_block)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )
    stream_module._spool_cancel_events[session.key] = session.cancel_event
    task = asyncio.create_task(
        stream_module._download_ytmusic_spool_bounded(
            VIDEO_ID,
            QUALITY,
            session=session,
        )
    )
    try:
        assert await asyncio.to_thread(invalidated.wait, 1)
        for _ in range(100):
            with budget._condition:
                if budget._priority_waiters[2]:
                    break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("refreshed resolve did not queue behind the occupied provider slot")
        session.cancel_event.set()
        release_blocker.set()
        with pytest.raises(HTTPException) as cancelled:
            await asyncio.wait_for(task, timeout=2)
    finally:
        release_blocker.set()
        if blocker_future is not None:
            blocker_future.result(timeout=2)
        blocker_executor.shutdown(wait=True, cancel_futures=True)
        stream_module._spool_cancel_events.pop(session.key, None)
        stream_module._stream_cache.clear()

    assert cancelled.value.status_code == 499
    assert resolve_calls == 1
    assert transfer_calls == 1


@pytest.mark.anyio
async def test_slow_progressive_cdn_does_not_hold_heavy_extraction_slot(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    first_video_id = "slowcdn0001"
    second_video_id = "slowcdn0002"
    first_cdn_started = threading.Event()
    release_first_cdn = threading.Event()
    second_resolved = threading.Event()
    payload = _mp4_box(b"ftyp") + _mp4_box(b"moov") + _mp4_box(b"mdat", b"audio")

    class FakeResponse:
        def __init__(self, video_id: str) -> None:
            self.video_id = video_id
            self.status_code = 200
            self.headers = {
                "Content-Encoding": "identity",
                "Content-Length": str(len(payload)),
            }

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, *, chunk_size: int) -> Iterator[bytes]:
            assert chunk_size == stream_module._SPOOL_READ_CHUNK_BYTES
            if self.video_id == first_video_id:
                first_cdn_started.set()
                if not release_first_cdn.wait(timeout=2):
                    raise TimeoutError("test slow CDN was not released")
            yield payload

    def resolve_source(_user_id: str, video_id: str, _quality: str) -> dict[str, object]:
        if video_id == second_video_id:
            second_resolved.set()
        return {
            "url": f"https://cdn.test/{video_id}",
            "protocol": "https",
            "ext": "m4a",
        }

    def get_source(url: str, **_options: Any) -> FakeResponse:
        return FakeResponse(url.rsplit("/", 1)[-1])

    monkeypatch.setattr(stream_module, "_extraction_budget", ExtractionBudget(1))
    monkeypatch.setattr(stream_module, "_get_stream_url_sync", resolve_source)
    monkeypatch.setattr(stream_module.requests, "get", get_source)

    first = stream_module._create_spool_task(f"{first_video_id}:{QUALITY}", first_video_id, QUALITY)
    assert await asyncio.to_thread(first_cdn_started.wait, 1)
    second = stream_module._create_spool_task(
        f"{second_video_id}:{QUALITY}", second_video_id, QUALITY
    )
    stream_module._yt_dlp_spool_executor.wake_loop_on_completion(asyncio.get_running_loop())

    resolved_while_first_cdn_was_blocked = await asyncio.to_thread(second_resolved.wait, 0.2)
    release_first_cdn.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=2)

    assert resolved_while_first_cdn_was_blocked, (
        "a slow progressive CDN body held the only heavy extraction slot"
    )


@pytest.mark.anyio
async def test_two_preloads_leave_a_provider_slot_for_current_playback(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    first_preload = "preload00001"
    second_preload = "preload00002"
    current = "current00001"
    release_first = threading.Event()
    first_started = threading.Event()
    current_started = threading.Event()

    def resolve_source(video_id: str, _quality: str, _session: Any) -> object:
        if video_id == first_preload:
            first_started.set()
            if not release_first.wait(timeout=2):
                raise TimeoutError("test provider resolve was not released")
        elif video_id == current:
            current_started.set()
        return object()

    monkeypatch.setattr(stream_module, "_extraction_budget", ExtractionBudget(2))
    monkeypatch.setattr(stream_module, "_spool_transfer_budget", ExtractionBudget(2))
    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", resolve_source)
    monkeypatch.setattr(
        stream_module,
        "_run_spool_download_sync",
        lambda video_id, *_args: (f"{video_id}.m4a", "audio/mp4"),
    )
    extraction_executor = ThreadPoolExecutor(max_workers=3)
    transfer_executor = ThreadPoolExecutor(max_workers=3)
    monkeypatch.setattr(stream_module, "_yt_dlp_spool_executor", extraction_executor)
    monkeypatch.setattr(stream_module, "_spool_transfer_executor", transfer_executor)

    first = stream_module._create_spool_task(
        f"{first_preload}:{QUALITY}",
        first_preload,
        QUALITY,
        purpose="preload",
    )
    second = stream_module._create_spool_task(
        f"{second_preload}:{QUALITY}",
        second_preload,
        QUALITY,
        purpose="preload",
    )
    interactive: asyncio.Task[tuple[str, str]] | None = None
    try:
        assert await asyncio.to_thread(first_started.wait, 1)
        for _ in range(100):
            with stream_module._extraction_budget._condition:
                if stream_module._extraction_budget._priority_waiters[1]:
                    break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("second preload did not reach the provider budget queue")

        interactive = stream_module._create_spool_task(
            f"{current}:{QUALITY}",
            current,
            QUALITY,
            purpose="interactive",
        )
        assert await asyncio.to_thread(current_started.wait, 1), (
            "speculative resolves consumed the slot reserved for current playback"
        )
    finally:
        release_first.set()
        tasks = [first, second]
        if interactive is not None:
            tasks.append(interactive)
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)
        extraction_executor.shutdown(wait=True, cancel_futures=True)
        transfer_executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.anyio
async def test_two_preloads_leave_a_transfer_slot_for_current_playback(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    first_preload = "preload00001"
    second_preload = "preload00002"
    current = "current00001"
    release_first = threading.Event()
    first_started = threading.Event()
    second_resolved = threading.Event()
    second_started = threading.Event()
    current_started = threading.Event()

    def resolve_source(video_id: str, _quality: str, _session: Any) -> object:
        if video_id == second_preload:
            second_resolved.set()
        return object()

    def transfer(video_id: str, *_args: Any) -> tuple[str, str]:
        if video_id == first_preload:
            first_started.set()
            if not release_first.wait(timeout=2):
                raise TimeoutError("test progressive transfer was not released")
        elif video_id == second_preload:
            second_started.set()
        elif video_id == current:
            current_started.set()
        return f"{video_id}.m4a", "audio/mp4"

    monkeypatch.setattr(stream_module, "_extraction_budget", ExtractionBudget(2))
    monkeypatch.setattr(stream_module, "_spool_transfer_budget", ExtractionBudget(2))
    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", resolve_source)
    monkeypatch.setattr(stream_module, "_run_spool_download_sync", transfer)
    extraction_executor = ThreadPoolExecutor(max_workers=3)
    transfer_executor = ThreadPoolExecutor(max_workers=3)
    monkeypatch.setattr(stream_module, "_yt_dlp_spool_executor", extraction_executor)
    monkeypatch.setattr(stream_module, "_spool_transfer_executor", transfer_executor)

    first = stream_module._create_spool_task(
        f"{first_preload}:{QUALITY}",
        first_preload,
        QUALITY,
        purpose="preload",
    )
    second: asyncio.Task[tuple[str, str]] | None = None
    interactive: asyncio.Task[tuple[str, str]] | None = None
    try:
        assert await asyncio.to_thread(first_started.wait, 1)
        second = stream_module._create_spool_task(
            f"{second_preload}:{QUALITY}",
            second_preload,
            QUALITY,
            purpose="preload",
        )
        assert await asyncio.to_thread(second_resolved.wait, 1)
        for _ in range(100):
            with stream_module._spool_transfer_budget._condition:
                if stream_module._spool_transfer_budget._priority_waiters[1]:
                    break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("second preload did not reach the transfer budget queue")

        interactive = stream_module._create_spool_task(
            f"{current}:{QUALITY}",
            current,
            QUALITY,
            purpose="interactive",
        )
        assert await asyncio.to_thread(current_started.wait, 1), (
            "speculative CDN transfers consumed the slot reserved for current playback"
        )
        assert not second_started.is_set()
    finally:
        release_first.set()
        tasks = [first]
        if second is not None:
            tasks.append(second)
        if interactive is not None:
            tasks.append(interactive)
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)
        extraction_executor.shutdown(wait=True, cancel_futures=True)
        transfer_executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.anyio
async def test_cancelled_progressive_transfer_does_not_open_cdn_after_queue_wait(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    first_video_id = "blockercdn1"
    second_video_id = "cancelcdn01"
    first_cdn_started = threading.Event()
    release_first_cdn = threading.Event()
    second_resolved = threading.Event()
    cdn_calls: list[str] = []
    payload = _mp4_box(b"ftyp") + _mp4_box(b"moov") + _mp4_box(b"mdat", b"audio")

    class FakeResponse:
        def __init__(self, video_id: str) -> None:
            self.video_id = video_id
            self.status_code = 200
            self.headers = {
                "Content-Encoding": "identity",
                "Content-Length": str(len(payload)),
            }

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, *, chunk_size: int) -> Iterator[bytes]:
            assert chunk_size == stream_module._SPOOL_READ_CHUNK_BYTES
            if self.video_id == first_video_id:
                first_cdn_started.set()
                if not release_first_cdn.wait(timeout=2):
                    raise TimeoutError("test slow CDN was not released")
            yield payload

    def resolve_source(_user_id: str, video_id: str, _quality: str) -> dict[str, object]:
        if video_id == second_video_id:
            second_resolved.set()
        return {
            "url": f"https://cdn.test/{video_id}",
            "protocol": "https",
            "ext": "m4a",
        }

    def get_source(url: str, **_options: Any) -> FakeResponse:
        video_id = url.rsplit("/", 1)[-1]
        cdn_calls.append(video_id)
        return FakeResponse(video_id)

    transfer_executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(stream_module, "_spool_transfer_executor", transfer_executor, raising=False)
    monkeypatch.setattr(stream_module, "_extraction_budget", ExtractionBudget(1))
    monkeypatch.setattr(stream_module, "_get_stream_url_sync", resolve_source)
    monkeypatch.setattr(stream_module.requests, "get", get_source)

    first = stream_module._create_spool_task(f"{first_video_id}:{QUALITY}", first_video_id, QUALITY)
    try:
        assert await asyncio.to_thread(first_cdn_started.wait, 1)
        second = stream_module._create_spool_task(
            f"{second_video_id}:{QUALITY}", second_video_id, QUALITY
        )
        resolved_before_first_transfer_finished = await asyncio.to_thread(second_resolved.wait, 0.2)
        stream_module._spool_sessions[f"{second_video_id}:{QUALITY}"].cancel_event.set()
        release_first_cdn.set()

        assert await asyncio.wait_for(first, timeout=2)
        with pytest.raises(HTTPException) as cancelled:
            await asyncio.wait_for(second, timeout=2)
    finally:
        release_first_cdn.set()
        transfer_executor.shutdown(wait=True, cancel_futures=True)

    assert resolved_before_first_transfer_finished
    assert cancelled.value.status_code == 499
    assert cdn_calls == [first_video_id]


def test_read_spool_chunk_retries_transient_windows_rename_collision(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "growing.webm.soundspan-part"
    path.write_bytes(b"progressive-audio")
    real_open = Path.open
    attempts = 0
    sleeps: list[float] = []

    def open_after_two_collisions(candidate: Path, *args: Any, **kwargs: Any) -> Any:
        nonlocal attempts
        if candidate == path:
            attempts += 1
            if attempts < 3:
                raise PermissionError("simulated atomic-replace collision")
        return real_open(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_after_two_collisions)
    monkeypatch.setattr(stream_module.time, "sleep", sleeps.append)

    assert stream_module._read_spool_chunk(path, 0) == b"progressive-audio"
    assert attempts == 3
    assert sleeps == [
        stream_module._SPOOL_RENAME_RETRY_SECONDS,
        stream_module._SPOOL_RENAME_RETRY_SECONDS,
    ]


def test_read_spool_chunk_surfaces_persistent_permission_error(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "growing.webm.soundspan-part"
    path.write_bytes(b"progressive-audio")
    attempts = 0

    def always_collides(_candidate: Path, *_args: Any, **_kwargs: Any) -> Any:
        nonlocal attempts
        attempts += 1
        raise PermissionError("persistent reader failure")

    monkeypatch.setattr(Path, "open", always_collides)
    monkeypatch.setattr(stream_module.time, "sleep", lambda _seconds: None)

    with pytest.raises(PermissionError, match="persistent reader failure"):
        stream_module._read_spool_chunk(path, 0)
    assert attempts == stream_module._SPOOL_RENAME_MAX_ATTEMPTS


@pytest.mark.anyio
async def test_growing_spool_reads_final_path_when_rename_wins_read_race(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    partial = tmp_path / f"{VIDEO_ID}-{QUALITY}.webm.soundspan-part"
    completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.webm"
    completed.write_bytes(b"complete-audio")
    task: asyncio.Future[tuple[str, str]] = asyncio.get_running_loop().create_future()
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )
    session.partial_path = partial
    session.readable = True
    session.content_type = "audio/webm"
    session.task = task
    lease = stream_module._SpoolLease(session.key, task, session.cancel_event, session)
    reads: list[Path] = []

    def read_during_rename(path: Path, offset: int) -> bytes:
        reads.append(path)
        if path == partial:
            task.set_result((str(completed), "audio/webm"))
            return b""
        return completed.read_bytes() if offset == 0 else b""

    monkeypatch.setattr(stream_module, "_read_spool_chunk", read_during_rename)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

    body = b"".join(
        [chunk async for chunk in stream_module._stream_growing_spool(session, task, lease)]
    )

    assert body == b"complete-audio"
    assert reads == [partial, completed, completed]
    assert lease.closed


@pytest.mark.anyio
async def test_worker_publish_cannot_leak_pin_during_session_cleanup(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "growing.webm.soundspan-part"
    pin_started = threading.Event()
    allow_pin = threading.Event()
    real_pin = stream_module._pin_spool_path

    def delayed_pin(candidate: Path) -> None:
        pin_started.set()
        assert allow_pin.wait(timeout=1)
        real_pin(candidate)

    monkeypatch.setattr(stream_module, "_pin_spool_path", delayed_pin)
    session = stream_module._SpoolSession(
        f"{VIDEO_ID}:{QUALITY}",
        asyncio.get_running_loop(),
        threading.Event(),
        allow_growing=True,
    )

    pin_task = asyncio.create_task(asyncio.to_thread(session.pin_path, path))
    assert await asyncio.to_thread(pin_started.wait, 1)
    cleanup_task = asyncio.create_task(asyncio.to_thread(session.release_pins))
    await asyncio.sleep(0.01)
    allow_pin.set()
    await asyncio.gather(pin_task, cleanup_task)

    assert path not in stream_module._spool_pinned_paths
    assert path not in stream_module._spool_pin_counts


def test_spool_progress_hook_stops_an_abandoned_download(
    stream_module: Any,
) -> None:
    cancelled = threading.Event()
    hook = stream_module._build_spool_progress_hook(
        time.monotonic(),
        cancelled,
    )
    cancelled.set()

    with pytest.raises(stream_module._SpoolDownloadCancelled):
        hook({"downloaded_bytes": 1024})


@pytest.mark.anyio
async def test_last_disconnected_waiter_cancels_abandoned_spool(
    stream_module: Any,
) -> None:
    key = f"{VIDEO_ID}:{QUALITY}"
    cancel_event = threading.Event()
    stream_module._spool_cancel_events[key] = cancel_event
    pending: asyncio.Future[tuple[str, str]] = asyncio.get_running_loop().create_future()

    class DisconnectedRequest:
        async def is_disconnected(self) -> bool:
            return True

    with pytest.raises(HTTPException) as raised:
        await stream_module._await_spool_task_for_request(
            key,
            pending,
            DisconnectedRequest(),
        )

    assert raised.value.status_code == 499
    assert cancel_event.is_set()
    assert stream_module._spool_waiters == {}
    pending.cancel()


@pytest.mark.anyio
async def test_completed_spool_waiter_does_not_revoke_worker_cancellation(
    stream_module: Any,
) -> None:
    key = f"{VIDEO_ID}:{QUALITY}"
    cancel_event = threading.Event()
    cancel_event.set()
    stream_module._spool_cancel_events[key] = cancel_event
    completed: asyncio.Future[tuple[str, str]] = asyncio.get_running_loop().create_future()
    completed.set_result(("track.m4a", "audio/mp4"))

    class ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    result = await stream_module._await_spool_task_for_request(
        key,
        completed,
        ConnectedRequest(),
    )

    assert result == ("track.m4a", "audio/mp4")
    assert cancel_event.is_set()
    assert stream_module._spool_waiters == {}


@pytest.mark.anyio
async def test_one_disconnected_waiter_does_not_cancel_shared_spool(
    stream_module: Any,
) -> None:
    key = f"{VIDEO_ID}:{QUALITY}"
    cancel_event = threading.Event()
    stream_module._spool_cancel_events[key] = cancel_event
    pending: asyncio.Future[tuple[str, str]] = asyncio.get_running_loop().create_future()

    class ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    class DisconnectedRequest:
        async def is_disconnected(self) -> bool:
            return True

    connected = asyncio.create_task(
        stream_module._await_spool_task_for_request(
            key,
            pending,
            ConnectedRequest(),
        ),
    )
    await asyncio.sleep(0)

    with pytest.raises(HTTPException) as raised:
        await stream_module._await_spool_task_for_request(
            key,
            pending,
            DisconnectedRequest(),
        )

    assert raised.value.status_code == 499
    assert stream_module._spool_waiters == {key: 1}
    assert not cancel_event.is_set()

    pending.set_result(("track.m4a", "audio/mp4"))
    assert await connected == ("track.m4a", "audio/mp4")
    assert stream_module._spool_waiters == {}


@pytest.mark.anyio
async def test_cancelled_request_cleans_up_its_waiter_task(
    stream_module: Any,
) -> None:
    key = f"{VIDEO_ID}:{QUALITY}"
    cancel_event = threading.Event()
    stream_module._spool_cancel_events[key] = cancel_event
    pending: asyncio.Future[tuple[str, str]] = asyncio.get_running_loop().create_future()

    class ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    request_task = asyncio.create_task(
        stream_module._await_spool_task_for_request(
            key,
            pending,
            ConnectedRequest(),
        ),
    )
    await asyncio.sleep(0)

    request_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request_task

    assert not pending.cancelled()
    assert not pending.done()
    assert cancel_event.is_set()
    assert stream_module._spool_waiters == {}
    pending.cancel()


def test_provider_challenge_maps_to_retryable_503_and_arms_cooldown(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    error = stream_module._stream_extraction_http_error(
        VIDEO_ID,
        "yt-dlp test extraction",
        RuntimeError("Sign in to confirm you're not a bot"),
    )

    assert error.status_code == 503
    assert error.detail == {
        "error": "provider_challenge",
        "message": "YouTube Music temporarily requires verification. Retry later.",
        "video_id": VIDEO_ID,
    }
    assert int(error.headers["Retry-After"]) > 0
    with pytest.raises(HTTPException) as raised:
        stream_module._raise_if_provider_challenge_cooldown(VIDEO_ID)
    assert raised.value.status_code == 503


def test_cached_spool_remains_available_during_provider_challenge_cooldown(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cached = tmp_path / f"{VIDEO_ID}-{QUALITY}.webm"
    cached.write_bytes(b"cached-audio")
    stream_module._provider_challenge_cooldown_until = time.monotonic() + 90

    class UnexpectedYoutubeDL:
        def __init__(self, _options: dict[str, Any]) -> None:
            raise AssertionError("cached spool must bypass provider extraction")

    import yt_dlp

    monkeypatch.setattr(yt_dlp, "YoutubeDL", UnexpectedYoutubeDL)

    assert stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY) == (
        str(cached),
        "audio/webm",
    )


def test_spool_progress_hook_rejects_oversized_download(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 10)
    hook = stream_module._build_spool_progress_hook(time.monotonic())

    with pytest.raises(Exception, match="downloaded bytes"):
        hook({"downloaded_bytes": 11})


def test_spool_progress_hook_rejects_elapsed_timeout(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT", 0.1)
    hook = stream_module._build_spool_progress_hook(time.monotonic() - 1)

    with pytest.raises(Exception, match="download timeout"):
        hook({"downloaded_bytes": 0})


def test_spool_progress_hook_allows_progress_under_limits(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 10)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT", 10)
    hook = stream_module._build_spool_progress_hook(time.monotonic())

    hook({"downloaded_bytes": 10})


def test_sync_spool_options_reject_live_streams(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import yt_dlp

    captured_options: dict[str, Any] = {}

    class CapturingYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            captured_options.update(options)

        def __enter__(self) -> CapturingYoutubeDL:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
            raise RuntimeError("stop after capturing options")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", CapturingYoutubeDL)

    with pytest.raises(HTTPException):
        stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    match_filter = captured_options["match_filter"]
    assert callable(match_filter)
    live_rejection = match_filter({"is_live": True, "title": "Live stream"})
    assert isinstance(live_rejection, str)
    assert live_rejection
    assert match_filter({"is_live": False, "title": "Recorded track"}) is None
    assert len(captured_options["progress_hooks"]) == 1
    assert captured_options["noprogress"] is True
    assert captured_options["concurrent_fragment_downloads"] == 4


def test_sync_spool_deletes_completed_file_over_total_budget(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import yt_dlp

    completed = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 4)

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            self.options = options

        def __enter__(self) -> FakeYoutubeDL:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
            completed.write_bytes(b"12345")
            return {"id": VIDEO_ID}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)

    with pytest.raises(HTTPException):
        stream_module._download_ytmusic_spool_sync(VIDEO_ID, QUALITY)

    assert not completed.exists()


@pytest.mark.anyio
async def test_concurrent_spool_requests_share_one_download(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    calls = 0
    lookups = 0
    to_thread_calls = 0
    expected = (str(tmp_path / "track.m4a"), "audio/mp4")

    async def run_inline(function: Callable[..., Any], *args: Any) -> Any:
        nonlocal to_thread_calls
        to_thread_calls += 1
        return function(*args)

    def find_spool(video_id: str, quality: str) -> None:
        nonlocal lookups
        lookups += 1

    def slow_download(video_id: str, quality: str) -> tuple[str, str]:
        nonlocal calls
        calls += 1
        _signal_async_event(loop, started)
        if not release.wait(timeout=2):
            raise HTTPException(status_code=500, detail="test release timed out")
        return expected

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", slow_download)
    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", lambda *_args: None)
    monkeypatch.setattr(stream_module, "_find_spooled_file", find_spool)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", run_inline)
    first = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
    try:
        await _await_async_event(started)
        stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
        second = asyncio.create_task(stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY))
        await asyncio.sleep(0)
        assert lookups == 1
        assert to_thread_calls == 1
        assert calls == 1
    finally:
        release.set()

    for _ in range(200):
        if first.done() and second.done():
            break
        await asyncio.sleep(0.01)
    assert first.done()
    assert second.done()
    first_result, second_result = await asyncio.gather(first, second)
    assert first_result == expected
    assert second_result == expected
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_spool_queue_rejects_new_key_but_joins_existing_task(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    download = GatedSpoolDownload()
    monkeypatch.setattr(
        stream_module,
        "_download_ytmusic_spool_bounded",
        download,
    )
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)
    await _assert_spool_task_completion_lifecycle(stream_module, download)
    download.reset()
    capacity_tasks = [
        stream_module._create_spool_task(f"video-{index}:HIGH", f"video-{index}", "HIGH")
        for index in range(stream_module._SPOOL_MAX_PENDING_JOBS)
    ]
    assert stream_module._spool_pending_jobs == stream_module._SPOOL_MAX_PENDING_JOBS
    existing_waiter = await _start_same_key_waiter(stream_module, monkeypatch, capacity_tasks)
    assert stream_module._spool_pending_jobs == stream_module._SPOOL_MAX_PENDING_JOBS
    cached_path, lookup_counts = _install_preflight_miss(stream_module, monkeypatch, tmp_path)
    assert await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, "LOW") == (
        str(cached_path),
        "audio/mp4",
    )
    assert lookup_counts[f"{VIDEO_ID}:LOW"] == 2

    with pytest.raises(HTTPException) as raised:
        await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, "MEDIUM")
    assert raised.value.status_code == 503
    assert raised.value.detail == "YouTube Music spool queue is full"
    assert lookup_counts[f"{VIDEO_ID}:MEDIUM"] == 2

    download.release.set()
    completed = await asyncio.gather(*capacity_tasks)
    assert await existing_waiter == completed[0]
    assert stream_module._spool_pending_jobs == 0
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_background_spools_cannot_consume_interactive_admission_reserve(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    download = GatedSpoolDownload()
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    tasks: list[asyncio.Task[tuple[str, str]]] = []
    extra_preload: asyncio.Task[tuple[str, str]] | None = None
    try:
        tasks.extend(
            stream_module._create_spool_task(
                f"preload-{index}:HIGH",
                f"preload-{index}",
                "HIGH",
                purpose="preload",
            )
            for index in range(stream_module._SPOOL_MAX_PENDING_JOBS - 1)
        )
        with pytest.raises(HTTPException) as full:
            extra_preload = stream_module._create_spool_task(
                "preload-extra:HIGH",
                "preload-extra",
                "HIGH",
                purpose="preload",
            )
        assert full.value.status_code == 503

        current = stream_module._create_spool_task(
            "current:HIGH",
            "current",
            "HIGH",
            purpose="interactive",
        )
        tasks.append(current)
        assert stream_module._spool_pending_jobs == stream_module._SPOOL_MAX_PENDING_JOBS
    finally:
        if extra_preload is not None:
            tasks.append(extra_preload)
        download.release.set()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    assert stream_module._spool_pending_jobs == 0
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_interactive_join_promotes_preload_and_releases_background_admission(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    download = GatedSpoolDownload()
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    tasks = [
        stream_module._create_spool_task(
            f"preload-{index}:HIGH",
            f"preload-{index}",
            "HIGH",
            purpose="preload",
        )
        for index in range(stream_module._SPOOL_MAX_BACKGROUND_PENDING_JOBS)
    ]
    joined = asyncio.create_task(
        stream_module._get_ytmusic_spooled_stream(
            "preload-0",
            "HIGH",
            purpose="interactive",
        )
    )
    extra: asyncio.Task[tuple[str, str]] | None = None
    try:
        await asyncio.sleep(0)
        assert stream_module._spool_background_pending_jobs == (
            stream_module._SPOOL_MAX_BACKGROUND_PENDING_JOBS - 1
        )
        extra = stream_module._create_spool_task(
            "preload-extra:HIGH",
            "preload-extra",
            "HIGH",
            purpose="preload",
        )
        tasks.append(extra)
        assert stream_module._spool_pending_jobs == stream_module._SPOOL_MAX_PENDING_JOBS
        assert (
            stream_module._spool_background_pending_jobs
            == stream_module._SPOOL_MAX_BACKGROUND_PENDING_JOBS
        )
    finally:
        download.release.set()
        await asyncio.gather(*tasks, joined, return_exceptions=True)

    assert stream_module._spool_pending_jobs == 0
    assert stream_module._spool_background_pending_jobs == 0


@pytest.mark.anyio
async def test_failed_spool_request_uses_short_scoped_cooldown_then_recovers(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0
    should_fail = True

    async def failed_download(
        video_id: str,
        quality: str,
        *,
        playback: bool = True,
        session: Any | None = None,
    ) -> tuple[str, str]:
        _ = video_id, quality, playback, session
        nonlocal calls
        calls += 1
        if should_fail:
            raise HTTPException(status_code=502, detail="download failed")
        return ("recovered.m4a", "audio/mp4")

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", failed_download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)
    monkeypatch.setattr(stream_module, "_SPOOL_TRANSIENT_FAILURE_COOLDOWN_SECONDS", 0.02)

    with pytest.raises(HTTPException, match="download failed"):
        await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY)
    await asyncio.sleep(0)
    assert stream_module._spool_tasks == {}

    with pytest.raises(HTTPException, match="download failed") as cached:
        await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY)
    assert cached.value.status_code == 502
    assert calls == 1

    with pytest.raises(HTTPException, match="download failed"):
        await stream_module._get_ytmusic_spooled_stream(
            VIDEO_ID,
            QUALITY,
            purpose="analysis",
        )
    assert calls == 2

    await asyncio.sleep(0.03)
    should_fail = False
    assert await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY) == (
        "recovered.m4a",
        "audio/mp4",
    )
    await asyncio.sleep(0)
    assert calls == 3
    assert stream_module._spool_tasks == {}
    assert stream_module._spool_failure_cache == {}


def test_spool_failure_cooldown_key_includes_provider_quality_and_purpose(
    stream_module: Any,
) -> None:
    base = stream_module._spool_failure_key(
        VIDEO_ID,
        QUALITY,
        "interactive",
        provider_identity="public-spool",
    )

    assert base != stream_module._spool_failure_key(
        VIDEO_ID,
        "LOW",
        "interactive",
        provider_identity="public-spool",
    )
    assert base != stream_module._spool_failure_key(
        VIDEO_ID,
        QUALITY,
        "preload",
        provider_identity="public-spool",
    )
    assert base != stream_module._spool_failure_key(
        VIDEO_ID,
        QUALITY,
        "interactive",
        provider_identity="authenticated-spool",
    )


def test_spool_failure_cooldown_is_bounded_and_excludes_auth_or_client_abort(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(stream_module, "_SPOOL_FAILURE_CACHE_MAX", 2)
    for index in range(3):
        stream_module._cache_spool_failure(
            stream_module._spool_failure_key(
                f"AAAAAAAAAA{index}",
                QUALITY,
                "interactive",
                provider_identity="public-spool",
            ),
            HTTPException(status_code=404, detail=f"unavailable {index}"),
        )

    assert len(stream_module._spool_failure_cache) == 2
    assert not any(key[1] == "AAAAAAAAAA0" for key in stream_module._spool_failure_cache)

    for status in (401, 403, 499):
        stream_module._cache_spool_failure(
            stream_module._spool_failure_key(
                VIDEO_ID,
                QUALITY,
                "interactive",
                provider_identity=f"excluded-{status}",
            ),
            HTTPException(status_code=status, detail="must not persist"),
        )
    assert len(stream_module._spool_failure_cache) == 2


def test_spool_failure_cooldown_preserves_classified_response(
    stream_module: Any,
) -> None:
    key = stream_module._spool_failure_key(
        VIDEO_ID,
        QUALITY,
        "interactive",
        provider_identity="public-spool",
    )
    stream_module._cache_spool_failure(
        key,
        HTTPException(
            status_code=429,
            detail={"error": "rate_limit"},
            headers={"Retry-After": "5"},
        ),
    )

    with pytest.raises(HTTPException) as cached:
        stream_module._raise_cached_spool_failure(key)

    assert cached.value.status_code == 429
    assert cast(Any, cached.value.detail) == {"error": "rate_limit"}
    assert cast(Any, cached.value.headers) == {"Retry-After": "5"}


@pytest.mark.anyio
async def test_waiter_timeout_keeps_single_flight_until_download_finishes(
    stream_module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    expected = (str(tmp_path / "track.m4a"), "audio/mp4")

    def slow_download(video_id: str, quality: str) -> tuple[str, str]:
        _signal_async_event(loop, started)
        if not release.wait(timeout=2):
            raise HTTPException(status_code=500, detail="test release timed out")
        return expected

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", slow_download)
    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", lambda *_args: None)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TIMEOUT", 0.05)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

    try:
        with pytest.raises(HTTPException) as raised:
            await stream_module._get_ytmusic_spooled_stream(VIDEO_ID, QUALITY)
        assert started.is_set()
        assert raised.value.status_code == 504
        assert raised.value.detail == "YouTube Music spool timed out"
        shared_task = stream_module._spool_tasks[f"{VIDEO_ID}:{QUALITY}"]
        assert not shared_task.done()
    finally:
        release.set()

    stream_module._yt_dlp_spool_executor.wake_loop_on_completion(loop)
    for _ in range(200):
        if shared_task.done():
            break
        await asyncio.sleep(0.01)
    assert shared_task.done()
    assert shared_task.result() == expected
    await asyncio.sleep(0)
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
async def test_proxy_endpoint_serves_full_and_range_responses(
    client: AsyncClient,
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    body = b"stream body"

    def write_spool(video_id: str, quality: str) -> tuple[str, str]:
        path = tmp_path / f"{video_id}-{quality}.m4a"
        path.write_bytes(body)
        return str(path), "audio/mp4"

    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_sync", write_spool)
    monkeypatch.setattr(stream_module, "_resolve_progressive_spool_plan_sync", lambda *_args: None)

    full_request = asyncio.create_task(client.get(f"/proxy/{VIDEO_ID}?user_id=__public__"))
    response = await _await_file_response(full_request)
    range_request = asyncio.create_task(
        client.get(
            f"/proxy/{VIDEO_ID}?user_id=__public__",
            headers={"Range": "bytes=0-3"},
        )
    )
    ranged = await _await_file_response(range_request)

    assert response.status_code == 200
    assert response.content == body
    assert response.headers["accept-ranges"] == "bytes"
    assert ranged.status_code == 206
    assert ranged.content == body[:4]
    assert ranged.headers["accept-ranges"] == "bytes"


class _ConnectedStreamRequest:
    """Small request double exposing the stream route's two used surfaces."""

    def __init__(self, range_header: str | None = None) -> None:
        self.headers = {"range": range_header} if range_header is not None else {}

    async def is_disconnected(self) -> bool:
        return False


@pytest.mark.anyio
@pytest.mark.parametrize("next_range", ["bytes=2-", "bytes=0-65535"])
async def test_sequential_range_waits_for_cancelled_writer_to_close_before_retry(
    client: AsyncClient,
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    next_range: str,
) -> None:
    prefix = b"\x1aE\xdf\xa3metadata\x1fC\xb6ucluster"
    tail = b"tail"
    advance_first_cdn = threading.Event()
    cancellation_observed = threading.Event()
    close_first_cdn = threading.Event()
    opened: list[object] = []

    class GatedResponse:
        def __init__(self) -> None:
            self.status_code = 200
            self.headers = {"Content-Length": str(len(prefix + tail))}
            self.first = not opened
            opened.append(self)

        def __enter__(self) -> GatedResponse:
            return self

        def __exit__(self, error_type: object, error: object, traceback: object) -> None:
            if self.first:
                assert isinstance(error, stream_module._SpoolDownloadCancelled)
                cancellation_observed.set()
                if not close_first_cdn.wait(timeout=3):
                    raise TimeoutError("cancelled test CDN close was not released")

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, *, chunk_size: int) -> Iterator[bytes]:
            yield prefix
            if self.first and not advance_first_cdn.wait(timeout=3):
                raise TimeoutError("test CDN was not advanced after initial range")
            yield tail

    monkeypatch.setattr(stream_module.requests, "get", lambda *_args, **_kwargs: GatedResponse())
    monkeypatch.setattr(
        stream_module,
        "_get_stream_url_sync",
        lambda *_args: {"url": "https://cdn.test/audio", "protocol": "https", "ext": "webm"},
    )
    next_request: asyncio.Task[Response] | None = None
    try:
        first = await asyncio.wait_for(
            client.get(f"/proxy/{VIDEO_ID}?user_id=__public__", headers={"Range": "bytes=0-1"}),
            timeout=1,
        )
        assert first.status_code == 206
        assert first.content == prefix[:2]
        advance_first_cdn.set()
        assert await asyncio.to_thread(cancellation_observed.wait, 1)
        old_session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
        next_request = asyncio.create_task(
            client.get(f"/proxy/{VIDEO_ID}?user_id=__public__", headers={"Range": next_range})
        )
        await asyncio.sleep(0.05)
        assert old_session.cancel_event.is_set(), "new reader revoked irreversible cancellation"
        assert len(opened) == 1, "replacement writer overlapped the old writer's close"
        assert not next_request.done()
        close_first_cdn.set()
        response = await asyncio.wait_for(next_request, timeout=2)
        assert response.status_code == 206
        expected = (prefix + tail)[2:] if next_range == "bytes=2-" else prefix + tail
        assert response.content == expected
        assert len(opened) == 2
        assert stream_module._spool_waiters == {}
    finally:
        advance_first_cdn.set()
        close_first_cdn.set()
        if next_request is not None:
            await asyncio.wait_for(next_request, timeout=2)
        for task in tuple(stream_module._spool_tasks.values()):
            await asyncio.gather(task, return_exceptions=True)
    assert stream_module._spool_pin_counts == {}
    assert stream_module._spool_reserved_bytes == 0


@pytest.mark.anyio
async def test_initial_range_http_response_finishes_while_shared_cdn_is_growing(
    client: AsyncClient,
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prefix = b"\x1aE\xdf\xa3metadata\x1fC\xb6ucluster".ljust(65536, b"x")
    tail = b"tail"
    release_cdn = threading.Event()
    readable = asyncio.Event()

    class GatedResponse:
        def __init__(self) -> None:
            self.status_code = 200
            self.headers = {"Content-Length": str(len(prefix + tail))}

        def __enter__(self) -> GatedResponse:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, *, chunk_size: int) -> Iterator[bytes]:
            assert chunk_size == len(prefix)
            yield prefix
            if not release_cdn.wait(timeout=2):
                raise TimeoutError("test CDN tail was not released")
            yield tail

    monkeypatch.setattr(stream_module.requests, "get", lambda *_args, **_kwargs: GatedResponse())
    monkeypatch.setattr(
        stream_module,
        "_get_stream_url_sync",
        lambda *_args: {"url": "https://cdn.test/audio", "protocol": "https", "ext": "webm"},
    )
    warmup = asyncio.create_task(stream_module.warm_ytmusic_spool(VIDEO_ID, QUALITY, readable.set))
    try:
        await asyncio.wait_for(readable.wait(), timeout=1)
        session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
        assert session.content_length == len(prefix + tail)
        response = await asyncio.wait_for(
            client.get(
                f"/proxy/{VIDEO_ID}?user_id=__public__",
                headers={"Range": "bytes=0-65535"},
            ),
            timeout=1,
        )
        assert response.status_code == 206
        assert response.content == prefix
        assert response.headers["content-length"] == "65536"
        assert response.headers["content-range"] == "bytes 0-65535/65540"
        assert response.headers["accept-ranges"] == "bytes"
        assert not warmup.done()
        assert not session.cancel_event.is_set()
        assert stream_module._spool_waiters == {f"{VIDEO_ID}:{QUALITY}": 1}
    finally:
        release_cdn.set()
        await asyncio.wait_for(warmup, timeout=2)
    assert stream_module._spool_pin_counts == {}
    assert stream_module._spool_reserved_bytes == 0


@pytest.mark.anyio
async def test_cached_file_lookup_hands_an_atomic_pin_to_the_response(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 6)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 6)
    cached = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    cached.write_bytes(b"audio")
    found = threading.Event()
    release_lookup = threading.Event()
    real_find = stream_module._find_spooled_file

    def pause_after_lookup(
        video_id: str,
        quality: str,
        *,
        pin: bool = False,
    ) -> Path | None:
        result = cast(
            Path | None,
            real_find(video_id, quality, pin=True) if pin else real_find(video_id, quality),
        )
        found.set()
        if not release_lookup.wait(timeout=2):
            raise TimeoutError("test cached lookup was not released")
        return result

    monkeypatch.setattr(stream_module, "_find_spooled_file", pause_after_lookup)
    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest("bytes=0-1"),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        )
    )
    reserved: int | None = None
    response: Any | None = None
    try:
        assert await asyncio.to_thread(found.wait, 1)
        with pytest.raises(HTTPException) as full:
            reserved = await asyncio.to_thread(stream_module._reserve_spool_bytes)
        assert full.value.status_code == 503
        assert cached.exists(), "reservation evicted a path already handed to a response"
    finally:
        release_lookup.set()
        if reserved is not None:
            stream_module._release_spool_bytes(reserved)
        response = await asyncio.wait_for(response_task, timeout=2)

    assert isinstance(response, stream_module._PinnedFileResponse)
    assert stream_module._spool_pin_counts == {cached: 1}
    response._release_pin()
    assert stream_module._spool_pin_counts == {}


@pytest.mark.anyio
async def test_cancelled_cached_lookup_releases_worker_owned_pin(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    cached = tmp_path / f"{VIDEO_ID}-{QUALITY}.m4a"
    cached.write_bytes(b"audio")
    found = threading.Event()
    release_lookup = threading.Event()
    real_find = stream_module._find_spooled_file

    def pause_after_pin(
        video_id: str,
        quality: str,
        *,
        pin: bool = False,
    ) -> Path | None:
        result = cast(Path | None, real_find(video_id, quality, pin=pin))
        found.set()
        if not release_lookup.wait(timeout=2):
            raise TimeoutError("test cached lookup was not released")
        return result

    monkeypatch.setattr(stream_module, "_find_spooled_file", pause_after_pin)
    lookup = asyncio.create_task(stream_module._find_spooled_result(VIDEO_ID, QUALITY, pin=True))
    assert await asyncio.to_thread(found.wait, 1)
    lookup.cancel()
    with pytest.raises(asyncio.CancelledError):
        await lookup

    release_lookup.set()
    for _ in range(100):
        if not stream_module._spool_pin_counts:
            break
        await asyncio.sleep(0.01)
    assert stream_module._spool_pin_counts == {}


class _GrowingSpoolDownload:
    """Publish an append-only prefix and gate the atomic completion."""

    def __init__(self, root: Path, *, fail: bool = False, known_length: bool = False) -> None:
        self.root = root
        self.fail = fail
        self.known_length = known_length
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.prefix = b"\x1aE\xdf\xa3webm-header\x1fC\xb6ucluster-one"
        self.tail = b"cluster-two"
        self.partial: Path | None = None
        self.completed: Path | None = None

    async def __call__(
        self,
        video_id: str,
        quality: str,
        *,
        playback: bool = True,
        session: Any | None = None,
    ) -> tuple[str, str]:
        _ = playback
        assert session is not None
        self.partial = self.root / f"{video_id}-{quality}.webm.soundspan-part"
        self.completed = self.root / f"{video_id}-{quality}.webm"
        self.partial.write_bytes(self.prefix)
        session.publish_readable(
            self.partial,
            "audio/webm",
            len(self.prefix + self.tail) if self.known_length else None,
        )
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise HTTPException(status_code=502, detail="progressive download failed")
        with self.partial.open("ab") as spool:
            spool.write(self.tail)
        self.partial.replace(self.completed)
        session.publish_growth()
        return str(self.completed), "audio/webm"


@pytest.mark.anyio
@pytest.mark.parametrize("stop", ["deadline", "disconnect", "cancel"])
async def test_retiring_spool_wait_is_bounded_and_does_not_revive_writer(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    stop: str,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=True)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    first = await asyncio.wait_for(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        ),
        timeout=1,
    )
    await anext(first.body_iterator)
    await first.body_iterator.aclose()
    session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
    checked_disconnect = asyncio.Event()

    class WaitingRequest(_ConnectedStreamRequest):
        async def is_disconnected(self) -> bool:
            checked_disconnect.set()
            return stop == "disconnect"

    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_TIMEOUT", 0.03)
    waiter = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            WaitingRequest("bytes=0-65535"),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        )
    )
    try:
        await asyncio.wait_for(checked_disconnect.wait(), timeout=1)
        if stop == "cancel":
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
        else:
            with pytest.raises(HTTPException) as raised:
                await asyncio.wait_for(waiter, timeout=1)
            assert raised.value.status_code == (504 if stop == "deadline" else 499)
        assert session.cancel_event.is_set()
        assert stream_module._spool_waiters == {}
        assert stream_module._spool_tasks == {session.key: session.task}
    finally:
        download.release.set()
        await asyncio.gather(session.task, return_exceptions=True)
    assert stream_module._spool_pin_counts == {}


@pytest.mark.anyio
@pytest.mark.parametrize("purpose", ["interactive", "preload"])
@pytest.mark.parametrize("end", [0, 1, 15, 65535])
async def test_initial_bounded_range_starts_before_atomic_completion(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    purpose: str,
    end: int,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=True)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(f"bytes=0-{end}"),
            user_id="__public__",
            quality=QUALITY,
            purpose=purpose,
        )
    )
    response: Any | None = None
    try:
        await asyncio.wait_for(download.started.wait(), timeout=1)
        session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
        response = await asyncio.wait_for(response_task, timeout=1)
        assert response is not None
        expected = (download.prefix + download.tail)[: end + 1]
        assert response.status_code == 206
        assert response.headers["content-range"] == (
            f"bytes 0-{len(expected) - 1}/{len(download.prefix + download.tail)}"
        )
        assert response.headers["content-length"] == str(len(expected))
        assert response.headers["content-type"] == "audio/webm"
        first = await asyncio.wait_for(anext(response.body_iterator), timeout=1)
        assert first == expected[: len(download.prefix)]
        assert session.task is not None and not session.task.done()
        if len(expected) <= len(download.prefix):
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(anext(response.body_iterator), timeout=1)
            assert session.cancel_event.is_set()
        else:
            download.release.set()
            remainder = b"".join([chunk async for chunk in response.body_iterator])
            assert first + remainder == expected
        assert stream_module._spool_waiters == {}
    finally:
        download.release.set()
        if response is not None:
            await response.body_iterator.aclose()
        if session.task is not None:
            await asyncio.wait_for(asyncio.shield(session.task), timeout=1)
    assert stream_module._spool_pin_counts == {}


@pytest.mark.anyio
async def test_initial_range_stops_exactly_at_64k_across_growing_reads(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=True)
    download.prefix = download.prefix.ljust(32768, b"x")
    download.tail = b"y" * 100000
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    response = await asyncio.wait_for(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest("bytes=0-65535"),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        ),
        timeout=1,
    )
    assert response.headers["content-length"] == "65536"
    assert response.headers["content-range"] == "bytes 0-65535/132768"
    first = await anext(response.body_iterator)
    assert first == download.prefix
    download.release.set()
    remainder = b"".join([chunk async for chunk in response.body_iterator])
    assert first + remainder == (download.prefix + download.tail)[:65536]
    assert stream_module._spool_waiters == {}
    assert stream_module._spool_pin_counts == {}


@pytest.mark.anyio
@pytest.mark.parametrize("purpose", ["interactive", "preload"])
async def test_progressive_spool_returns_prefix_before_atomic_completion(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    purpose: str,
) -> None:
    download = _GrowingSpoolDownload(tmp_path)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)

    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(),
            user_id="__public__",
            quality=QUALITY,
            purpose=purpose,
        )
    )
    await asyncio.wait_for(download.started.wait(), timeout=1)
    response = await asyncio.wait_for(response_task, timeout=1)

    assert isinstance(response, stream_module.StreamingResponse)
    assert "content-length" not in response.headers
    assert response.headers["accept-ranges"] == "bytes"
    assert await anext(response.body_iterator) == download.prefix
    assert not stream_module._spool_tasks[f"{VIDEO_ID}:{QUALITY}"].done()

    download.release.set()
    remainder = b"".join([chunk async for chunk in response.body_iterator])
    assert remainder == download.tail
    assert stream_module._spool_waiters == {}


@pytest.mark.anyio
async def test_warmup_interface_reports_readable_and_releases_its_lease_on_cancel(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    download = _GrowingSpoolDownload(tmp_path)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)
    readable = asyncio.Event()

    warmup = asyncio.create_task(stream_module.warm_ytmusic_spool(VIDEO_ID, QUALITY, readable.set))
    await asyncio.wait_for(download.started.wait(), timeout=1)
    await asyncio.wait_for(readable.wait(), timeout=1)
    session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
    assert stream_module._spool_waiters == {f"{VIDEO_ID}:{QUALITY}": 1}

    warmup.cancel()
    with pytest.raises(asyncio.CancelledError):
        await warmup
    assert session.cancel_event.is_set()
    assert stream_module._spool_waiters == {}

    download.release.set()
    assert session.task is not None
    await asyncio.wait_for(asyncio.shield(session.task), timeout=1)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("purpose", "range_header", "known_length"),
    [
        ("analysis", None, True),
        ("analysis", "bytes=0-4", True),
        ("interactive", "bytes=4-", True),
        ("interactive", "bytes=4-15", True),
        ("interactive", "bytes=-4", True),
        ("interactive", "bytes=0-1,4-5", True),
        ("interactive", "bytes=0-invalid", True),
        ("interactive", "bytes=0-" + "9" * 30, True),
        ("preload", "bytes=0-4", False),
        ("interactive", "bytes=0-1", False),
    ],
)
async def test_non_streamable_spool_requests_wait_for_atomic_completion(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    purpose: str,
    range_header: str | None,
    known_length: bool,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=known_length)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)

    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(range_header),
            user_id="__public__",
            quality=QUALITY,
            purpose=purpose,
        )
    )
    await asyncio.wait_for(download.started.wait(), timeout=1)
    await asyncio.sleep(0)
    assert not response_task.done()

    download.release.set()
    response = await asyncio.wait_for(response_task, timeout=1)
    assert isinstance(response, stream_module.FileResponse)
    assert response.path == str(download.completed)
    response._release_pin()
    assert stream_module._spool_pin_counts == {}


@pytest.mark.anyio
async def test_conditional_initial_range_waits_for_completed_file_validators(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=True)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    request = _ConnectedStreamRequest("bytes=0-1")
    request.headers["if-range"] = '"previous-file-etag"'
    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID, request, user_id="__public__", quality=QUALITY, purpose="interactive"
        )
    )
    await asyncio.wait_for(download.started.wait(), timeout=1)
    await asyncio.sleep(0)
    assert not response_task.done()
    download.release.set()
    response = await asyncio.wait_for(response_task, timeout=1)
    assert isinstance(response, stream_module._PinnedFileResponse)
    response._release_pin()
    assert stream_module._spool_pin_counts == {}


@pytest.mark.anyio
@pytest.mark.parametrize("range_header", [None, "bytes=0-65535"])
async def test_progressive_failure_cleans_partial_and_releases_lease(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    range_header: str | None,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, fail=True, known_length=True)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(range_header),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        )
    )
    await asyncio.wait_for(download.started.wait(), timeout=1)
    response = await asyncio.wait_for(response_task, timeout=1)
    assert await anext(response.body_iterator) == download.prefix

    download.release.set()
    with pytest.raises(HTTPException, match="progressive download failed"):
        _ = b"".join([chunk async for chunk in response.body_iterator])

    assert download.partial is not None
    assert not download.partial.exists()
    assert stream_module._spool_waiters == {}
    assert stream_module._spool_tasks == {}


@pytest.mark.anyio
@pytest.mark.parametrize("range_header", [None, "bytes=0-65535"])
async def test_shared_growing_spool_cancels_only_after_last_reader_closes(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    range_header: str | None,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=True)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

    requests = [
        asyncio.create_task(
            stream_module.proxy_stream(
                VIDEO_ID,
                _ConnectedStreamRequest(range_header),
                user_id="__public__",
                quality=QUALITY,
                purpose="interactive",
            )
        )
        for _ in range(2)
    ]
    await asyncio.wait_for(download.started.wait(), timeout=1)
    responses = await asyncio.gather(*requests)
    for response in responses:
        assert await anext(response.body_iterator) == download.prefix

    session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
    await responses[0].body_iterator.aclose()
    assert not session.cancel_event.is_set()
    assert stream_module._spool_waiters == {f"{VIDEO_ID}:{QUALITY}": 1}
    await responses[1].body_iterator.aclose()
    assert session.cancel_event.is_set()
    assert stream_module._spool_waiters == {}

    download.release.set()
    assert session.task is not None
    await asyncio.wait_for(asyncio.shield(session.task), timeout=1)


@pytest.mark.anyio
@pytest.mark.parametrize("range_header", [None, "bytes=0-65535"])
async def test_growing_spool_lease_pins_completed_file_until_reader_closes(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    range_header: str | None,
) -> None:
    download = _GrowingSpoolDownload(tmp_path, known_length=True)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)
    monkeypatch.setattr(stream_module, "YTMUSIC_SPOOL_MAX_BYTES", 1)

    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(range_header),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        )
    )
    await asyncio.wait_for(download.started.wait(), timeout=1)
    response = await asyncio.wait_for(response_task, timeout=1)
    assert await anext(response.body_iterator) == download.prefix
    download.release.set()
    task = stream_module._spool_tasks[f"{VIDEO_ID}:{QUALITY}"]
    await asyncio.wait_for(asyncio.shield(task), timeout=1)
    await asyncio.sleep(0)

    assert download.completed is not None
    old = time.time() - stream_module._SPOOL_EVICT_MIN_AGE_SECONDS - 1
    os.utime(download.completed, (old, old))
    stream_module._prune_spool()
    assert download.completed.exists()

    await response.body_iterator.aclose()
    stream_module._prune_spool()
    assert not download.completed.exists()


@pytest.mark.anyio
async def test_stream_shutdown_cancels_active_spool_and_rejects_new_work(
    stream_module: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    extraction_executor = stream_module._yt_dlp_spool_executor
    transfer_executor = stream_module._spool_transfer_executor
    download = _GrowingSpoolDownload(tmp_path)
    monkeypatch.setattr(stream_module, "_download_ytmusic_spool_bounded", download)
    monkeypatch.setattr(stream_module, "_find_spooled_file", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(stream_module.asyncio, "to_thread", _run_inline)

    response_task = asyncio.create_task(
        stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        )
    )
    await asyncio.wait_for(download.started.wait(), timeout=1)
    response = await asyncio.wait_for(response_task, timeout=1)
    assert await anext(response.body_iterator) == download.prefix

    shutdown_task = asyncio.create_task(stream_module.shutdown_stream_provider())
    await asyncio.sleep(0)
    session = stream_module._spool_sessions[f"{VIDEO_ID}:{QUALITY}"]
    assert session.cancel_event.is_set()
    with pytest.raises(HTTPException) as raised:
        stream_module._create_spool_task("other:HIGH", "other", "HIGH")
    assert raised.value.status_code == 503
    with pytest.raises(HTTPException) as joined:
        await stream_module.proxy_stream(
            VIDEO_ID,
            _ConnectedStreamRequest(),
            user_id="__public__",
            quality=QUALITY,
            purpose="interactive",
        )
    assert joined.value.status_code == 503
    assert session.cancel_event.is_set()

    download.release.set()
    await asyncio.wait_for(shutdown_task, timeout=1)
    await response.body_iterator.aclose()
    assert stream_module._spool_tasks == {}
    assert stream_module._spool_sessions == {}
    assert extraction_executor.shutdown_calls == 1
    assert transfer_executor.shutdown_calls == 1
