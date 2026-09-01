"""Bounded process-pool and mixed-queue runtime helpers for AnalysisWorker."""

from __future__ import annotations

import gc
import json
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol, cast

from canonical_analysis import CanonicalAnalysisJob
from loudness_backfill import AnalysisQueueJob

logger = logging.getLogger("audio-analyzer")


class AnalysisWorkerRuntime(Protocol):
    db: Any
    redis: Any
    executor: Any
    pool_active: bool
    loudness_backfill_bookkeeping: Any

    def _ensure_pool(self) -> None: ...

    def _abort_process_pool(self) -> None: ...

    def _process_tracks_parallel(self, jobs: list[tuple[str, str]]) -> Any: ...

    def _release_queue_reservations(self, tracks: list[tuple[str, str]]) -> None: ...


def abort_process_pool(worker: AnalysisWorkerRuntime) -> None:
    """Force-stop timed-out children, then discard their executor."""
    executor = worker.executor
    if executor is None:
        worker.pool_active = False
        return
    logger.warning("Force-stopping timed-out analyzer process pool...")
    try:
        process_table = getattr(executor, "_processes", None)
        if not isinstance(process_table, dict):
            raise RuntimeError("Process pool does not expose owned worker processes")
        processes = list(process_table.values())
        for process in processes:
            if process.is_alive():
                process.terminate()
        terminate_deadline = time.monotonic() + 5.0
        for process in processes:
            process.join(timeout=max(0.0, terminate_deadline - time.monotonic()))
        survivors = [process for process in processes if process.is_alive()]
        for process in survivors:
            process.kill()
        kill_deadline = time.monotonic() + 5.0
        for process in survivors:
            process.join(timeout=max(0.0, kill_deadline - time.monotonic()))
        if any(process.is_alive() for process in survivors):
            raise RuntimeError("Timed-out analyzer processes could not be stopped")
    finally:
        try:
            executor.shutdown(wait=False, cancel_futures=True)
        finally:
            worker.executor = None
            worker.pool_active = False
            gc.collect()
    logger.info("Timed-out analyzer process pool stopped")


def process_mixed_analysis_batch(
    worker: AnalysisWorkerRuntime,
    *,
    batch_size: int,
    analysis_queue: str,
    brpop_timeout: int,
    analyze: Callable[..., Any],
    resolve_path: Callable[..., Any],
    analysis_version: str,
    batch_timeout_seconds: int,
    loudness_timeout_seconds: int,
    max_file_size_mb: int,
    load_queued_canonical_jobs: Callable[..., list[CanonicalAnalysisJob]],
    partition_canonical_jobs: Callable[
        ..., tuple[list[CanonicalAnalysisJob], list[dict[str, Any]]]
    ],
    process_canonical_jobs: Callable[..., Any],
    partition_legacy_jobs: Callable[..., tuple[list[tuple[str, str]], list[AnalysisQueueJob]]],
    process_loudness_jobs: Callable[..., Any],
) -> bool:
    """Block for and process one durable or legacy mixed queue batch."""
    durable_jobs = load_queued_canonical_jobs(worker.db, batch_size)
    if durable_jobs:
        _process_canonical_batch(
            worker,
            durable_jobs,
            analyze,
            resolve_path,
            analysis_version,
            batch_timeout_seconds,
            process_canonical_jobs,
        )
        return True

    result = worker.redis.brpop(analysis_queue, timeout=brpop_timeout)
    if result is None:
        return False
    _, first_job_data = result
    queued_jobs = [json.loads(first_job_data)]
    while len(queued_jobs) < batch_size:
        job_data = worker.redis.lpop(analysis_queue)
        if not job_data:
            break
        queued_jobs.append(json.loads(job_data))
    canonical_jobs, legacy_jobs = partition_canonical_jobs(queued_jobs)
    normal_jobs, loudness_jobs = partition_legacy_jobs(cast(list[AnalysisQueueJob], legacy_jobs))
    if normal_jobs:
        worker._process_tracks_parallel(normal_jobs)
    process_loudness_jobs(
        loudness_jobs,
        database=worker.db,
        release_reservations=worker._release_queue_reservations,
        resolve_path=resolve_path,
        max_file_size_mb=max_file_size_mb,
        timeout_seconds=loudness_timeout_seconds,
        bookkeeping=worker.loudness_backfill_bookkeeping,
    )
    if canonical_jobs:
        _process_canonical_batch(
            worker,
            canonical_jobs,
            analyze,
            resolve_path,
            analysis_version,
            batch_timeout_seconds,
            process_canonical_jobs,
        )
    return True


def _process_canonical_batch(
    worker: AnalysisWorkerRuntime,
    jobs: list[CanonicalAnalysisJob],
    analyze: Callable[..., Any],
    resolve_path: Callable[..., Any],
    analysis_version: str,
    timeout_seconds: int,
    process_canonical_jobs: Callable[..., Any],
) -> None:
    worker._ensure_pool()
    if worker.executor is None:
        raise RuntimeError("Canonical analyzer pool failed to start")
    process_canonical_jobs(
        jobs,
        database=worker.db,
        executor=worker.executor,
        analyze=analyze,
        resolve_path=resolve_path,
        analysis_version=analysis_version,
        timeout_seconds=timeout_seconds,
        terminate_executor=worker._abort_process_pool,
    )
