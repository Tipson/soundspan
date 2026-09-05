"""Shared queued admission for concurrent YouTube Music search batches."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
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
async def test_waiter_reaps_a_completed_shared_job_before_admitting_more_work() -> None:
    """A completed row releases capacity even before its scheduled callback runs."""
    import app

    query = "already completed"
    filter_name = "songs"
    limit = 20
    key = app._public_search_key(query, filter_name, limit)
    completed = asyncio.get_running_loop().create_future()
    completed.set_result(([], "native"))
    app._search_cache.clear()
    app._search_provider_jobs.clear()
    app._search_provider_jobs[key] = completed

    try:
        result = await app._run_search_provider("user-1", query, filter_name, limit)

        assert result == ([], "native")
        assert key not in app._search_provider_jobs
        assert app._get_cached_public_search(query, filter_name, limit) == result
    finally:
        app._search_provider_jobs.pop(key, None)
        app._search_cache.clear()


@pytest.mark.anyio
async def test_late_completed_job_cannot_overwrite_or_retire_its_replacement() -> None:
    """A delayed callback from an old flight cannot publish over a newer flight."""
    import app

    query = "replacement race"
    filter_name = "songs"
    limit = 20
    key = app._public_search_key(query, filter_name, limit)
    loop = asyncio.get_running_loop()
    completed = loop.create_future()
    completed.set_result(([], "native"))
    replacement = loop.create_future()
    app._search_cache.clear()
    app._search_provider_jobs.clear()
    app._search_provider_jobs[key] = replacement

    try:
        app._consume_search_provider_job(key, completed)

        assert app._search_provider_jobs[key] is replacement
        assert app._get_cached_public_search(query, filter_name, limit) is None
    finally:
        replacement.cancel()
        app._search_provider_jobs.pop(key, None)
        app._search_cache.clear()


@pytest.mark.anyio
async def test_new_key_reaps_completed_jobs_before_applying_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Completed other-key flights must not cause a transient false 503."""
    import app

    concurrency = 3
    executor = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="test-search-completed-capacity",
    )
    loop = asyncio.get_running_loop()
    completed_queries = [f"completed-{index}" for index in range(concurrency)]
    app._search_cache.clear()
    app._search_provider_jobs.clear()
    monkeypatch.setattr(app, "SEARCH_PROVIDER_CONCURRENCY", concurrency)
    monkeypatch.setattr(app, "_search_provider_executor", executor)
    monkeypatch.setattr(app, "_search_with_mode_fallback", lambda *args: ([], "native"))
    for query in completed_queries:
        job = loop.create_future()
        job.set_result(([], "native"))
        app._search_provider_jobs[app._public_search_key(query, "songs", 20)] = job

    submitted: asyncio.Future[Any] | None = None
    try:
        submitted = app._submit_search_provider_job(
            "user-1",
            "new-key",
            "songs",
            20,
        )
        assert await submitted == ([], "native")
        assert all(
            app._get_cached_public_search(query, "songs", 20) == ([], "native")
            for query in completed_queries
        )
    finally:
        if submitted is not None:
            await asyncio.gather(submitted, return_exceptions=True)
        app._search_provider_jobs.clear()
        app._search_cache.clear()
        executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.anyio
async def test_two_discovery_batches_share_cross_user_provider_flights(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Identical public batch rows join one provider flight per search key."""
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
        assert calls == 3
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
        assert calls == 3
        assert max_active == concurrency
    finally:
        release.set()
        pending = [task for task in (first, second) if task is not None]
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.anyio
async def test_batch_rows_use_the_shared_bounded_endpoint_deadline(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Batch rows fail independently without queueing beyond the endpoint budget."""
    import app

    concurrency = 3
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def blocked_search(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == concurrency:
            started.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test batch release timed out")
        return [], "native"

    executor = ThreadPoolExecutor(
        max_workers=concurrency,
        thread_name_prefix="test-search-batch-deadline",
    )
    app._search_cache.clear()
    app._search_provider_jobs.clear()
    monkeypatch.setattr(app, "SEARCH_PROVIDER_CONCURRENCY", concurrency)
    monkeypatch.setattr(app, "SEARCH_ENDPOINT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(app, "_search_provider_executor", executor)
    monkeypatch.setattr(app, "_search_with_mode_fallback", blocked_search)
    queries = [
        {"query": f"deadline-{index}", "filter": "songs", "limit": 20}
        for index in range(concurrency)
    ]

    try:
        before = asyncio.get_running_loop().time()
        response = await client.post("/search/batch?user_id=user-1", json={"queries": queries})
        elapsed = asyncio.get_running_loop().time() - before

        assert started.is_set()
        assert response.status_code == 200
        assert elapsed < 0.2
        assert [row["error"] for row in response.json()["results"]] == [
            app._SEARCH_PROVIDER_TIMEOUT_DETAIL,
        ] * concurrency
        assert len(app._search_provider_jobs) == concurrency
    finally:
        provider_jobs = list(app._search_provider_jobs.values())
        release.set()
        await asyncio.wait_for(
            asyncio.gather(*provider_jobs, return_exceptions=True),
            timeout=1,
        )
        executor.shutdown(wait=True, cancel_futures=True)
