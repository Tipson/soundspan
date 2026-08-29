"""Shared queued admission for concurrent YouTube Music search batches."""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest
from httpx import AsyncClient


async def _wait_for_thread_event(event: threading.Event, wait_seconds: float = 1.0) -> None:
    """Wait for a worker-thread signal without blocking the event loop."""
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while not event.is_set():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("batch workers did not reach the expected state")
        await asyncio.sleep(0.005)


@pytest.mark.anyio
async def test_two_discovery_batches_share_queued_provider_capacity(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second three-row batch waits for capacity instead of failing fast."""
    import app

    concurrency = 3
    started = threading.Event()
    release = threading.Event()
    calls_lock = threading.Lock()
    calls = 0
    active = 0
    max_active = 0

    def blocked_search(*args: Any, **kwargs: Any) -> Any:
        nonlocal active, calls, max_active
        with calls_lock:
            calls += 1
            active += 1
            max_active = max(max_active, active)
            if active == concurrency:
                started.set()
        try:
            if not release.wait(timeout=2):
                raise TimeoutError("test batch release timed out")
            return [], "native"
        finally:
            with calls_lock:
                active -= 1

    app._search_cache.clear()
    monkeypatch.setattr(app, "_batch_semaphore", asyncio.Semaphore(concurrency))
    monkeypatch.setattr(app, "BATCH_DELAY_MIN", 0)
    monkeypatch.setattr(app, "BATCH_DELAY_MAX", 0)
    monkeypatch.setattr(app, "_search_with_mode_fallback", blocked_search)
    queries = [
        {"query": "radiohead", "filter": filter_name, "limit": 20}
        for filter_name in ("songs", "albums", "artists")
    ]

    first = asyncio.create_task(
        client.post("/search/batch?user_id=user-1", json={"queries": queries})
    )
    second: asyncio.Task[Any] | None = None
    try:
        await _wait_for_thread_event(started)
        second = asyncio.create_task(
            client.post("/search/batch?user_id=user-2", json={"queries": queries})
        )
        await asyncio.sleep(0.05)

        assert not second.done()
        assert calls == concurrency
        assert max_active == concurrency

        release.set()
        responses = await asyncio.gather(first, second)

        assert [response.status_code for response in responses] == [200, 200]
        assert [len(response.json()["results"]) for response in responses] == [3, 3]
        assert calls == 6
        assert max_active == concurrency
    finally:
        release.set()
        pending = [task for task in (first, second) if task is not None]
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.anyio
async def test_cancelled_batch_retains_slots_until_provider_threads_finish(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Request cancellation must not let live provider threads exceed the cap."""
    import app

    concurrency = 3
    started = threading.Event()
    release = threading.Event()
    calls_lock = threading.Lock()
    calls = 0
    active = 0
    max_active = 0

    def blocked_search(*args: Any, **kwargs: Any) -> Any:
        nonlocal active, calls, max_active
        with calls_lock:
            calls += 1
            active += 1
            max_active = max(max_active, active)
            if active == concurrency:
                started.set()
        try:
            if not release.wait(timeout=2):
                raise TimeoutError("test batch release timed out")
            return [], "native"
        finally:
            with calls_lock:
                active -= 1

    app._search_cache.clear()
    monkeypatch.setattr(app, "_batch_semaphore", asyncio.Semaphore(concurrency))
    monkeypatch.setattr(app, "BATCH_DELAY_MIN", 0)
    monkeypatch.setattr(app, "BATCH_DELAY_MAX", 0)
    monkeypatch.setattr(app, "_search_with_mode_fallback", blocked_search)
    queries = [
        {"query": "cancelled", "filter": filter_name, "limit": 20}
        for filter_name in ("songs", "albums", "artists")
    ]

    first = asyncio.create_task(
        client.post("/search/batch?user_id=user-1", json={"queries": queries})
    )
    second: asyncio.Task[Any] | None = None
    try:
        await _wait_for_thread_event(started)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first

        second = asyncio.create_task(
            client.post("/search/batch?user_id=user-2", json={"queries": queries})
        )
        await asyncio.sleep(0.05)

        assert not second.done()
        assert calls == concurrency
        assert max_active == concurrency

        release.set()
        response = await second

        assert response.status_code == 200
        assert len(response.json()["results"]) == 3
        assert calls == 6
        assert max_active == concurrency
    finally:
        release.set()
        pending = [task for task in (first, second) if task is not None]
        await asyncio.gather(*pending, return_exceptions=True)
