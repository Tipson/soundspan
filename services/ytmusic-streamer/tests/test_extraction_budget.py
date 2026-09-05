"""Prove playback and metadata cannot multiply the heavy extraction budget."""

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi import HTTPException
from httpx import AsyncClient


def test_waiting_playback_takes_the_next_slot_before_metadata() -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    budget = ExtractionBudget(1)
    hold = threading.Event()
    started = threading.Event()
    order: list[str] = []

    def occupy() -> None:
        started.set()
        hold.wait(2)

    with ThreadPoolExecutor(max_workers=3) as workers:
        first = workers.submit(budget.run, occupy)
        assert started.wait(1)
        metadata = workers.submit(budget.run, lambda: order.append("metadata"))
        playback = workers.submit(budget.run, lambda: order.append("playback"), playback=True)
        try:
            # Observe registration, then test externally visible execution order.
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                with budget._condition:
                    if budget._playback_waiters:
                        break
                time.sleep(0.001)
            else:
                pytest.fail("Playback did not enter the budget queue")
            hold.set()
            first.result(timeout=1)
            playback.result(timeout=1)
            metadata.result(timeout=1)
            assert order == ["playback", "metadata"]
        finally:
            hold.set()


def test_background_work_cannot_consume_the_reserved_interactive_slot() -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    budget = ExtractionBudget(2)
    release_background = threading.Event()
    first_started = threading.Event()
    second_started = threading.Event()
    interactive_started = threading.Event()

    def first_background() -> None:
        first_started.set()
        release_background.wait(2)

    def second_background() -> None:
        second_started.set()

    with ThreadPoolExecutor(max_workers=3) as workers:
        first = workers.submit(budget.run, first_background)
        assert first_started.wait(1)
        second = workers.submit(budget.run, second_background)
        interactive = workers.submit(
            budget.run,
            interactive_started.set,
            playback=True,
        )
        try:
            assert interactive_started.wait(1)
            assert not second_started.is_set()
        finally:
            release_background.set()
            first.result(timeout=1)
            interactive.result(timeout=1)
            second.result(timeout=1)

    assert second_started.is_set()


def test_background_can_use_its_slot_while_interactive_work_is_active() -> None:
    """Reservation is per lane, not based on the combined active count."""
    from ytmusic_extraction_budget import ExtractionBudget

    budget = ExtractionBudget(2)
    release = threading.Event()
    interactive_started = threading.Event()
    background_started = threading.Event()

    def interactive_work() -> None:
        interactive_started.set()
        release.wait(2)

    def background_work() -> None:
        background_started.set()

    with ThreadPoolExecutor(max_workers=2) as workers:
        interactive = workers.submit(budget.run, interactive_work, playback=True)
        assert interactive_started.wait(1)
        background = workers.submit(budget.run, background_work)
        try:
            assert background_started.wait(1), "The background lane had a free slot"
        finally:
            release.set()
            interactive.result(timeout=1)
            background.result(timeout=1)


def test_waiting_preload_can_be_promoted_to_interactive_priority() -> None:
    from ytmusic_extraction_budget import ExtractionBudget

    budget = ExtractionBudget(2)
    release_first = threading.Event()
    first_started = threading.Event()
    promoted_started = threading.Event()
    priority = [1]

    def first_preload() -> None:
        first_started.set()
        release_first.wait(2)

    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(budget.run, first_preload, priority=lambda: 1)
        assert first_started.wait(1)
        promoted = workers.submit(
            budget.run,
            promoted_started.set,
            priority=lambda: priority[0],
        )
        try:
            assert not promoted_started.wait(0.05)
            priority[0] = 2
            budget.notify_priority_change()
            assert promoted_started.wait(1), (
                "an interactive join must promote its queued preload single-flight"
            )
        finally:
            release_first.set()
            first.result(timeout=1)
            promoted.result(timeout=1)


@pytest.mark.anyio
async def test_waiting_background_spools_do_not_hide_interactive_work_from_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All bounded pending jobs must reach the priority-aware budget queue."""
    import ytmusic_stream as stream
    from ytmusic_extraction_budget import ExtractionBudget

    release = threading.Event()
    first_background_started = threading.Event()
    second_background_started = threading.Event()
    interactive_started = threading.Event()

    def spool(video_id: str, _quality: str) -> tuple[str, str]:
        if video_id == "background1":
            first_background_started.set()
            release.wait(2)
        elif video_id == "background2":
            second_background_started.set()
        else:
            interactive_started.set()
        return (f"{video_id}.m4a", "audio/mp4")

    monkeypatch.setattr(stream, "_extraction_budget", ExtractionBudget(2))
    monkeypatch.setattr(stream, "_download_ytmusic_spool_sync", spool)
    first = asyncio.create_task(
        stream._download_ytmusic_spool_bounded("background1", "HIGH", playback=False)
    )
    assert await asyncio.to_thread(first_background_started.wait, 1)
    second = asyncio.create_task(
        stream._download_ytmusic_spool_bounded("background2", "HIGH", playback=False)
    )
    interactive = asyncio.create_task(
        stream._download_ytmusic_spool_bounded("interactive", "HIGH", playback=True)
    )
    try:
        for _ in range(100):
            if interactive_started.is_set():
                break
            await asyncio.sleep(0.01)
        assert interactive_started.is_set(), "Interactive spool stayed behind a budget waiter"
        assert not second_background_started.is_set()
    finally:
        release.set()
        await asyncio.gather(first, second, interactive)


@pytest.mark.parametrize("album", [False, True])
def test_library_downloads_cannot_bypass_the_shared_budget(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    album: bool,
) -> None:
    import yt_dlp
    import ytmusic_album_downloads as albums
    import ytmusic_downloads as downloads

    module = albums if album else downloads
    entered: list[bool] = []

    class Budget:
        def run(self, operation: Any) -> Any:
            entered.append(True)
            return operation()

    class Download:
        def __init__(self, _options: Any) -> None:
            pass

        def __enter__(self) -> "Download":
            return self

        def __exit__(self, *_args: Any) -> None:
            pass

        def extract_info(self, _url: str, download: bool) -> Any:
            assert entered == [True], "Download bypassed the extraction budget"
            (tmp_path / "track.m4a").write_bytes(b"audio")
            return {"title": "test"}

    monkeypatch.setattr(module, "_extraction_budget", Budget(), raising=False)
    monkeypatch.setattr(module._extract_pacer, "wait", lambda: None)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", Download)
    monkeypatch.setattr(downloads, "_complete_yt_download", lambda *_args: None)
    if album:
        albums._extract_album_track({}, "dQw4w9WgXcQ", tmp_path / "track.m4a", "m4a", "HIGH")
    else:
        downloads._yt_download_sync({"video_id": "dQw4w9WgXcQ"}, "m4a", "HIGH", str(tmp_path))


@pytest.mark.anyio
async def test_metadata_and_audio_share_one_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    import ytmusic_stream as stream

    release = threading.Event()
    lock = threading.Lock()
    active = 0
    peak = 0

    def work(*_args: Any) -> Any:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            release.wait(2)
            return {}
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(stream, "_download_ytmusic_spool_sync", work)
    tasks: list[asyncio.Task[Any]] = [
        asyncio.create_task(stream._extract_stream_info_bounded(work))
        for _ in range(stream.YTDLP_EXTRACT_CONCURRENCY)
    ]
    tasks += [asyncio.create_task(stream._download_ytmusic_spool_bounded("track", "HIGH"))]
    try:
        for _ in range(30):
            await asyncio.sleep(0.01)
        assert peak <= stream.YTDLP_EXTRACT_CONCURRENCY
    finally:
        release.set()
        await asyncio.gather(*tasks)


@pytest.mark.anyio
async def test_remote_analysis_spool_does_not_claim_playback_priority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ytmusic_stream as stream

    priorities: list[bool] = []

    class Budget:
        def run(
            self,
            operation: Any,
            *,
            playback: bool = False,
            cancel_event: threading.Event | None = None,
        ) -> Any:
            _ = cancel_event
            priorities.append(playback)
            return operation()

    monkeypatch.setattr(stream, "_extraction_budget", Budget())
    monkeypatch.setattr(
        stream,
        "_download_ytmusic_spool_sync",
        lambda *_args: ("track.m4a", "audio/mp4"),
    )

    await stream._download_ytmusic_spool_bounded(
        "dQw4w9WgXcQ",
        "MEDIUM",
        playback=False,
    )

    assert priorities == [False]


@pytest.mark.anyio
async def test_preload_spool_claims_playback_priority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The next-track preload must not sit behind offline analysis work."""
    import ytmusic_stream as stream

    priorities: list[bool] = []
    contexts: list[tuple[str, str]] = []

    async def missing(*_args: Any) -> None:
        return None

    def create(
        _key: str,
        _video_id: str,
        _quality: str,
        *,
        playback: bool = True,
        purpose: str = "interactive",
        provider_identity: str = "public-spool",
    ) -> asyncio.Future[tuple[str, str]]:
        priorities.append(playback)
        contexts.append((purpose, provider_identity))
        future = asyncio.get_running_loop().create_future()
        future.set_result(("track.m4a", "audio/mp4"))
        return future

    monkeypatch.setattr(stream, "_find_spooled_result", missing)
    monkeypatch.setattr(stream, "_try_get_or_create_spool_task", create)

    result = await stream._get_ytmusic_spooled_stream(
        "dQw4w9WgXcQ",
        "HIGH",
        purpose="preload",
    )

    assert result == ("track.m4a", "audio/mp4")
    assert priorities == [True]
    assert contexts == [("preload", "public-spool")]


@pytest.mark.anyio
async def test_timed_out_metadata_does_not_start_after_budget_frees(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ytmusic_stream as stream
    from ytmusic_extraction_budget import ExtractionBudget

    release = threading.Event()
    started = threading.Event()
    late_calls: list[str] = []
    budget = ExtractionBudget(1)
    monkeypatch.setattr(stream, "_extraction_budget", budget)
    monkeypatch.setattr(stream, "EXTRACT_TIMEOUT", 0.05)

    def blocking() -> dict[str, Any]:
        started.set()
        release.wait(2)
        return {}

    def record_late_call() -> dict[str, Any]:
        late_calls.append("ran")
        return {}

    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(budget.run, blocking)
        try:
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            with pytest.raises(HTTPException) as failure:
                await stream._extract_stream_info_bounded(record_late_call)
            assert failure.value.status_code == 504
            release.set()
            running.result(timeout=1)
            await asyncio.sleep(0.15)
            assert late_calls == []
        finally:
            release.set()


@pytest.mark.anyio
async def test_passive_info_never_extracts_on_cache_miss(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ytmusic_stream as stream

    def forbidden(*_args: Any) -> Any:
        pytest.fail("A quality badge must not launch yt-dlp")

    monkeypatch.setattr(stream, "_get_stream_url_sync", forbidden)
    response = await client.get("/stream/dQw4w9WgXcQ?user_id=__public__&cached_only=true")
    assert response.status_code == 200
    assert response.json()["abr"] == 0
    assert response.json()["acodec"] == ""


@pytest.mark.anyio
async def test_spool_publishes_quality_without_another_extraction(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    import yt_dlp
    import ytmusic_stream as stream

    calls: list[str] = []
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)

    class Download:
        def __init__(self, _options: Any) -> None:
            pass

        def __enter__(self) -> "Download":
            return self

        def __exit__(self, *_args: Any) -> None:
            pass

        def extract_info(self, url: str, download: bool) -> dict[str, Any]:
            calls.append(url)
            assert download
            (tmp_path / "dQw4w9WgXcQ-HIGH.m4a").write_bytes(b"audio")
            return {
                "url": "https://cdn.example/audio",
                "abr": 129,
                "acodec": "mp4a.40.2",
                "duration": 220,
            }

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Download)
    await asyncio.to_thread(stream._download_ytmusic_spool_sync, "dQw4w9WgXcQ", "HIGH")
    response = await client.get("/stream/dQw4w9WgXcQ?user_id=__public__&cached_only=true")
    assert response.status_code == 200
    assert response.json()["abr"] == 129
    assert len(calls) == 1
    other_quality = await client.get(
        "/stream/dQw4w9WgXcQ?user_id=__public__&cached_only=true&quality=LOW"
    )
    assert other_quality.json()["abr"] == 0


@pytest.mark.anyio
@pytest.mark.parametrize(
    "message, expected_calls",
    [
        ("Requested format is not available", 2),
        ("Video unavailable", 1),
        ("Sign in to confirm you're not a bot", 1),
    ],
)
async def test_only_transient_format_failure_gets_one_spool_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    message: str,
    expected_calls: int,
) -> None:
    import yt_dlp
    import ytmusic_stream as stream

    calls: list[bool] = []
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream._extract_pacer, "wait", lambda: None)

    class Download:
        def __init__(self, _options: Any) -> None:
            pass

        def __enter__(self) -> "Download":
            return self

        def __exit__(self, *_args: Any) -> None:
            pass

        def extract_info(self, _url: str, download: bool) -> Any:
            calls.append(download)
            raise yt_dlp.utils.DownloadError(message)

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Download)
    with pytest.raises(HTTPException):
        await asyncio.to_thread(stream._download_ytmusic_spool_sync, "dQw4w9WgXcQ", "HIGH")
    assert len(calls) == expected_calls
