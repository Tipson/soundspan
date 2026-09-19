"""Behavioral coverage for online canonical-recording AcoustID identity."""

from __future__ import annotations

import canonical_acoustid_backfill
from canonical_identity_client import CanonicalIdentityPromotionError
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


class _PromotionClient:
    def __init__(self, result: str = "accepted") -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []

    def submit(self, **payload: object) -> str:
        self.calls.append(payload)
        return self.result


def test_no_key_skips_canonical_identity_without_database_work() -> None:
    """Keep fingerprinting enabled when external identity lookup is disabled."""
    database = FakeDatabaseConnection()
    backfill = canonical_acoustid_backfill.CanonicalAcoustIDBackfill(database, "")

    assert backfill.run_once() is False
    assert database.get_cursor_calls == 0


def test_publishes_unambiguous_acoustid_mbid_without_python_database_writes() -> None:
    """Hand identity to the TypeScript merge owner after the committed claim."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"id": "canonical-1", "fingerprint": "fp", "duration": 247}],
            [{"id": "canonical-1"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    client = _LookupClient()
    promotion_client = _PromotionClient()
    backfill = canonical_acoustid_backfill.CanonicalAcoustIDBackfill(
        database,
        "configured",
        client=client,
        promotion_client=promotion_client,
    )

    assert backfill.run_once() is True
    assert client.calls == [("fp", 247)]
    assert promotion_client.calls == [
        {
            "source_canonical_id": "canonical-1",
            "expected_fingerprint": "fp",
            "recording_mbid": "recording-mbid",
            "confidence": 0.97,
        }
    ]
    assert all('"recordingMbid" = %s' not in sql for sql, _ in database.cursor.executions)


def test_backend_handoff_failure_leaves_claim_for_stale_recovery() -> None:
    """Do not consume retry budget or partially mutate identity on HTTP failure."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"id": "canonical-source", "fingerprint": "fp", "duration": 247}],
            [{"id": "canonical-source"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )

    class UnavailablePromotionClient:
        def submit(self, **_payload: object) -> str:
            raise CanonicalIdentityPromotionError("backend unavailable")

    backfill = canonical_acoustid_backfill.CanonicalAcoustIDBackfill(
        database,
        "configured",
        client=_LookupClient(),
        promotion_client=UnavailablePromotionClient(),
    )

    assert backfill.run_once() is True
    assert all(
        '"identityLookupRetryCount" = "identityLookupRetryCount" + 1' not in sql
        for sql, _ in database.cursor.executions
    )
