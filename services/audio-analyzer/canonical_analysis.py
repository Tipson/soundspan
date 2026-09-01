"""Coordinate shared Essentia analysis for temporary remote audio assets."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, wait
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Protocol, TypedDict, cast

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("CanonicalAnalysis")


class CanonicalAnalysisJob(TypedDict, total=False):
    """Fields accepted from one remote canonical-analysis queue payload."""

    canonicalRecordingId: str
    filePath: str
    deleteAfter: bool
    leaseId: str


@dataclass(frozen=True)
class CanonicalAnalysisSummary:
    """Bounded outcome counts for one canonical-analysis batch."""

    completed: int = 0
    failed: int = 0
    retryable: int = 0
    skipped: int = 0
    cleanup_failed: int = 0


@dataclass(frozen=True)
class _ValidatedJob:
    """Validated coordinator-owned representation of a queue payload."""

    canonical_recording_id: str
    file_path: str
    delete_after: bool
    lease_id: str | None


class Cursor(Protocol):
    """Database cursor operations required by canonical persistence."""

    def execute(self, sql: str, params: object = None) -> None:
        """Execute one parameterized statement."""

    def fetchone(self) -> Mapping[str, Any] | None:
        """Return one result row when present."""

    def fetchall(self) -> list[Mapping[str, Any]]:
        """Return all rows from the current result set."""

    def close(self) -> None:
        """Close the cursor."""


class Database(Protocol):
    """Transaction operations required by canonical persistence."""

    def get_cursor(self) -> Cursor:
        """Return a database cursor."""

    def commit(self) -> None:
        """Commit the current transaction."""

    def rollback(self) -> None:
        """Roll back the current transaction."""


class Executor(Protocol):
    """Process-pool submission boundary used by the analyzer coordinator."""

    def submit(
        self,
        callable_: Callable[[tuple[str, str]], tuple[str, str, dict[str, Any]]],
        args: tuple[str, str],
    ) -> Future[tuple[str, str, dict[str, Any]]]:
        """Schedule one contained audio-analysis call."""


Analyze = Callable[[tuple[str, str]], tuple[str, str, dict[str, Any]]]
ResolvePath = Callable[[str], str | None]
TerminateExecutor = Callable[[], None]

_OWNED_SPOOL_DIRECTORY = ".soundspan-analysis-spool"


_MARK_STARTED_SQL = """
    UPDATE "CanonicalRecording"
    SET "analysisStatus" = 'processing',
        "analysisError" = NULL,
        "updatedAt" = NOW()
    WHERE id = %s
    RETURNING id
"""

_MARK_LEASE_STARTED_SQL = """
    UPDATE "AnalysisAssetLease"
    SET status = 'processing',
        error = NULL,
        "expiresAt" = NOW() + INTERVAL '2 hours',
        "updatedAt" = NOW()
    WHERE "canonicalRecordingId" = %s
    AND status = 'queued_essentia'
    AND "expiresAt" > NOW()
    AND (
        (%s::text IS NOT NULL AND id = %s)
        OR (%s::text IS NULL AND "spoolRef" = %s)
    )
    RETURNING id
"""

_LOAD_QUEUED_SQL = """
    SELECT
        id AS "leaseId",
        "canonicalRecordingId",
        "spoolRef" AS "filePath",
        TRUE AS "deleteAfter"
    FROM "AnalysisAssetLease"
    WHERE status = 'queued_essentia'
      AND "expiresAt" > NOW()
    ORDER BY "createdAt" ASC
    LIMIT %s
"""

_SAVE_CANONICAL_RESULTS_SQL = """
    UPDATE "CanonicalRecording"
    SET bpm = %s,
        key = %s,
        energy = %s,
        loudness = %s,
        valence = %s,
        danceability = %s,
        arousal = %s,
        instrumentalness = %s,
        acousticness = %s,
        speechiness = %s,
        "moodTags" = %s,
        "essentiaGenres" = %s,
        "analysisStatus" = 'completed',
        "analysisVersion" = %s,
        "analyzedAt" = NOW(),
        "analysisError" = NULL,
        "updatedAt" = NOW()
    WHERE id = %s
    RETURNING id
"""

_COMPLETE_LEASE_SQL = """
    UPDATE "AnalysisAssetLease"
    SET status = 'completed',
        error = NULL,
        "updatedAt" = NOW()
    WHERE "canonicalRecordingId" = %s
    AND status = 'processing'
    AND "expiresAt" > NOW()
    AND (
        (%s::text IS NOT NULL AND id = %s)
        OR (%s::text IS NULL AND "spoolRef" = %s)
    )
    RETURNING id
"""

_FAIL_CANONICAL_SQL = """
    UPDATE "CanonicalRecording"
    SET "analysisStatus" = 'failed',
        "analysisVersion" = %s,
        "analysisError" = %s,
        "updatedAt" = NOW()
    WHERE id = %s
    RETURNING id
"""

_FAIL_LEASE_SQL = """
    UPDATE "AnalysisAssetLease"
    SET status = 'failed',
        error = %s,
        "updatedAt" = NOW()
    WHERE "canonicalRecordingId" = %s
    AND status = 'processing'
    AND "expiresAt" > NOW()
    AND (
        (%s::text IS NOT NULL AND id = %s)
        OR (%s::text IS NULL AND "spoolRef" = %s)
    )
    RETURNING id
"""

_RETRY_CANONICAL_SQL = """
    UPDATE "CanonicalRecording"
    SET "analysisStatus" = 'pending',
        "analysisError" = %s,
        "updatedAt" = NOW()
    WHERE id = %s
    RETURNING id
"""

_RETRY_LEASE_SQL = """
    UPDATE "AnalysisAssetLease"
    SET status = 'retryable',
        error = %s,
        "updatedAt" = NOW()
    WHERE "canonicalRecordingId" = %s
    AND status = 'processing'
    AND "expiresAt" > NOW()
    AND (
        (%s::text IS NOT NULL AND id = %s)
        OR (%s::text IS NULL AND "spoolRef" = %s)
    )
    RETURNING id
"""

_CLEANUP_FAILED_LEASE_SQL = """
    UPDATE "AnalysisAssetLease"
    SET status = 'cleanup_failed',
        error = %s,
        "updatedAt" = NOW()
    WHERE "canonicalRecordingId" = %s
    AND (
        (%s::text IS NOT NULL AND id = %s)
        OR (%s::text IS NULL AND "spoolRef" = %s)
    )
"""


def partition_canonical_analysis_jobs(
    jobs: Sequence[Mapping[str, Any]],
) -> tuple[list[CanonicalAnalysisJob], list[dict[str, Any]]]:
    """Separate canonical jobs while preserving every legacy payload unchanged."""
    canonical: list[CanonicalAnalysisJob] = []
    legacy: list[dict[str, Any]] = []
    for job in jobs:
        copied = dict(job)
        if "canonicalRecordingId" in copied:
            canonical.append(copied)  # type: ignore[arg-type]
        else:
            legacy.append(copied)
    return canonical, legacy


def load_queued_canonical_analysis_jobs(
    database: Database,
    limit: int,
) -> list[CanonicalAnalysisJob]:
    """Load a bounded durable hand-off batch; each row is claimed later."""
    cursor = database.get_cursor()
    try:
        cursor.execute(_LOAD_QUEUED_SQL, (max(1, limit),))
        return [cast(CanonicalAnalysisJob, dict(row)) for row in cursor.fetchall()]
    except Exception as error:
        logger.warning("Failed to load canonical analysis leases: %s", type(error).__name__)
        database.rollback()
        return []
    finally:
        cursor.close()


def _validate_job(job: Mapping[str, Any]) -> _ValidatedJob | None:
    canonical_id = job.get("canonicalRecordingId")
    file_path = job.get("filePath")
    if not isinstance(canonical_id, str) or not canonical_id.strip():
        logger.warning("Skipping canonical analysis job without a valid recording id")
        return None
    if not isinstance(file_path, str) or not file_path.strip():
        logger.warning("Skipping canonical analysis job without a valid file path")
        return None
    lease_id_value = job.get("leaseId")
    lease_id = lease_id_value.strip() if isinstance(lease_id_value, str) else None
    return _ValidatedJob(
        canonical_recording_id=canonical_id.strip(),
        file_path=file_path,
        delete_after=job.get("deleteAfter") is True,
        lease_id=lease_id or None,
    )


def _lease_locator_values(
    job: _ValidatedJob,
) -> tuple[str, str | None, str | None, str | None, str]:
    """Select an asset lease by producer id or its unique spool reference."""
    return (
        job.canonical_recording_id,
        job.lease_id,
        job.lease_id,
        job.lease_id,
        job.file_path,
    )


def _mark_started(database: Database, job: _ValidatedJob) -> bool:
    cursor = database.get_cursor()
    try:
        cursor.execute(_MARK_STARTED_SQL, (job.canonical_recording_id,))
        if cursor.fetchone() is None:
            database.rollback()
            logger.warning("Skipping canonical analysis job for a missing recording")
            return False
        cursor.execute(_MARK_LEASE_STARTED_SQL, _lease_locator_values(job))
        if cursor.fetchone() is None:
            database.rollback()
            logger.info("Skipping canonical analysis job already claimed or expired")
            return False
        database.commit()
        return True
    except Exception as error:
        logger.warning("Failed to claim canonical analysis job: %s", type(error).__name__)
        database.rollback()
        return False
    finally:
        cursor.close()


def _canonical_result_values(
    canonical_id: str,
    features: Mapping[str, Any],
    analysis_version: str,
) -> tuple[Any, ...]:
    """Build bound scalar-feature values for one canonical recording."""
    return (
        features.get("bpm"),
        features.get("key"),
        features.get("energy"),
        features.get("loudness"),
        features.get("valence"),
        features.get("danceability"),
        features.get("arousal"),
        features.get("instrumentalness"),
        features.get("acousticness"),
        features.get("speechiness"),
        list(features.get("moodTags") or []),
        list(features.get("essentiaGenres") or []),
        analysis_version,
        canonical_id,
    )


def _persist_completed(
    database: Database,
    job: _ValidatedJob,
    features: Mapping[str, Any],
    analysis_version: str,
) -> bool:
    cursor = database.get_cursor()
    try:
        cursor.execute(_COMPLETE_LEASE_SQL, _lease_locator_values(job))
        if cursor.fetchone() is None:
            database.rollback()
            logger.info("Skipping canonical completion after lease ownership was lost")
            return False
        cursor.execute(
            _SAVE_CANONICAL_RESULTS_SQL,
            _canonical_result_values(job.canonical_recording_id, features, analysis_version),
        )
        if cursor.fetchone() is None:
            raise RuntimeError("Canonical recording disappeared during analysis")
        database.commit()
        return True
    except Exception as error:
        logger.warning("Failed to persist canonical analysis: %s", type(error).__name__)
        database.rollback()
        return False
    finally:
        cursor.close()


def _persist_failed(
    database: Database,
    job: _ValidatedJob,
    error: str,
    analysis_version: str,
) -> bool:
    bounded_error = error[:500]
    cursor = database.get_cursor()
    try:
        cursor.execute(
            _FAIL_LEASE_SQL,
            (bounded_error, *_lease_locator_values(job)),
        )
        if cursor.fetchone() is None:
            database.rollback()
            logger.info("Skipping canonical failure after lease ownership was lost")
            return False
        cursor.execute(
            _FAIL_CANONICAL_SQL,
            (analysis_version, bounded_error, job.canonical_recording_id),
        )
        if cursor.fetchone() is None:
            raise RuntimeError("Canonical recording disappeared during analysis")
        database.commit()
        return True
    except Exception as database_error:
        logger.warning("Failed to persist canonical failure: %s", type(database_error).__name__)
        database.rollback()
        return False
    finally:
        cursor.close()


def _persist_retryable(database: Database, job: _ValidatedJob, error: str) -> bool:
    bounded_error = error[:500]
    cursor = database.get_cursor()
    try:
        cursor.execute(
            _RETRY_LEASE_SQL,
            (bounded_error, *_lease_locator_values(job)),
        )
        if cursor.fetchone() is None:
            database.rollback()
            logger.info("Skipping canonical retry after lease ownership was lost")
            return False
        cursor.execute(_RETRY_CANONICAL_SQL, (bounded_error, job.canonical_recording_id))
        if cursor.fetchone() is None:
            raise RuntimeError("Canonical recording disappeared during retry release")
        database.commit()
        return True
    except Exception as database_error:
        logger.warning(
            "Failed to release canonical job for retry: %s", type(database_error).__name__
        )
        database.rollback()
        return False
    finally:
        cursor.close()


def _record_cleanup_failure(database: Database, job: _ValidatedJob, error: str) -> None:
    cursor = database.get_cursor()
    try:
        cursor.execute(
            _CLEANUP_FAILED_LEASE_SQL,
            (error[:500], *_lease_locator_values(job)),
        )
        database.commit()
    except Exception as database_error:
        logger.warning("Failed to record asset cleanup error: %s", type(database_error).__name__)
        database.rollback()
    finally:
        cursor.close()


def _is_owned_spool_reference(file_path: str) -> bool:
    """Accept only a direct child of the analyzer-owned hidden spool directory."""
    if "\\" in file_path or "\x00" in file_path:
        return False
    reference = PurePosixPath(file_path)
    return (
        not reference.is_absolute()
        and len(reference.parts) == 2
        and reference.parts[0] == _OWNED_SPOOL_DIRECTORY
        and reference.parts[1] not in {"", ".", ".."}
    )


def _delete_temporary_asset(
    database: Database,
    job: _ValidatedJob,
    resolve_path: ResolvePath,
) -> bool:
    if not job.delete_after:
        return True
    if not _is_owned_spool_reference(job.file_path):
        error = "Temporary asset is not an owned analysis-spool file"
        logger.warning(error)
        _record_cleanup_failure(database, job, error)
        return False
    resolved_path = resolve_path(job.file_path)
    if resolved_path is None:
        error = "Temporary asset path failed containment validation"
        logger.warning(error)
        _record_cleanup_failure(database, job, error)
        return False
    try:
        if os.path.exists(resolved_path):
            os.remove(resolved_path)
        return True
    except OSError as error:
        logger.warning("Failed to delete temporary canonical-analysis asset: %s", error)
        _record_cleanup_failure(database, job, str(error))
        return False


def _release_retryable_asset(
    database: Database,
    job: _ValidatedJob,
    resolve_path: ResolvePath,
    error: str,
) -> bool:
    """Return database state to pending and remove the consumed remote asset."""
    if not _persist_retryable(database, job, error):
        # A recovery worker or another analyzer owns the lease now. Retaining
        # the asset is the only safe choice; that owner controls final cleanup.
        return True
    return _delete_temporary_asset(database, job, resolve_path)


def _settle_completed_future(
    future: Future[tuple[str, str, dict[str, Any]]],
    job: _ValidatedJob,
    *,
    database: Database,
    resolve_path: ResolvePath,
    analysis_version: str,
    terminate_executor: TerminateExecutor | None,
) -> tuple[int, int, int, int]:
    try:
        canonical_id, _file_path, features = future.result()
    except Exception as error:
        if isinstance(error, BrokenProcessPool):
            if terminate_executor is None:
                raise RuntimeError(
                    "Canonical process pool failed without an executor termination callback"
                ) from error
            terminate_executor()
        retry_error = f"Canonical analyzer process failed: {type(error).__name__}"
        cleanup_succeeded = _release_retryable_asset(database, job, resolve_path, retry_error)
        return 0, 0, 1, int(not cleanup_succeeded)
    if canonical_id != job.canonical_recording_id:
        cleanup_succeeded = _release_retryable_asset(
            database,
            job,
            resolve_path,
            "Canonical analyzer returned a mismatched recording id",
        )
        return 0, 0, 1, int(not cleanup_succeeded)

    analysis_error = features.get("_error")
    if analysis_error:
        persisted = _persist_failed(database, job, str(analysis_error), analysis_version)
        if not persisted:
            cleanup_succeeded = _release_retryable_asset(
                database,
                job,
                resolve_path,
                "Canonical failure persistence rolled back",
            )
            return 0, 0, 1, int(not cleanup_succeeded)
        cleanup_failed = not _delete_temporary_asset(database, job, resolve_path)
        return 0, 1, 0, int(cleanup_failed)

    persisted = _persist_completed(database, job, features, analysis_version)
    if not persisted:
        cleanup_succeeded = _release_retryable_asset(
            database,
            job,
            resolve_path,
            "Canonical result persistence rolled back",
        )
        return 0, 0, 1, int(not cleanup_succeeded)
    cleanup_failed = not _delete_temporary_asset(database, job, resolve_path)
    return 1, 0, 0, int(cleanup_failed)


def process_canonical_analysis_jobs(
    jobs: Sequence[Mapping[str, Any]],
    *,
    database: Database,
    executor: Executor,
    analyze: Analyze,
    resolve_path: ResolvePath,
    analysis_version: str,
    timeout_seconds: int,
    terminate_executor: TerminateExecutor | None = None,
) -> CanonicalAnalysisSummary:
    """Analyze canonical jobs in the shared pool and finalize owned spool assets."""
    scheduled: dict[Future[tuple[str, str, dict[str, Any]]], _ValidatedJob] = {}
    executor_terminated = False

    def terminate_executor_once() -> None:
        nonlocal executor_terminated
        if executor_terminated:
            return
        if terminate_executor is None:
            raise RuntimeError(
                "Canonical process pool failed without an executor termination callback"
            )
        terminate_executor()
        executor_terminated = True

    skipped = 0
    retryable = 0
    cleanup_failed = 0
    for raw_job in jobs:
        job = _validate_job(raw_job)
        if job is None:
            skipped += 1
            continue
        if not _mark_started(database, job):
            # Another analyzer may have claimed this durable lease after both
            # pollers selected it. Only the successful claimant owns cleanup.
            skipped += 1
            continue
        try:
            future = executor.submit(
                analyze,
                (job.canonical_recording_id, job.file_path),
            )
        except Exception as error:
            if isinstance(error, BrokenProcessPool):
                terminate_executor_once()
            retry_error = f"Canonical analyzer submission failed: {type(error).__name__}"
            cleanup_failed += int(
                not _release_retryable_asset(database, job, resolve_path, retry_error)
            )
            retryable += 1
            continue
        scheduled[future] = job

    completed = 0
    failed = 0
    if scheduled:
        done, unfinished = wait(scheduled, timeout=max(1, timeout_seconds))
        for future in done:
            succeeded, final_failed, needs_retry, cleanup_error = _settle_completed_future(
                future,
                scheduled[future],
                database=database,
                resolve_path=resolve_path,
                analysis_version=analysis_version,
                terminate_executor=terminate_executor_once,
            )
            completed += succeeded
            failed += final_failed
            retryable += needs_retry
            cleanup_failed += cleanup_error
        running_futures = [future for future in unfinished if not future.cancel()]
        if running_futures:
            # ProcessPoolExecutor cannot cancel a call once it is running. The
            # owning worker must terminate the old pool before these leases are
            # released or their spool files are deleted.
            terminate_executor_once()
        for future in unfinished:
            job = scheduled[future]
            cleanup_failed += int(
                not _release_retryable_asset(
                    database,
                    job,
                    resolve_path,
                    "Canonical analysis timed out",
                )
            )
            retryable += 1

    return CanonicalAnalysisSummary(
        completed=completed,
        failed=failed,
        retryable=retryable,
        skipped=skipped,
        cleanup_failed=cleanup_failed,
    )
