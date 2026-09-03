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
    tasks = [
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

    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(budget.run, blocking)
        try:
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            with pytest.raises(HTTPException) as failure:
                await stream._extract_stream_info_bounded(lambda: late_calls.append("ran") or {})
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
