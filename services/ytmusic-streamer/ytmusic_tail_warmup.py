"""Bounded, generation-aware warmup for the upcoming playback tail."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Coroutine, Sequence
from contextlib import suppress
from dataclasses import dataclass, replace
from typing import Annotated, Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from ytmusic_runtime import JsonObject, app, log
from ytmusic_stream import is_ytmusic_spooled, warm_ytmusic_spool

from services.common.sidecar_runtime_utils import env_float, env_int

WarmupStatus = Literal["miss", "queued", "readable", "complete", "failed"]
WarmupKey = tuple[str, str]
ReadableCallback = Callable[[], None]
WarmCallback = Callable[[str, str, ReadableCallback], Coroutine[Any, Any, None]]
ProbeCallback = Callable[[str, str], Coroutine[Any, Any, bool]]

TAIL_WARMUP_CONCURRENCY = 1
TAIL_WARMUP_CAPACITY = 4
TAIL_WARMUP_OWNER_CAPACITY = max(
    128,
    min(4096, env_int("YTMUSIC_TAIL_WARMUP_OWNER_CAPACITY", "512")),
)
TAIL_WARMUP_OWNER_TTL_SECONDS = max(
    30.0,
    env_float("YTMUSIC_TAIL_WARMUP_OWNER_TTL_SECONDS", "300"),
)
TAIL_WARMUP_SWEEP_INTERVAL_SECONDS = max(
    1.0,
    min(30.0, TAIL_WARMUP_OWNER_TTL_SECONDS / 2),
)

VideoId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{11}$")]
OwnerId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]


class TailWarmupReconcileRequest(BaseModel):
    """One player instance's complete desired warmup generation."""

    model_config = ConfigDict(populate_by_name=True)

    owner_id: OwnerId = Field(alias="ownerId")
    generation: int = Field(ge=0)
    quality: Literal["LOW", "MEDIUM", "HIGH", "LOSSLESS"]
    current: VideoId | None = None
    immediate: VideoId | None = None
    tail: list[VideoId] = Field(default_factory=list, max_length=TAIL_WARMUP_CAPACITY)


@dataclass(frozen=True)
class _Interest:
    generation: int
    priority: int
    order: int


@dataclass(frozen=True)
class _OwnerPlan:
    generation: int
    requested: tuple[tuple[WarmupKey, int], ...]
    last_seen_at: float

    @property
    def keys(self) -> tuple[WarmupKey, ...]:
        return tuple(key for key, _priority in self.requested)


@dataclass
class _WarmupJob:
    key: WarmupKey
    status: Literal["queued", "readable"] = "queued"
    active: bool = False
    task: asyncio.Task[None] | None = None


class TailWarmupClosed(RuntimeError):
    """Reject new generations after process shutdown begins."""


class TailWarmupOwnerCapacityExceeded(RuntimeError):
    """Reject an owner only when every retained owner is currently in flight."""


class TailWarmupCoordinator:
    """Hide global admission, interest, priority, and cancellation policy."""

    def __init__(
        self,
        warm: WarmCallback,
        probe: ProbeCallback,
        *,
        capacity: int = TAIL_WARMUP_CAPACITY,
        owner_capacity: int = TAIL_WARMUP_OWNER_CAPACITY,
        owner_ttl_seconds: float = TAIL_WARMUP_OWNER_TTL_SECONDS,
        sweep_interval_seconds: float = TAIL_WARMUP_SWEEP_INTERVAL_SECONDS,
    ) -> None:
        if capacity < TAIL_WARMUP_CONCURRENCY:
            raise ValueError("tail warmup capacity must allow its active lane")
        if owner_capacity < 1:
            raise ValueError("tail warmup owner capacity must be positive")
        if owner_ttl_seconds <= 0 or sweep_interval_seconds <= 0:
            raise ValueError("tail warmup owner lifecycle intervals must be positive")
        self._warm = warm
        self._probe = probe
        self._capacity = capacity
        self._owner_capacity = owner_capacity
        self._owner_ttl_seconds = owner_ttl_seconds
        self._sweep_interval_seconds = sweep_interval_seconds
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._owners: dict[str, _OwnerPlan] = {}
        self._interests: dict[WarmupKey, dict[str, _Interest]] = {}
        self._jobs: dict[WarmupKey, _WarmupJob] = {}
        self._completed: set[WarmupKey] = set()
        self._failed: dict[WarmupKey, dict[str, int]] = {}
        self._versions: dict[WarmupKey, int] = {}
        self._worker: asyncio.Task[None] | None = None
        self._sweeper: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._next_order = 0
        self._next_request_token = 0
        self._owner_request_tokens: dict[str, int] = {}
        self._owner_inflight: dict[str, int] = {}
        self._admitting = True

    @staticmethod
    def _requested_keys(
        quality: str,
        current: str | None,
        immediate: str | None,
        tail: Sequence[str],
    ) -> tuple[tuple[WarmupKey, int], ...]:
        ranked: list[tuple[WarmupKey, int]] = []
        seen: set[WarmupKey] = set()
        for priority, video_ids in (
            (0, (() if current is None else (current,))),
            (1, (() if immediate is None else (immediate,))),
            (2, tail),
        ):
            for video_id in video_ids:
                key = (video_id, quality)
                if key not in seen:
                    seen.add(key)
                    ranked.append((key, priority))
        return tuple(ranked)

    async def _probe_requested(
        self, requested: Sequence[tuple[WarmupKey, int]]
    ) -> dict[WarmupKey, bool | None]:
        keys = [key for key, _priority in requested]
        results = await asyncio.gather(
            *(self._probe(video_id, quality) for video_id, quality in keys),
            return_exceptions=True,
        )
        return {
            key: result if isinstance(result, bool) else None
            for key, result in zip(keys, results, strict=True)
        }

    def _purge_uninterested_key_locked(self, key: WarmupKey) -> None:
        if self._interests.get(key):
            return
        job = self._jobs.pop(key, None)
        if job is not None:
            self._cancel_job_locked(job)
        self._completed.discard(key)
        self._failed.pop(key, None)
        self._versions.pop(key, None)

    def _remove_owner_locked(
        self,
        owner_id: str,
        *,
        preserve_keys: frozenset[WarmupKey] = frozenset(),
    ) -> None:
        previous = self._owners.pop(owner_id, None)
        if previous is None:
            return
        for key in previous.keys:
            interested = self._interests.get(key)
            if interested is not None:
                interested.pop(owner_id, None)
                if not interested:
                    self._interests.pop(key, None)
            failures = self._failed.get(key)
            if failures is not None:
                failures.pop(owner_id, None)
                if not failures:
                    self._failed.pop(key, None)
            if key not in preserve_keys:
                self._purge_uninterested_key_locked(key)

    def _evict_owner_locked(self, owner_id: str) -> None:
        self._remove_owner_locked(owner_id)
        self._owner_request_tokens.pop(owner_id, None)

    def _evict_expired_owners_locked(self, now: float) -> int:
        expired = [
            owner_id
            for owner_id, plan in self._owners.items()
            if not self._owner_inflight.get(owner_id)
            and now - plan.last_seen_at >= self._owner_ttl_seconds
        ]
        for owner_id in expired:
            self._evict_owner_locked(owner_id)
        return len(expired)

    def _make_owner_room_locked(self, owner_id: str, now: float) -> None:
        if owner_id in self._owners:
            return
        self._evict_expired_owners_locked(now)
        while len(self._owners) >= self._owner_capacity:
            idle = [
                (plan.last_seen_at, retained_owner)
                for retained_owner, plan in self._owners.items()
                if not self._owner_inflight.get(retained_owner)
            ]
            if not idle:
                raise TailWarmupOwnerCapacityExceeded("tail warmup owner capacity is busy")
            _last_seen_at, oldest_owner = min(idle)
            self._evict_owner_locked(oldest_owner)

    def _replace_owner_locked(
        self,
        owner_id: str,
        generation: int,
        requested: Sequence[tuple[WarmupKey, int]],
        now: float,
    ) -> None:
        previous = self._owners.get(owner_id)
        preserved_failures = {
            key
            for key in (() if previous is None else previous.keys)
            if self._failed.get(key, {}).get(owner_id) == generation
        }
        retained_keys = frozenset(key for key, _priority in requested)
        self._remove_owner_locked(owner_id, preserve_keys=retained_keys)
        for key, priority in requested:
            self._next_order += 1
            self._interests.setdefault(key, {})[owner_id] = _Interest(
                generation=generation,
                priority=priority,
                order=self._next_order,
            )
            if key in preserved_failures:
                self._failed.setdefault(key, {})[owner_id] = generation
        self._owners[owner_id] = _OwnerPlan(
            generation=generation,
            requested=tuple(requested),
            last_seen_at=now,
        )

    def _job_score_locked(self, key: WarmupKey) -> tuple[int, int]:
        return min(
            (interest.priority, interest.order) for interest in self._interests[key].values()
        )

    def _has_retry_interest_locked(self, key: WarmupKey) -> bool:
        failures = self._failed.get(key, {})
        return any(
            failures.get(owner_id) != interest.generation
            for owner_id, interest in self._interests.get(key, {}).items()
        )

    def _cancel_job_locked(self, job: _WarmupJob) -> None:
        if job.task is not None and not job.task.done():
            job.task.cancel()

    def _rebalance_locked(self) -> None:
        """Admit the globally best four keys while never preempting active I/O."""
        for key, job in tuple(self._jobs.items()):
            if key not in self._interests or key in self._completed:
                self._jobs.pop(key, None)
                self._cancel_job_locked(job)

        if not self._admitting:
            for key, job in tuple(self._jobs.items()):
                if not job.active:
                    self._jobs.pop(key, None)
            self._wake.set()
            return

        candidates = [
            key
            for key in self._interests
            if key not in self._completed and self._has_retry_interest_locked(key)
        ]
        active = next((job for job in self._jobs.values() if job.active), None)
        desired: list[WarmupKey] = []
        if active is not None and active.key in candidates:
            desired.append(active.key)
        for key in sorted(candidates, key=self._job_score_locked):
            if key not in desired and len(desired) < self._capacity:
                desired.append(key)

        desired_set = set(desired)
        for key, job in tuple(self._jobs.items()):
            if key not in desired_set and not job.active:
                self._jobs.pop(key, None)
        for key in desired:
            if key not in self._jobs:
                self._failed.pop(key, None)
                self._jobs[key] = _WarmupJob(key)

        self._ensure_runtime_tasks_locked()
        self._wake.set()

    def _ensure_runtime_tasks_locked(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(
                self._worker_loop(),
                name="ytmusic-tail-warmup",
            )
        if self._sweeper is None or self._sweeper.done():
            self._sweeper = asyncio.create_task(
                self._owner_sweeper_loop(),
                name="ytmusic-tail-warmup-owner-sweeper",
            )

    async def stats(self) -> JsonObject:
        """Return bounded aggregate state without exposing owner or track ids."""
        async with self._lock:
            active_jobs = sum(job.active for job in self._jobs.values())
            return {
                "owners": len(self._owners),
                "interests": sum(len(owners) for owners in self._interests.values()),
                "jobs": len(self._jobs),
                "activeJobs": active_jobs,
                "queuedJobs": len(self._jobs) - active_jobs,
                "completed": len(self._completed),
                "failures": len(self._failed),
                "versions": len(self._versions),
                "inflightOwners": len(self._owner_inflight),
            }

    def _status_locked(self, owner_id: str, key: WarmupKey) -> WarmupStatus:
        if key in self._completed:
            return "complete"
        job = self._jobs.get(key)
        if job is not None:
            return job.status
        plan = self._owners[owner_id]
        if self._failed.get(key, {}).get(owner_id) == plan.generation:
            return "failed"
        return "miss"

    def _snapshot_locked(self, owner_id: str, *, accepted: bool) -> JsonObject:
        plan = self._owners[owner_id]
        return {
            "ownerId": owner_id,
            "generation": plan.generation,
            "accepted": accepted,
            "items": [
                {
                    "videoId": video_id,
                    "quality": quality,
                    "status": self._status_locked(owner_id, key),
                }
                for key in plan.keys
                for video_id, quality in (key,)
            ],
        }

    async def reconcile(
        self,
        *,
        owner_id: str,
        generation: int,
        quality: str,
        current: str | None,
        immediate: str | None,
        tail: Sequence[str],
    ) -> JsonObject:
        """Replace one owner's interests and return a body-free status snapshot."""
        requested = self._requested_keys(quality, current, immediate, tail)
        request_token = 0
        inflight = False
        try:
            async with self._lock:
                if not self._admitting:
                    raise TailWarmupClosed("tail warmup is shutting down")
                now = time.monotonic()
                self._evict_expired_owners_locked(now)
                existing = self._owners.get(owner_id)
                if existing is not None and generation < existing.generation:
                    return self._snapshot_locked(owner_id, accepted=False)
                self._make_owner_room_locked(owner_id, now)
                self._owner_inflight[owner_id] = self._owner_inflight.get(owner_id, 0) + 1
                inflight = True
                self._next_request_token += 1
                request_token = self._next_request_token
                self._owner_request_tokens[owner_id] = request_token
                if (
                    existing is None
                    or generation > existing.generation
                    or tuple(requested) != existing.requested
                ):
                    self._replace_owner_locked(owner_id, generation, requested, now)
                else:
                    self._owners[owner_id] = replace(existing, last_seen_at=now)
                versions = {key: self._versions.get(key, 0) for key, _priority in requested}
                self._ensure_runtime_tasks_locked()

            probes = await self._probe_requested(requested)

            async with self._lock:
                if not self._admitting:
                    raise TailWarmupClosed("tail warmup is shutting down")
                if self._owner_request_tokens.get(owner_id) != request_token:
                    return self._snapshot_locked(owner_id, accepted=False)

                plan = self._owners[owner_id]
                for key in plan.keys:
                    probe_state = probes.get(key)
                    if probe_state is True:
                        self._completed.add(key)
                    elif probe_state is False and self._versions.get(key, 0) == versions.get(
                        key, 0
                    ):
                        self._completed.discard(key)
                self._rebalance_locked()
                return self._snapshot_locked(owner_id, accepted=True)
        finally:
            if inflight:
                async with self._lock:
                    remaining = self._owner_inflight.get(owner_id, 1) - 1
                    if remaining > 0:
                        self._owner_inflight[owner_id] = remaining
                    else:
                        self._owner_inflight.pop(owner_id, None)
                    if (
                        self._owner_request_tokens.get(owner_id) == request_token
                        and owner_id in self._owners
                    ):
                        self._owners[owner_id] = replace(
                            self._owners[owner_id],
                            last_seen_at=time.monotonic(),
                        )

    def _notify_readable(self, key: WarmupKey, job: _WarmupJob) -> None:
        loop = self._loop
        if loop is not None:
            with suppress(RuntimeError):
                loop.call_soon_threadsafe(self._mark_readable, key, job)

    def _mark_readable(self, key: WarmupKey, job: _WarmupJob) -> None:
        if self._jobs.get(key) is job:
            job.status = "readable"

    async def _finish_job(
        self,
        job: _WarmupJob,
        *,
        completed: bool,
        failed: bool,
    ) -> None:
        async with self._lock:
            key = job.key
            if self._jobs.get(key) is job:
                self._jobs.pop(key, None)
            job.active = False
            job.task = None
            if key not in self._interests:
                self._purge_uninterested_key_locked(key)
            elif completed:
                self._completed.add(key)
                self._failed.pop(key, None)
                self._versions[key] = self._versions.get(key, 0) + 1
            elif failed:
                self._failed[key] = {
                    owner_id: interest.generation
                    for owner_id, interest in self._interests.get(key, {}).items()
                }
            self._rebalance_locked()

    async def _owner_sweeper_loop(self) -> None:
        """Expire lost player instances even when no further request arrives."""
        while True:
            await asyncio.sleep(self._sweep_interval_seconds)
            async with self._lock:
                if not self._admitting:
                    return
                if self._evict_expired_owners_locked(time.monotonic()):
                    self._rebalance_locked()

    async def _worker_loop(self) -> None:
        try:
            while True:
                await self._wake.wait()
                async with self._lock:
                    self._wake.clear()
                    if not self._admitting:
                        return
                    queued = [job for job in self._jobs.values() if not job.active]
                    if not queued:
                        continue
                    job = min(queued, key=lambda candidate: self._job_score_locked(candidate.key))
                    job.active = True
                    video_id, quality = job.key

                    def on_readable(
                        key: WarmupKey = job.key,
                        selected: _WarmupJob = job,
                    ) -> None:
                        self._notify_readable(key, selected)

                    job.task = asyncio.create_task(
                        self._warm(
                            video_id,
                            quality,
                            on_readable,
                        )
                    )
                    task = job.task

                completed = False
                failed = False
                try:
                    await task
                    completed = True
                except asyncio.CancelledError:
                    pass
                except Exception:
                    failed = True
                    log.warning("YouTube Music tail warmup failed for %s", video_id)
                await self._finish_job(job, completed=completed, failed=failed)
        except asyncio.CancelledError:
            async with self._lock:
                active_tasks = [
                    job.task
                    for job in self._jobs.values()
                    if job.task is not None and not job.task.done()
                ]
                for task in active_tasks:
                    task.cancel()
            for task in active_tasks:
                with suppress(asyncio.CancelledError):
                    await task
            raise

    async def shutdown(self) -> None:
        """Reject new generations and release every tail-owned spool lease."""
        async with self._lock:
            self._admitting = False
            worker = self._worker
            sweeper = self._sweeper
            background_tasks = tuple(task for task in (worker, sweeper) if task is not None)
            for task in background_tasks:
                if not task.done():
                    task.cancel()
        for task in background_tasks:
            with suppress(asyncio.CancelledError):
                await task
        async with self._lock:
            self._jobs.clear()
            self._interests.clear()
            self._owners.clear()
            self._failed.clear()
            self._completed.clear()
            self._versions.clear()
            self._owner_request_tokens.clear()
            self._owner_inflight.clear()


_tail_warmup = TailWarmupCoordinator(warm_ytmusic_spool, is_ytmusic_spooled)


@app.post("/tail-warmup/reconcile")
async def reconcile_tail_warmup(payload: TailWarmupReconcileRequest) -> JsonObject:
    """Reconcile one player generation without returning any audio bytes."""
    try:
        return await _tail_warmup.reconcile(
            owner_id=payload.owner_id,
            generation=payload.generation,
            quality=payload.quality,
            current=payload.current,
            immediate=payload.immediate,
            tail=payload.tail,
        )
    except (TailWarmupClosed, TailWarmupOwnerCapacityExceeded) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


async def shutdown_tail_warmup() -> None:
    """Release tail interests before shutting down the shared spool."""
    await _tail_warmup.shutdown()
