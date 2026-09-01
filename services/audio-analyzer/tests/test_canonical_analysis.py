"""Behavioral coverage for remote canonical-recording analysis jobs."""

from __future__ import annotations

import json
import time
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from types import ModuleType
from typing import Any

import canonical_analysis
import pytest
from conftest import FakeDatabaseConnection, FakeRedis


def _features() -> dict[str, Any]:
    """Build one complete Essentia scalar-feature result."""
    return {
        "bpm": 126.0,
        "key": "F#",
        "energy": 0.82,
        "loudness": -7.4,
        "valence": 0.61,
        "danceability": 0.73,
        "arousal": 0.77,
        "instrumentalness": 0.12,
        "acousticness": 0.09,
        "speechiness": 0.04,
        "moodTags": ["energetic"],
        "essentiaGenres": ["rock"],
    }


def _job(file_path: str, *, delete_after: bool = True) -> dict[str, Any]:
    """Build one canonical queue payload."""
    return {
        "canonicalRecordingId": "canonical-1",
        "filePath": file_path,
        "deleteAfter": delete_after,
        "leaseId": "lease-1",
    }


class _ImmediateExecutor:
    """Complete submitted analysis calls synchronously inside a Future."""

    def __init__(self, result: dict[str, Any]) -> None:
        self.result = result
        self.submissions: list[tuple[str, str]] = []

    def submit(self, _callable: object, args: tuple[str, str]) -> Future:
        """Return a completed future with the programmed feature result."""
        self.submissions.append(args)
        future: Future[tuple[str, str, dict[str, Any]]] = Future()
        future.set_result((args[0], args[1], self.result))
        return future


class _RejectingExecutor:
    """Simulate a broken process pool at submission time."""

    def submit(self, _callable: object, _args: tuple[str, str]) -> Future:
        """Reject the work before a child process owns the asset."""
        raise RuntimeError("pool unavailable")


class _RunningExecutor:
    """Return a future that has started and therefore cannot be cancelled."""

    def __init__(self) -> None:
        self.future: Future[tuple[str, str, dict[str, Any]]] = Future()
        assert self.future.set_running_or_notify_cancel() is True

    def submit(self, _callable: object, _args: tuple[str, str]) -> Future:
        """Return the already-running future."""
        return self.future


class _BrokenSubmitExecutor:
    """Reject submission because every child in the pool is unusable."""

    def submit(self, _callable: object, _args: tuple[str, str]) -> Future:
        """Raise the process-pool terminal failure."""
        raise BrokenProcessPool("pool worker crashed")


class _BrokenResultExecutor:
    """Return a future completed by a terminal process-pool failure."""

    def submit(self, _callable: object, _args: tuple[str, str]) -> Future:
        """Return a failed future without running user analysis code."""
        future: Future[tuple[str, str, dict[str, Any]]] = Future()
        future.set_exception(BrokenProcessPool("pool worker crashed"))
        return future


def test_partition_keeps_local_and_loudness_jobs_backward_compatible() -> None:
    """Extract canonical payloads without changing legacy queue payloads."""
    local = {"trackId": "track-1", "filePath": "Artist/local.flac"}
    loudness = {"trackId": "track-2", "filePath": "Artist/loud.flac", "loudnessOnly": True}
    remote = _job(".soundspan-analysis-spool/remote.m4a")

    canonical, legacy = canonical_analysis.partition_canonical_analysis_jobs(
        [local, remote, loudness]
    )

    assert canonical == [remote]
    assert legacy == [local, loudness]


def test_loads_only_the_bounded_durable_lease_batch() -> None:
    """Read canonical work from PostgreSQL without destructive Redis pops."""
    database = FakeDatabaseConnection(
        [
            [
                {
                    "leaseId": "lease-1",
                    "canonicalRecordingId": "canonical-1",
                    "filePath": ".soundspan-analysis-spool/remote.m4a",
                    "deleteAfter": True,
                }
            ]
        ]
    )

    jobs = canonical_analysis.load_queued_canonical_analysis_jobs(database, 8)

    assert jobs == [_job(".soundspan-analysis-spool/remote.m4a")]
    sql, params = database.cursor.executions[0]
    assert "status = 'queued_essentia'" in sql
    assert '"expiresAt" > NOW()' in sql
    assert params == (8,)


def test_success_persists_canonical_features_and_deletes_spool_after_commit(
    tmp_path: Path,
) -> None:
    """Commit scalar features and lease completion before deleting remote audio."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )
    executor = _ImmediateExecutor(_features())

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=executor,
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.completed == 1
    assert summary.failed == 0
    assert executor.submissions == [("canonical-1", ".soundspan-analysis-spool/remote.m4a")]
    assert spool.exists() is False
    assert database.commit_calls == 2
    assert database.rollback_calls == 0
    lease_sql, lease_params = database.cursor.executions[2]
    assert 'UPDATE "AnalysisAssetLease"' in lease_sql
    assert "status = 'completed'" in lease_sql
    assert "status = 'processing'" in lease_sql
    assert '"expiresAt" > NOW()' in lease_sql
    assert lease_params == (
        "canonical-1",
        "lease-1",
        "lease-1",
        "lease-1",
        ".soundspan-analysis-spool/remote.m4a",
    )
    completed_sql, completed_params = database.cursor.executions[3]
    assert 'UPDATE "CanonicalRecording"' in completed_sql
    assert "\"analysisStatus\" = 'completed'" in completed_sql
    assert completed_params[-1] == "canonical-1"


def test_final_analysis_failure_marks_rows_and_deletes_temporary_file(tmp_path: Path) -> None:
    """Record a final analyzer error and release its explicitly temporary asset."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=_ImmediateExecutor({"_error": "unsupported codec", "_permanent": True}),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.completed == 0
    assert summary.failed == 1
    assert spool.exists() is False
    lease_sql, lease_params = database.cursor.executions[2]
    assert "status = 'failed'" in lease_sql
    assert "status = 'processing'" in lease_sql
    assert '"expiresAt" > NOW()' in lease_sql
    assert lease_params == (
        "unsupported codec",
        "canonical-1",
        "lease-1",
        "lease-1",
        "lease-1",
        ".soundspan-analysis-spool/remote.m4a",
    )
    failed_sql, failed_params = database.cursor.executions[3]
    assert "\"analysisStatus\" = 'failed'" in failed_sql
    assert failed_params == ("essentia-test", "unsupported codec", "canonical-1")


def test_delete_after_rejects_non_spool_library_file(tmp_path: Path) -> None:
    """Never delete an ordinary library file even when a forged job asks for it."""
    library_track = tmp_path / "Artist" / "song.flac"
    library_track.parent.mkdir()
    library_track.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )
    resolved: list[str] = []

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job("Artist/song.flac")],
        database=database,
        executor=_ImmediateExecutor(_features()),
        analyze=lambda _args: None,
        resolve_path=lambda file_path: resolved.append(file_path) or str(library_track),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.completed == 1
    assert summary.cleanup_failed == 1
    assert library_track.exists() is True
    assert resolved == []
    cleanup_sql, cleanup_params = database.cursor.executions[4]
    assert "status = 'cleanup_failed'" in cleanup_sql
    assert cleanup_params[0] == "Temporary asset is not an owned analysis-spool file"


def test_database_failure_releases_spool_before_a_fresh_download_retry(tmp_path: Path) -> None:
    """A persistence retry must redownload instead of retaining remote audio."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ],
        fail_on_execute=3,
    )

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=_ImmediateExecutor(_features()),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.completed == 0
    assert summary.failed == 0
    assert summary.retryable == 1
    assert spool.exists() is False
    assert database.commit_calls == 2
    assert database.rollback_calls == 1


def test_lost_lease_before_completion_rolls_back_and_preserves_spool(tmp_path: Path) -> None:
    """A stale worker must not publish results or delete the current owner's asset."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection([[{"id": "canonical-1"}], [{"id": "lease-1"}], [], []])

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=_ImmediateExecutor(_features()),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
        terminate_executor=lambda: None,
    )

    assert summary.completed == 0
    assert summary.retryable == 1
    assert spool.exists() is True
    assert database.rollback_calls == 2
    finalization_sql, _ = database.cursor.executions[2]
    assert 'UPDATE "AnalysisAssetLease"' in finalization_sql
    assert "status = 'processing'" in finalization_sql
    assert '"expiresAt" > NOW()' in finalization_sql
    assert not any(
        "\"analysisStatus\" = 'completed'" in sql for sql, _params in database.cursor.executions
    )


def test_running_timeout_terminates_executor_before_retry_and_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop a running child before its lease and spool file become reusable."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )
    executor = _RunningExecutor()
    events: list[str] = []
    monkeypatch.setattr(
        canonical_analysis,
        "wait",
        lambda scheduled, timeout: (set(), set(scheduled)),
    )

    def terminate_executor() -> None:
        assert spool.exists() is True
        assert executor.future.running() is True
        events.append("terminated")
        executor.future.set_exception(RuntimeError("worker terminated"))

    def resolve_path(_path: str) -> str:
        assert events == ["terminated"]
        events.append("delete")
        return str(spool)

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=executor,
        analyze=lambda _args: None,
        resolve_path=resolve_path,
        analysis_version="essentia-test",
        timeout_seconds=1,
        terminate_executor=terminate_executor,
    )

    assert summary.retryable == 1
    assert events == ["terminated", "delete"]
    assert spool.exists() is False


def test_failed_executor_termination_retains_processing_lease_and_spool(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed when a running child cannot be stopped safely."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection([[{"id": "canonical-1"}], [{"id": "lease-1"}]])
    executor = _RunningExecutor()
    monkeypatch.setattr(
        canonical_analysis,
        "wait",
        lambda scheduled, timeout: (set(), set(scheduled)),
    )

    with pytest.raises(RuntimeError, match="could not terminate pool"):
        canonical_analysis.process_canonical_analysis_jobs(
            [_job(".soundspan-analysis-spool/remote.m4a")],
            database=database,
            executor=executor,
            analyze=lambda _args: None,
            resolve_path=lambda _path: str(spool),
            analysis_version="essentia-test",
            timeout_seconds=1,
            terminate_executor=lambda: (_ for _ in ()).throw(
                RuntimeError("could not terminate pool")
            ),
        )

    assert spool.exists() is True
    assert database.commit_calls == 1
    assert len(database.cursor.executions) == 2


def test_losing_lease_claim_never_deletes_the_winning_worker_asset(tmp_path: Path) -> None:
    """A duplicate poller must leave a file owned by the successful claimant alone."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection([[{"id": "canonical-1"}], []])

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=_ImmediateExecutor(_features()),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.skipped == 1
    assert summary.retryable == 0
    assert spool.exists() is True


def test_process_pool_submission_failure_releases_job_and_deletes_asset(
    tmp_path: Path,
) -> None:
    """Return a claimed recording to pending when the process pool rejects it."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=_RejectingExecutor(),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.retryable == 1
    assert summary.completed == 0
    assert summary.failed == 0
    assert spool.exists() is False
    retry_lease_sql, retry_lease_params = database.cursor.executions[2]
    assert "status = 'retryable'" in retry_lease_sql
    assert "status = 'processing'" in retry_lease_sql
    assert '"expiresAt" > NOW()' in retry_lease_sql
    assert retry_lease_params[0] == "Canonical analyzer submission failed: RuntimeError"
    retry_sql, retry_params = database.cursor.executions[3]
    assert "\"analysisStatus\" = 'pending'" in retry_sql
    assert retry_params == ("Canonical analyzer submission failed: RuntimeError", "canonical-1")


@pytest.mark.parametrize("failure_stage", ["submit", "result"])
def test_broken_process_pool_is_aborted_before_retry_and_delete(
    tmp_path: Path,
    failure_stage: str,
) -> None:
    """Discard a terminally broken pool before exposing its lease to retries."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )
    events: list[str] = []

    def terminate_executor() -> None:
        assert spool.exists() is True
        events.append("terminated")

    def resolve_path(_path: str) -> str:
        assert events == ["terminated"]
        events.append("delete")
        return str(spool)

    executor = _BrokenSubmitExecutor() if failure_stage == "submit" else _BrokenResultExecutor()
    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job(".soundspan-analysis-spool/remote.m4a")],
        database=database,
        executor=executor,
        analyze=lambda _args: None,
        resolve_path=resolve_path,
        analysis_version="essentia-test",
        timeout_seconds=30,
        terminate_executor=terminate_executor,
    )

    assert summary.retryable == 1
    assert events == ["terminated", "delete"]
    assert spool.exists() is False


def test_delete_after_false_preserves_successfully_analyzed_file(tmp_path: Path) -> None:
    """Keep non-temporary files even after canonical analysis succeeds."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [_job("spool/remote.m4a", delete_after=False)],
        database=database,
        executor=_ImmediateExecutor(_features()),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.completed == 1
    assert spool.exists() is True


def test_lease_falls_back_to_spool_reference_when_lease_id_is_absent(tmp_path: Path) -> None:
    """Update the owning lease by its unique spool reference for older producers."""
    spool = tmp_path / "remote.m4a"
    spool.write_bytes(b"audio")
    database = FakeDatabaseConnection(
        [
            [{"id": "canonical-1"}],
            [{"id": "lease-1"}],
            [{"id": "lease-1"}],
            [{"id": "canonical-1"}],
        ]
    )
    job = _job("spool/remote.m4a", delete_after=False)
    del job["leaseId"]

    summary = canonical_analysis.process_canonical_analysis_jobs(
        [job],
        database=database,
        executor=_ImmediateExecutor(_features()),
        analyze=lambda _args: None,
        resolve_path=lambda _path: str(spool),
        analysis_version="essentia-test",
        timeout_seconds=30,
    )

    assert summary.completed == 1
    started_lease_sql, started_lease_params = database.cursor.executions[1]
    assert '"spoolRef" = %s' in started_lease_sql
    assert started_lease_params == ("canonical-1", None, None, None, "spool/remote.m4a")
    completed_lease_sql, completed_lease_params = database.cursor.executions[2]
    assert '"spoolRef" = %s' in completed_lease_sql
    assert completed_lease_params == started_lease_params


class _QueueRedis(FakeRedis):
    """Provide one canonical job followed by an empty queue drain."""

    def __init__(self, payload: dict[str, Any]) -> None:
        super().__init__()
        self.payload = json.dumps(payload)

    def brpop(self, _queue: str, timeout: int) -> tuple[str, str]:
        """Return the programmed blocking-pop payload."""
        assert timeout > 0
        return ("audio:analysis:queue", self.payload)

    def lpop(self, _queue: str) -> None:
        """End the batch after the first payload."""
        return


class _StubbornProcess:
    """Stay alive after terminate until the worker escalates to kill."""

    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.alive = True

    def is_alive(self) -> bool:
        """Report whether the fake child still owns work."""
        return self.alive

    def terminate(self) -> None:
        """Record a graceful termination that intentionally does not finish."""
        self.events.append("terminate")

    def kill(self) -> None:
        """Record the forced termination and stop the fake child."""
        self.events.append("kill")
        self.alive = False

    def join(self, timeout: float | None = None) -> None:
        """Record every bounded wait for process exit."""
        assert timeout is not None
        self.events.append("join")


class _ProcessPoolWithStubbornChild:
    """Expose the Python 3.13 process table used for hard pool disposal."""

    def __init__(self, process: _StubbornProcess, events: list[str]) -> None:
        self._processes = {123: process}
        self.events = events

    def shutdown(self, *, wait: bool, cancel_futures: bool) -> None:
        """Record non-blocking executor resource cleanup."""
        assert wait is False
        assert cancel_futures is True
        self.events.append("shutdown")


def test_worker_hard_stops_pool_before_releasing_executor_reference(
    loaded_analyzer: ModuleType,
) -> None:
    """Escalate from terminate to kill before a timed-out pool can be reused."""
    events: list[str] = []
    process = _StubbornProcess(events)
    executor = _ProcessPoolWithStubbornChild(process, events)
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.executor = executor
    worker.pool_active = True

    worker._abort_process_pool()

    assert events == ["terminate", "join", "kill", "join", "shutdown"]
    assert process.is_alive() is False
    assert worker.executor is None
    assert worker.pool_active is False


def test_worker_hard_stops_real_running_process_pool(
    loaded_analyzer: ModuleType,
) -> None:
    """Prove a live child process exits before the timed-out pool is discarded."""
    executor = ProcessPoolExecutor(max_workers=1)
    future = executor.submit(time.sleep, 60)
    deadline = time.monotonic() + 5
    while not executor._processes and time.monotonic() < deadline:
        time.sleep(0.01)
    processes = list(executor._processes.values())
    assert processes
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.executor = executor
    worker.pool_active = True

    worker._abort_process_pool()

    assert all(process.is_alive() is False for process in processes)
    assert future.done() or future.running()
    assert worker.executor is None
    assert worker.pool_active is False


def test_worker_dispatches_canonical_job_without_track_claim(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Route canonical payloads around the legacy Track status-claim path."""
    payload = _job("spool/remote.m4a")
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.redis = _QueueRedis(payload)
    worker.db = FakeDatabaseConnection()
    worker.executor = object()
    worker.pool_active = True
    worker.loudness_backfill_bookkeeping = object()
    handled: list[list[dict[str, Any]]] = []
    termination_callbacks: list[object] = []

    def handle_canonical(jobs: list[dict[str, Any]], **kwargs: object) -> None:
        handled.append(jobs)
        termination_callbacks.append(kwargs["terminate_executor"])

    monkeypatch.setattr(
        loaded_analyzer,
        "process_canonical_analysis_jobs",
        handle_canonical,
    )
    worker._process_tracks_parallel = lambda _tracks: (_ for _ in ()).throw(
        AssertionError("Canonical jobs must not claim Track rows")
    )

    assert worker.process_batch_parallel() is True
    assert handled == [[payload]]
    assert termination_callbacks == [worker._abort_process_pool]
