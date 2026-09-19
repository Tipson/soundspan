"""Behavioral contract for bounded, generation-aware tail warmup."""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import pytest
from httpx import AsyncClient

if TYPE_CHECKING:
    from ytmusic_tail_warmup import TailWarmupCoordinator


class _FakeWarmer:
    def __init__(self) -> None:
        self.attempts: Counter[str] = Counter()
        self.cached: set[tuple[str, str]] = set()
        self.cancelled: list[str] = []
        self.fail_once: set[str] = set()
        self.publish_readable: set[str] = set()
        self.releases: dict[str, asyncio.Event] = {}
        self.started_order: list[str] = []
        self.changed = asyncio.Event()

    async def probe(self, video_id: str, quality: str) -> bool:
        return (video_id, quality) in self.cached

    async def warm(
        self,
        video_id: str,
        quality: str,
        on_readable: Callable[[], None],
    ) -> None:
        self.attempts[video_id] += 1
        self.started_order.append(video_id)
        self.changed.set()
        self.changed = asyncio.Event()
        if video_id in self.publish_readable:
            on_readable()
        try:
            await self.releases.setdefault(video_id, asyncio.Event()).wait()
        except asyncio.CancelledError:
            self.cancelled.append(video_id)
            self.changed.set()
            self.changed = asyncio.Event()
            raise
        if video_id in self.fail_once and self.attempts[video_id] == 1:
            self.changed.set()
            self.changed = asyncio.Event()
            raise RuntimeError("provider failed")
        self.cached.add((video_id, quality))
        self.changed.set()
        self.changed = asyncio.Event()


def _status(snapshot: dict[str, Any], video_id: str) -> str:
    return str(next(item["status"] for item in snapshot["items"] if item["videoId"] == video_id))


async def _eventually(predicate: Callable[[], bool]) -> None:
    for _ in range(100):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition did not become true")


async def _eventually_stats(
    coordinator: TailWarmupCoordinator,
    predicate: Callable[[dict[str, Any]], bool],
) -> dict[str, Any]:
    for _ in range(100):
        stats = await coordinator.stats()
        if predicate(stats):
            return stats
        await asyncio.sleep(0.01)
    raise AssertionError("coordinator stats did not reach the expected state")


@pytest.mark.anyio
async def test_global_singleflight_is_shared_across_owners() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe)
    try:
        first = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )
        second = await coordinator.reconcile(
            owner_id="player-b",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )
        await _eventually(lambda: provider.attempts["video00001a"] == 1)

        assert _status(first, "video00001a") == "queued"
        assert _status(second, "video00001a") == "queued"
        assert provider.attempts["video00001a"] == 1

        provider.releases["video00001a"].set()
        await _eventually(lambda: ("video00001a", "HIGH") in provider.cached)
        completed = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )
        assert _status(completed, "video00001a") == "complete"
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_generation_releases_only_the_calling_owners_interest() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe)
    try:
        for owner in ("player-a", "player-b"):
            await coordinator.reconcile(
                owner_id=owner,
                generation=1,
                quality="HIGH",
                current=None,
                immediate=None,
                tail=["video00001a"],
            )
        await _eventually(lambda: provider.attempts["video00001a"] == 1)

        await coordinator.reconcile(
            owner_id="player-a",
            generation=2,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=[],
        )
        await asyncio.sleep(0)
        assert provider.cancelled == []

        await coordinator.reconcile(
            owner_id="player-b",
            generation=2,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=[],
        )
        await _eventually(lambda: provider.cancelled == ["video00001a"])
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_current_promotes_a_miss_into_the_bounded_tail_lane() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe, capacity=4)
    tails = ["video00001a", "video00001b", "video00001c", "video00001d"]
    try:
        await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=tails,
        )
        await _eventually(lambda: provider.started_order == ["video00001a"])

        urgent = await coordinator.reconcile(
            owner_id="player-b",
            generation=1,
            quality="HIGH",
            current="video00001e",
            immediate=None,
            tail=[],
        )
        existing = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=tails,
        )

        assert _status(urgent, "video00001e") == "queued"
        assert _status(existing, "video00001d") == "miss"
        stats = await coordinator.stats()
        assert stats["activeJobs"] == 1
        assert stats["queuedJobs"] == 3

        provider.releases["video00001a"].set()
        await _eventually(lambda: provider.started_order[:2] == ["video00001a", "video00001e"])
        assert max(provider.attempts.values()) == 1
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_owner_lru_bounds_metadata_beyond_one_hundred_listeners() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(
        provider.warm,
        provider.probe,
        owner_capacity=128,
        owner_ttl_seconds=60,
        sweep_interval_seconds=30,
    )
    try:
        for index in range(150):
            await coordinator.reconcile(
                owner_id=f"player-{index:03d}",
                generation=1,
                quality="HIGH",
                current=None,
                immediate=None,
                tail=[],
            )

        stats = await coordinator.stats()
        assert stats == {
            "owners": 128,
            "interests": 0,
            "jobs": 0,
            "activeJobs": 0,
            "queuedJobs": 0,
            "completed": 0,
            "failures": 0,
            "versions": 0,
            "inflightOwners": 0,
        }
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_lost_unmount_interest_expires_and_cancels_its_warm_lease() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(
        provider.warm,
        provider.probe,
        owner_ttl_seconds=0.05,
        sweep_interval_seconds=0.01,
    )
    try:
        await coordinator.reconcile(
            owner_id="lost-player",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )
        await _eventually(lambda: provider.attempts["video00001a"] == 1)
        await _eventually(lambda: provider.cancelled == ["video00001a"])

        stats = await coordinator.stats()
        assert stats["owners"] == 0
        assert stats["interests"] == 0
        assert stats["jobs"] == 0
        assert stats["completed"] == 0
        assert stats["versions"] == 0
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_inflight_current_reconcile_is_protected_from_ttl_and_lru() -> None:
    from ytmusic_tail_warmup import (
        TailWarmupCoordinator,
        TailWarmupOwnerCapacityExceeded,
    )

    provider = _FakeWarmer()
    probe_started = asyncio.Event()
    release_probe = asyncio.Event()

    async def slow_probe(video_id: str, quality: str) -> bool:
        probe_started.set()
        await release_probe.wait()
        return await provider.probe(video_id, quality)

    coordinator = TailWarmupCoordinator(
        provider.warm,
        slow_probe,
        owner_capacity=1,
        owner_ttl_seconds=0.03,
        sweep_interval_seconds=0.01,
    )
    try:
        current = asyncio.create_task(
            coordinator.reconcile(
                owner_id="active-player",
                generation=7,
                quality="HIGH",
                current="video00001a",
                immediate=None,
                tail=[],
            )
        )
        await asyncio.wait_for(probe_started.wait(), timeout=1)
        await asyncio.sleep(0.06)

        stats = await coordinator.stats()
        assert stats["owners"] == 1
        assert stats["inflightOwners"] == 1
        with pytest.raises(TailWarmupOwnerCapacityExceeded):
            await coordinator.reconcile(
                owner_id="other-player",
                generation=1,
                quality="HIGH",
                current=None,
                immediate=None,
                tail=[],
            )

        release_probe.set()
        snapshot = await asyncio.wait_for(current, timeout=1)
        assert snapshot["accepted"] is True
        assert snapshot["generation"] == 7
        assert snapshot["items"][0]["videoId"] == "video00001a"
    finally:
        release_probe.set()
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_readable_and_failed_are_observable_without_an_audio_body() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    provider.publish_readable.add("video00001a")
    provider.fail_once.add("video00001b")
    provider.releases["video00001b"] = asyncio.Event()
    provider.releases["video00001b"].set()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe)
    try:
        await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )
        await _eventually(lambda: provider.attempts["video00001a"] == 1)
        readable = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )
        assert _status(readable, "video00001a") == "readable"

        provider.releases["video00001a"].set()
        await _eventually(lambda: ("video00001a", "HIGH") in provider.cached)
        await coordinator.reconcile(
            owner_id="player-a",
            generation=2,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001b"],
        )
        await _eventually(lambda: provider.attempts["video00001b"] == 1)
        failed = await coordinator.reconcile(
            owner_id="player-a",
            generation=2,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001b"],
        )
        assert _status(failed, "video00001b") == "failed"

        await coordinator.reconcile(
            owner_id="player-a",
            generation=3,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001b"],
        )
        await _eventually(lambda: provider.attempts["video00001b"] == 2)
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_stale_generation_is_ignored() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe)
    try:
        await coordinator.reconcile(
            owner_id="player-a",
            generation=2,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001b"],
        )
        stale = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001a"],
        )

        assert stale["accepted"] is False
        assert stale["generation"] == 2
        assert [item["videoId"] for item in stale["items"]] == ["video00001b"]
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_same_generation_can_expand_after_preload_readiness() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe)
    try:
        await coordinator.reconcile(
            owner_id="player-a",
            generation=4,
            quality="HIGH",
            current="video00001a",
            immediate="video00001b",
            tail=[],
        )
        expanded = await coordinator.reconcile(
            owner_id="player-a",
            generation=4,
            quality="HIGH",
            current="video00001a",
            immediate="video00001b",
            tail=["video00001c", "video00001d"],
        )

        assert expanded["accepted"] is True
        assert expanded["generation"] == 4
        assert [item["videoId"] for item in expanded["items"]] == [
            "video00001a",
            "video00001b",
            "video00001c",
            "video00001d",
        ]
        assert all(item["status"] == "queued" for item in expanded["items"])
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_slower_same_generation_reconcile_cannot_overwrite_a_newer_call() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    slow_probe_started = asyncio.Event()
    release_slow_probe = asyncio.Event()

    async def ordered_probe(video_id: str, quality: str) -> bool:
        if video_id == "video00001a":
            slow_probe_started.set()
            await release_slow_probe.wait()
        return await provider.probe(video_id, quality)

    coordinator = TailWarmupCoordinator(provider.warm, ordered_probe)
    try:
        slower = asyncio.create_task(
            coordinator.reconcile(
                owner_id="player-a",
                generation=4,
                quality="HIGH",
                current=None,
                immediate=None,
                tail=["video00001a"],
            )
        )
        await asyncio.wait_for(slow_probe_started.wait(), timeout=1)
        newer = await coordinator.reconcile(
            owner_id="player-a",
            generation=4,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=["video00001b"],
        )
        release_slow_probe.set()
        superseded = await asyncio.wait_for(slower, timeout=1)

        assert [item["videoId"] for item in newer["items"]] == ["video00001b"]
        assert superseded["accepted"] is False
        assert [item["videoId"] for item in superseded["items"]] == ["video00001b"]
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_probe_failure_does_not_downgrade_a_known_complete_item() -> None:
    from ytmusic_tail_warmup import TailWarmupCoordinator

    provider = _FakeWarmer()
    provider.cached.add(("video00001a", "HIGH"))
    probe_fails = False

    async def flaky_probe(video_id: str, quality: str) -> bool:
        if probe_fails:
            raise OSError("temporary spool lookup failure")
        return await provider.probe(video_id, quality)

    coordinator = TailWarmupCoordinator(provider.warm, flaky_probe)
    try:
        first = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current="video00001a",
            immediate=None,
            tail=[],
        )
        assert _status(first, "video00001a") == "complete"

        probe_fails = True
        degraded = await coordinator.reconcile(
            owner_id="player-a",
            generation=1,
            quality="HIGH",
            current="video00001a",
            immediate=None,
            tail=[],
        )
        assert _status(degraded, "video00001a") == "complete"
        assert provider.attempts["video00001a"] == 0
    finally:
        await coordinator.shutdown()


@pytest.mark.anyio
async def test_shutdown_cancels_active_tail_interest_and_closes_admission() -> None:
    from ytmusic_tail_warmup import TailWarmupClosed, TailWarmupCoordinator

    provider = _FakeWarmer()
    coordinator = TailWarmupCoordinator(provider.warm, provider.probe)
    await coordinator.reconcile(
        owner_id="player-a",
        generation=1,
        quality="HIGH",
        current=None,
        immediate=None,
        tail=["video00001a"],
    )
    await _eventually(lambda: provider.attempts["video00001a"] == 1)

    await coordinator.shutdown()

    assert provider.cancelled == ["video00001a"]
    with pytest.raises(TailWarmupClosed):
        await coordinator.reconcile(
            owner_id="player-a",
            generation=2,
            quality="HIGH",
            current=None,
            immediate=None,
            tail=[],
        )


@pytest.mark.anyio
async def test_reconcile_route_is_json_only_and_uses_camel_case_contract(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app

    captured: dict[str, Any] = {}

    class FakeCoordinator:
        async def reconcile(self, **request: Any) -> dict[str, Any]:
            captured.update(request)
            return {
                "ownerId": request["owner_id"],
                "generation": request["generation"],
                "accepted": True,
                "items": [{"videoId": request["current"], "status": "complete"}],
            }

    monkeypatch.setattr(app, "_tail_warmup", FakeCoordinator())
    response = await client.post(
        "/tail-warmup/reconcile",
        json={
            "ownerId": "player-a",
            "generation": 7,
            "quality": "HIGH",
            "current": "video00001a",
            "immediate": "video00001b",
            "tail": ["video00001c"],
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["items"] == [{"videoId": "video00001a", "status": "complete"}]
    assert captured == {
        "owner_id": "player-a",
        "generation": 7,
        "quality": "HIGH",
        "current": "video00001a",
        "immediate": "video00001b",
        "tail": ["video00001c"],
    }


@pytest.mark.anyio
async def test_reconcile_route_bounds_each_owners_tail(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app

    class UnexpectedCoordinator:
        async def reconcile(self, **_request: Any) -> dict[str, Any]:
            return {"unexpected": True}

    monkeypatch.setattr(app, "_tail_warmup", UnexpectedCoordinator())
    response = await client.post(
        "/tail-warmup/reconcile",
        json={
            "ownerId": "player-a",
            "generation": 1,
            "quality": "HIGH",
            "current": None,
            "immediate": None,
            "tail": [
                "video00001a",
                "video00001b",
                "video00001c",
                "video00001d",
                "video00001e",
            ],
        },
    )

    assert response.status_code == 422
