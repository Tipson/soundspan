"""Cold prefixes share a bounded CDN lane before already buffered file tails."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest


@pytest.mark.anyio
async def test_writer_reservations_queue_before_exceeding_disk_budget(monkeypatch):
    import asyncio

    monkeypatch.setenv("YTMUSIC_SPOOL_MAX_BYTES", str(16 * 1024 * 1024))
    monkeypatch.setenv("YTMUSIC_SPOOL_TRACK_MAX_BYTES", str(8 * 1024 * 1024))
    import ytmusic_stream as stream

    release = threading.Event()
    started = []

    def transfer(video, *_args):
        started.append(video)
        assert release.wait(3)
        return video, "audio/webm"

    monkeypatch.setattr(stream, "_resolve_progressive_spool_plan_sync", lambda *_a: object())
    monkeypatch.setattr(stream, "_run_spool_download_sync", transfer)
    sessions = [
        stream._SpoolSession(
            str(i), asyncio.get_running_loop(), threading.Event(), allow_growing=True
        )
        for i in range(3)
    ]
    tasks = [
        asyncio.create_task(stream._download_ytmusic_spool_bounded(str(i), "HIGH", session=s))
        for i, s in enumerate(sessions)
    ]
    try:
        for _ in range(100):
            if len(started) >= 2:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        assert len(started) == 2
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 2)
        stream._yt_dlp_spool_executor.shutdown(wait=True)
        stream._spool_transfer_executor.shutdown(wait=True)
    assert len(started) == 3


def test_cold_prefix_precedes_buffered_tail_and_concurrency_stays_bounded(monkeypatch):
    import ytmusic_stream as stream
    from ytmusic_extraction_budget import ExtractionBudget

    budget = ExtractionBudget(1)
    monkeypatch.setattr(stream, "_spool_transfer_budget", budget)
    monkeypatch.setattr(stream, "_SPOOL_CDN_RANGE_BYTES", 8)
    release = threading.Event()
    first_reading = threading.Event()
    order = []
    active = 0
    peak = 0

    class Client:
        def __init__(self, name):
            self.name = name

        def get(self, url, *, headers, **_kwargs):
            nonlocal active, peak
            start = int(headers["Range"].split("=")[1].split("-")[0])
            order.append((self.name, start))
            active += 1
            peak = max(peak, active)
            name = self.name

            class Response:
                status_code = 206
                url = "https://cdn.test/audio"

                def __init__(self):
                    self.headers = {
                        "Content-Length": "8",
                        "Content-Range": f"bytes {start}-{start + 7}/16",
                    }

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    nonlocal active
                    active -= 1

                def raise_for_status(self):
                    pass

                def iter_content(self, **_kwargs):
                    if name == "first" and start == 0:
                        first_reading.set()
                        assert release.wait(2)
                    yield b"12345678"

            return Response()

    def consume(name):
        session = SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2)
        return b"".join(
            chunk
            for chunk, _ in stream._iter_progressive_cdn_ranges(
                "https://cdn.test/audio", {}, session, 100, time.monotonic(), Client(name)
            )
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(consume, "first")
        assert first_reading.wait(1)
        second = pool.submit(consume, "second")
        try:
            deadline = time.monotonic() + 1
            while not budget._priority_waiters[2] and time.monotonic() < deadline:
                time.sleep(0.001)
            assert budget._priority_waiters[2], (
                "Cold request must wait inside the shared CDN budget"
            )
        finally:
            release.set()
        assert first.result(timeout=1) == b"12345678" * 2
        assert second.result(timeout=1) == b"12345678" * 2
    assert order[:2] == [("first", 0), ("second", 0)]
    assert peak == 1
    assert budget._active == 0


@pytest.mark.parametrize("failure", [False, True])
def test_budget_lease_releases_after_iteration_or_exception(failure):
    from ytmusic_extraction_budget import ExtractionBudget

    budget = ExtractionBudget(1)
    try:
        with budget.lease(playback=True):
            assert budget._active == 1
            if failure:
                raise ValueError("controlled")
    except ValueError:
        assert failure
    assert budget._active == 0
    assert budget.run(lambda: "next", playback=True) == "next"


def test_temporary_writer_reservation_pressure_waits_and_cancellation_stops(monkeypatch):
    import ytmusic_stream as stream
    from fastapi import HTTPException

    cancel = threading.Event()
    monkeypatch.setattr(
        stream._spool_worker_context, "session", SimpleNamespace(cancel_event=cancel), raising=False
    )
    monkeypatch.setattr(stream, "_spool_reserved_bytes", 1)
    attempts = []

    def reserve():
        attempts.append(1)
        if len(attempts) == 1:
            raise HTTPException(503, "temporary writer pressure")
        return 8

    released = []
    monkeypatch.setattr(stream, "_reserve_spool_bytes", reserve)
    monkeypatch.setattr(stream, "_release_spool_bytes", released.append)
    with stream._spool_byte_reservation() as size:
        assert size == 8
    assert released == [8] and len(attempts) == 2
    cancel.set()
    with pytest.raises(stream._SpoolDownloadCancelled), stream._spool_byte_reservation():
        pytest.fail("cancelled writer admitted")
    assert len(attempts) == 2
