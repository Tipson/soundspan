"""Bounded admission and deadlines for public YouTube Music search."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
import requests
from httpx import AsyncClient


async def _wait_for_thread_event(event: threading.Event, wait_seconds: float = 1.0) -> None:
    """Wait for a worker-thread signal without blocking the event loop."""
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while not event.is_set():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("worker did not reach the expected state")
        await asyncio.sleep(0.005)


async def _wait_for_provider_jobs(app: Any, expected: int, wait_seconds: float = 1.0) -> None:
    """Wait until the search provider registry reaches an exact size."""
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while len(app._search_provider_jobs) != expected:
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError(
                f"provider registry has {len(app._search_provider_jobs)} jobs, expected {expected}"
            )
        await asyncio.sleep(0.005)


def test_search_budgets_finish_before_backend_abort() -> None:
    """The provider and endpoint budgets must leave margin inside backend's eight seconds."""
    import app

    assert (
        0 < app.SEARCH_PROVIDER_REQUEST_TIMEOUT_SECONDS < app.SEARCH_ENDPOINT_TIMEOUT_SECONDS < 8.0
    )


def test_public_search_fallback_does_not_pin_shared_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One public provider failure must not force future users into TV mode."""
    import app

    attempts: list[str] = []

    def search_once(
        _user_id: str,
        _query: str,
        _filter: Any,
        _limit: int,
        strategy: str,
        *,
        use_unauth_client: bool,
    ) -> list[dict[str, str]]:
        assert use_unauth_client is True
        attempts.append(strategy)
        if strategy == "native":
            raise RuntimeError("transient native failure")
        return [{"videoId": "dQw4w9WgXcQ"}]

    app._ytmusic_auto_tv_fallback_users.discard("__public__")
    monkeypatch.setattr(app, "SEARCH_MODE", "auto")
    monkeypatch.setattr(app, "_resolve_user_search_strategy", lambda _user_id: "native")
    monkeypatch.setattr(app, "_search_once", search_once)

    try:
        results, strategy = app._search_with_mode_fallback(
            "__public__",
            "Linkin Park",
            "songs",
            20,
            use_unauth_client=True,
        )
        assert results == [{"videoId": "dQw4w9WgXcQ"}]
        assert strategy == "tv"
        assert attempts == ["native", "tv"]
        assert "__public__" not in app._ytmusic_auto_tv_fallback_users
    finally:
        app._ytmusic_auto_tv_fallback_users.discard("__public__")


def test_authenticated_issue_813_fallback_remains_pinned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The exact authenticated #813 signature should retain its workaround."""
    import app

    class InvalidArgumentError(Exception):
        response = type(
            "Response",
            (),
            {
                "status_code": 400,
                "text": "Request contains an invalid argument",
            },
        )()

    def search_once(
        _user_id: str,
        _query: str,
        _filter: Any,
        _limit: int,
        strategy: str,
        *,
        use_unauth_client: bool,
    ) -> list[dict[str, str]]:
        assert use_unauth_client is False
        if strategy == "native":
            raise InvalidArgumentError()
        return []

    app._ytmusic_auto_tv_fallback_users.discard("user-813")
    monkeypatch.setattr(app, "SEARCH_MODE", "auto")
    monkeypatch.setattr(app, "_resolve_user_search_strategy", lambda _user_id: "native")
    monkeypatch.setattr(app, "_search_once", search_once)
    monkeypatch.setattr(app, "_invalidate_ytmusic", lambda _user_id: None)

    try:
        _results, strategy = app._search_with_mode_fallback(
            "user-813",
            "Linkin Park",
            "songs",
            20,
            use_unauth_client=False,
        )
        assert strategy == "tv"
        assert "user-813" in app._ytmusic_auto_tv_fallback_users
    finally:
        app._ytmusic_auto_tv_fallback_users.discard("user-813")


@pytest.mark.anyio
async def test_provider_timeout_returns_504_without_tv_fallback(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transport timeout must not spend a second budget on the TV fallback."""
    import app

    attempted_strategies: list[str] = []

    def timeout_provider(
        strategy: str,
        operation: str,
        func: Any,
        *,
        request_timeout_seconds: float,
        retry_timeouts: bool,
    ) -> Any:
        attempted_strategies.append(strategy)
        assert request_timeout_seconds == app.SEARCH_PROVIDER_REQUEST_TIMEOUT_SECONDS
        assert retry_timeouts is False
        raise requests.Timeout("provider stalled")

    app._search_cache.clear()
    monkeypatch.setattr(app, "SEARCH_MODE", "auto")
    monkeypatch.setattr(app, "_resolve_user_search_strategy", lambda _user_id: "native")
    monkeypatch.setattr(app, "_run_public_ytmusic_with_retry", timeout_provider)

    response = await client.post("/search?user_id=u1", json={"query": "timeout"})

    assert response.status_code == 504
    assert response.json() == {"error": app._SEARCH_PROVIDER_TIMEOUT_DETAIL}
    assert attempted_strategies == ["native"]


@pytest.mark.anyio
async def test_search_deadline_retains_blocked_workers_and_rejects_queueing(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Timed-out calls must hold bounded slots instead of forming an executor queue."""
    import app

    concurrency = 2
    executor = ThreadPoolExecutor(
        max_workers=concurrency,
        thread_name_prefix="test-search-provider",
    )
    started = threading.Event()
    release = threading.Event()
    calls_lock = threading.Lock()
    calls = 0

    def blocked_search(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        with calls_lock:
            calls += 1
            if calls == concurrency:
                started.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test provider release timed out")
        return [], "native"

    app._search_provider_jobs.clear()
    monkeypatch.setattr(app, "SEARCH_PROVIDER_CONCURRENCY", concurrency)
    monkeypatch.setattr(app, "SEARCH_ENDPOINT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(app, "_search_provider_executor", executor)
    monkeypatch.setattr(app, "_search_with_mode_fallback", blocked_search)

    first_requests = [
        asyncio.create_task(client.post(f"/search?user_id=u{index}", json={"query": "blocked"}))
        for index in range(concurrency)
    ]
    try:
        await _wait_for_thread_event(started)
        timed_out = await asyncio.gather(*first_requests)

        assert [response.status_code for response in timed_out] == [504, 504]
        assert len(app._search_provider_jobs) == concurrency

        before = asyncio.get_running_loop().time()
        saturated = await client.post("/search?user_id=u3", json={"query": "rejected"})
        elapsed = asyncio.get_running_loop().time() - before

        assert saturated.status_code == 503
        assert saturated.json() == {"error": app._SEARCH_PROVIDER_CAPACITY_DETAIL}
        assert elapsed < 0.2
        assert calls == concurrency
        assert len(app._search_provider_jobs) == concurrency

        release.set()
        await _wait_for_provider_jobs(app, 0)

        recovered = await client.post("/search?user_id=u4", json={"query": "recovered"})
        assert recovered.status_code == 200
        assert recovered.json() == {"results": [], "total": 0}
        assert calls == concurrency + 1
    finally:
        release.set()
        await asyncio.gather(*first_requests, return_exceptions=True)
        executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.anyio
async def test_search_endpoint_returns_before_its_budget(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A provider that ignores cancellation must still yield a bounded 504 response."""
    import app

    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-search-deadline")
    started = threading.Event()
    release = threading.Event()

    def blocked_search(*args: Any, **kwargs: Any) -> Any:
        started.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test provider release timed out")
        return [], "native"

    app._search_provider_jobs.clear()
    monkeypatch.setattr(app, "SEARCH_PROVIDER_CONCURRENCY", 1)
    monkeypatch.setattr(app, "SEARCH_ENDPOINT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(app, "_search_provider_executor", executor)
    monkeypatch.setattr(app, "_search_with_mode_fallback", blocked_search)

    try:
        before = asyncio.get_running_loop().time()
        response = await client.post("/search?user_id=u1", json={"query": "blocked"})
        elapsed = asyncio.get_running_loop().time() - before

        assert started.is_set()
        assert response.status_code == 504
        assert response.json() == {"error": app._SEARCH_PROVIDER_TIMEOUT_DETAIL}
        assert elapsed < 0.2
        assert len(app._search_provider_jobs) == 1
    finally:
        release.set()
        await _wait_for_provider_jobs(app, 0)
        executor.shutdown(wait=True, cancel_futures=True)
