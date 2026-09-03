"""Behavioral coverage for online canonical-recording AcoustID identity."""

from __future__ import annotations

import canonical_acoustid_backfill
from conftest import FakeDatabaseConnection


class _LookupClient:
    """Return one deterministic accepted recording identity."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
        self.calls.append((fingerprint, duration))
        return {
            "recordingMbid": "recording-mbid",
            "releaseGroupMbid": None,
            "score": 0.97,
        }


def test_no_key_skips_canonical_identity_without_database_work() -> None:
    """Keep fingerprinting enabled when external identity lookup is disabled."""
    database = FakeDatabaseConnection()
    backfill = canonical_acoustid_backfill.CanonicalAcoustIDBackfill(database, "")

    assert backfill.run_once() is False
    assert database.get_cursor_calls == 0


def test_persists_unambiguous_acoustid_mbid_on_canonical_recording() -> None:
    """Promote an analyzed online recording to durable MBID identity."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"id": "canonical-1", "fingerprint": "fp", "duration": 247}],
            [{"id": "canonical-1"}],
            [],
            [{"id": "canonical-1"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    client = _LookupClient()
    backfill = canonical_acoustid_backfill.CanonicalAcoustIDBackfill(
        database,
        "configured",
        client=client,
    )

    assert backfill.run_once() is True
    assert client.calls == [("fp", 247)]
    lock_sql, lock_params = database.cursor.executions[4]
    assert "pg_advisory_xact_lock" in lock_sql
    assert lock_params == ("recording-mbid",)
    save_sql, save_params = database.cursor.executions[6]
    assert '"recordingMbid" = %s' in save_sql
    assert save_params == ("recording-mbid", 0.97, "canonical-1", "fp")


def test_repoints_future_provider_mappings_when_mbid_already_exists() -> None:
    """Consolidate provider mappings without deleting historical evidence."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"id": "canonical-source", "fingerprint": "fp", "duration": 247}],
            [{"id": "canonical-source"}],
            [{"id": "canonical-target"}],
            [{"id": "canonical-source"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    backfill = canonical_acoustid_backfill.CanonicalAcoustIDBackfill(
        database,
        "configured",
        client=_LookupClient(),
    )

    assert backfill.run_once() is True
    lock_sql, lock_params = database.cursor.executions[4]
    assert "pg_advisory_xact_lock" in lock_sql
    assert lock_params == ("recording-mbid",)
    feature_sql, feature_params = database.cursor.executions[6]
    assert 'UPDATE "CanonicalRecording" AS target' in feature_sql
    assert feature_params == ("canonical-source", "canonical-target")
    embedding_sql, embedding_params = database.cursor.executions[7]
    assert "INSERT INTO canonical_recording_embeddings" in embedding_sql
    assert embedding_params == ("canonical-target", "canonical-source")
    mapping_sql, mapping_params = database.cursor.executions[8]
    assert 'UPDATE "TrackMapping"' in mapping_sql
    assert mapping_params == ("canonical-target", "canonical-source")
    source_sql, source_params = database.cursor.executions[9]
    assert "\"identitySource\" = 'acoustid-merged'" in source_sql
    assert source_params == (0.97, "canonical-source", "fp")
