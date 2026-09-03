"""Real-PostgreSQL proof for concurrent reconciliation claims.

The test is environment-gated for local analyzer runs. The repository's Backend
PostgreSQL Integration job supplies TEST_DATABASE_URL and runs this file.
"""

from __future__ import annotations

import importlib
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import ModuleType

import acoustid_backfill
import canonical_acoustid_backfill
import canonical_analysis
import pytest
from acoustid_backfill import AcoustIDBackfill
from canonical_acoustid_backfill import CanonicalAcoustIDBackfill
from fingerprint_persistence import persist_fingerprint

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required for PostgreSQL integration",
)

if TEST_DATABASE_URL:
    import psycopg2
    from psycopg2 import sql
    from psycopg2.extras import RealDictCursor


def _claim_in_transaction(
    module: ModuleType,
    schema_name: str,
    start_barrier: threading.Barrier,
    claimed_barrier: threading.Barrier,
) -> list[str]:
    """Claim one batch and hold its locks until both transactions have selected."""
    assert TEST_DATABASE_URL is not None
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    try:
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(
                sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(schema_name))
            )
            cursor.execute("SET LOCAL statement_timeout = '5s'")
            start_barrier.wait(timeout=5)
            worker = object.__new__(module.AnalysisWorker)
            claimed = worker._select_and_claim_reconciliation_tracks(cursor)
            claimed_barrier.wait(timeout=5)
        connection.commit()
        return [track_id for track_id, _ in claimed]
    finally:
        connection.close()


def _create_test_schema(schema_name: str) -> list[str]:
    """Create an isolated minimal Track table and seed two claim batches."""
    assert TEST_DATABASE_URL is not None
    track_ids = ["claim-track-a", "claim-track-b", "claim-track-c", "claim-track-d"]
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."Track" (
                        id TEXT PRIMARY KEY,
                        "filePath" TEXT,
                        "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
                        "analysisRetryCount" INTEGER NOT NULL DEFAULT 0,
                        "fileModified" TIMESTAMP NOT NULL,
                        "analysisStartedAt" TIMESTAMP,
                        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                ).format(sql.Identifier(schema_name))
            )
            cursor.executemany(
                sql.SQL(
                    """
                    INSERT INTO {}."Track" (id, "filePath", "fileModified")
                    VALUES (%s, %s, NOW() - (%s * INTERVAL '1 second'))
                    """
                ).format(sql.Identifier(schema_name)),
                [
                    ("catalog-track", None, 0),
                    ("empty-path-track", "", 0),
                    ("claim-track-a", "/music/a.flac", 1),
                    ("claim-track-b", "/music/b.flac", 2),
                    ("claim-track-c", "/music/c.flac", 3),
                    ("claim-track-d", "/music/d.flac", 4),
                ],
            )
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."TrackFingerprint" (
                        "trackId" TEXT PRIMARY KEY,
                        fingerprint TEXT NOT NULL,
                        duration INTEGER NOT NULL,
                        "fingerprintedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        "lookupStatus" TEXT NOT NULL DEFAULT 'pending',
                        "lookupStartedAt" TIMESTAMPTZ,
                        "lookupRetryCount" INTEGER NOT NULL DEFAULT 0,
                        "lookupError" TEXT,
                        "recordingMbid" TEXT,
                        "releaseGroupMbid" TEXT,
                        score DOUBLE PRECISION,
                        "lookedUpAt" TIMESTAMPTZ,
                        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                ).format(sql.Identifier(schema_name))
            )
    finally:
        connection.close()
    return track_ids


def _drop_test_schema(schema_name: str) -> None:
    """Drop the isolated integration schema after both transactions close."""
    assert TEST_DATABASE_URL is not None
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema_name)))
    finally:
        connection.close()


def test_hash_index_accepts_realistic_long_chromaprint() -> None:
    """Persist and equality-match fingerprints larger than a B-tree index row."""
    assert TEST_DATABASE_URL is not None
    schema_name = f"canonical_fingerprint_{uuid.uuid4().hex}"
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    fingerprint = "AQAA" * 4_096
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
            cursor.execute(
                sql.SQL(
                    'CREATE TABLE {}."CanonicalRecording" (id TEXT PRIMARY KEY, fingerprint TEXT)'
                ).format(sql.Identifier(schema_name))
            )
            cursor.execute(
                sql.SQL(
                    'CREATE INDEX "CanonicalRecording_fingerprint_idx" '
                    'ON {}."CanonicalRecording" USING HASH (fingerprint)'
                ).format(sql.Identifier(schema_name))
            )
            cursor.execute(
                sql.SQL(
                    'INSERT INTO {}."CanonicalRecording" (id, fingerprint) VALUES (%s, %s)'
                ).format(sql.Identifier(schema_name)),
                ("canonical-long", fingerprint),
            )
            cursor.execute(
                sql.SQL('SELECT id FROM {}."CanonicalRecording" WHERE fingerprint = %s').format(
                    sql.Identifier(schema_name)
                ),
                (fingerprint,),
            )
            assert cursor.fetchone()[0] == "canonical-long"
    finally:
        connection.close()
        _drop_test_schema(schema_name)


def _seed_canonical_analysis_lease(schema_name: str) -> None:
    """Create one durable canonical lease for concurrent-claim verification."""
    assert TEST_DATABASE_URL is not None
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."CanonicalRecording" (
                        id TEXT PRIMARY KEY,
                        "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
                        "analysisError" TEXT,
                        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE {}."AnalysisAssetLease" (
                        id TEXT PRIMARY KEY,
                        "canonicalRecordingId" TEXT NOT NULL,
                        "spoolRef" TEXT NOT NULL UNIQUE,
                        status TEXT NOT NULL,
                        "expiresAt" TIMESTAMP NOT NULL,
                        error TEXT,
                        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
                        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                ).format(sql.Identifier(schema_name), sql.Identifier(schema_name))
            )
            cursor.execute(
                sql.SQL(
                    """
                    INSERT INTO {}."CanonicalRecording" (id)
                    VALUES ('canonical-lease');
                    INSERT INTO {}."AnalysisAssetLease"
                        (id, "canonicalRecordingId", "spoolRef", status, "expiresAt")
                    VALUES (
                        'lease-1',
                        'canonical-lease',
                        '.soundspan-analysis-spool/lease.audio',
                        'queued_essentia',
                        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '2 hours'
                    )
                    """
                ).format(sql.Identifier(schema_name), sql.Identifier(schema_name))
            )
    finally:
        connection.close()


def _claim_canonical_lease(
    module: ModuleType,
    schema_name: str,
    start_barrier: threading.Barrier,
) -> bool:
    """Attempt one lease claim on an independent PostgreSQL transaction."""
    database = _configure_database(module, schema_name)
    try:
        start_barrier.wait(timeout=5)
        job = canonical_analysis._validate_job(
            {
                "canonicalRecordingId": "canonical-lease",
                "leaseId": "lease-1",
                "filePath": ".soundspan-analysis-spool/lease.audio",
                "deleteAfter": True,
            }
        )
        assert job is not None
        return canonical_analysis._mark_started(database, job)
    finally:
        database.close()


def _configure_database(module: ModuleType, schema_name: str):
    """Connect one analyzer database manager to the isolated test schema."""
    assert TEST_DATABASE_URL is not None
    database = module.DatabaseConnection(TEST_DATABASE_URL)
    database.connect()
    cursor = database.get_cursor()
    cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema_name)))
    database.commit()
    cursor.close()
    return database


def test_reconciliation_claims_are_disjoint_across_transactions(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claim every pending row exactly once across two live transactions."""
    connection_module = importlib.import_module("database_connection")
    assert loaded_analyzer.psycopg2 is psycopg2
    assert connection_module.psycopg2 is psycopg2

    schema_name = f"analyzer_claim_{uuid.uuid4().hex}"
    expected_ids = _create_test_schema(schema_name)
    monkeypatch.setattr(loaded_analyzer, "BATCH_SIZE", 2)
    start_barrier = threading.Barrier(2)
    claimed_barrier = threading.Barrier(2)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    _claim_in_transaction,
                    loaded_analyzer,
                    schema_name,
                    start_barrier,
                    claimed_barrier,
                )
                for _ in range(2)
            ]
            first_claim, second_claim = [future.result(timeout=10) for future in futures]

        assert set(first_claim).isdisjoint(second_claim)
        assert sorted(first_claim + second_claim) == sorted(expected_ids)
        assert len(first_claim + second_claim) == len(set(first_claim + second_claim))
    finally:
        _drop_test_schema(schema_name)


def test_redis_claim_rejects_database_row_without_local_path(
    loaded_analyzer: ModuleType,
) -> None:
    """Fence a stale non-null queue payload when the database path is null."""
    schema_name = f"redis_path_claim_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    database = _configure_database(loaded_analyzer, schema_name)
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.db = database

    try:
        claimed = worker._claim_tracks_for_processing(
            [
                ("catalog-track", "/stale/catalog.webm"),
                ("claim-track-a", "/music/a.flac"),
            ]
        )

        assert claimed == [("claim-track-a", "/music/a.flac")]
        cursor = database.get_cursor()
        cursor.execute(
            'SELECT id, "analysisStatus" FROM "Track" WHERE id IN (%s, %s) ORDER BY id',
            ("catalog-track", "claim-track-a"),
        )
        assert cursor.fetchall() == [
            {"id": "catalog-track", "analysisStatus": "pending"},
            {"id": "claim-track-a", "analysisStatus": "processing"},
        ]
        database.commit()
        cursor.close()
    finally:
        database.close()
        _drop_test_schema(schema_name)


def test_canonical_lease_is_claimed_by_exactly_one_analyzer(
    loaded_analyzer: ModuleType,
) -> None:
    """Prove the durable Essentia hand-off has one cleanup owner across replicas."""
    schema_name = f"canonical_claim_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    _seed_canonical_analysis_lease(schema_name)
    start_barrier = threading.Barrier(2)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = [
                executor.submit(
                    _claim_canonical_lease,
                    loaded_analyzer,
                    schema_name,
                    start_barrier,
                )
                for _ in range(2)
            ]
            outcomes = [claim.result(timeout=10) for claim in claims]

        assert sorted(outcomes) == [False, True]
        database = _configure_database(loaded_analyzer, schema_name)
        try:
            cursor = database.get_cursor()
            cursor.execute(
                'SELECT status, "expiresAt" > NOW() AS live '
                'FROM "AnalysisAssetLease" WHERE id = %s',
                ("lease-1",),
            )
            assert cursor.fetchone() == {"status": "processing", "live": True}
            database.commit()
            cursor.close()
        finally:
            database.close()
    finally:
        _drop_test_schema(schema_name)


@pytest.mark.parametrize("settlement", ["completed", "failed", "retryable"])
def test_revoked_canonical_lease_fences_stale_settlement(
    loaded_analyzer: ModuleType,
    settlement: str,
) -> None:
    """Reject every terminal write after recovery has revoked lease ownership."""
    schema_name = f"canonical_fence_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    _seed_canonical_analysis_lease(schema_name)
    database = _configure_database(loaded_analyzer, schema_name)
    job = canonical_analysis._validate_job(
        {
            "canonicalRecordingId": "canonical-lease",
            "leaseId": "lease-1",
            "filePath": ".soundspan-analysis-spool/lease.audio",
            "deleteAfter": True,
        }
    )
    assert job is not None

    try:
        assert canonical_analysis._mark_started(database, job) is True
        cursor = database.get_cursor()
        cursor.execute(
            'UPDATE "AnalysisAssetLease" '
            "SET status = 'expired', \"expiresAt\" = NOW() - INTERVAL '1 second' "
            "WHERE id = %s",
            ("lease-1",),
        )
        cursor.execute(
            'UPDATE "CanonicalRecording" '
            "SET \"analysisStatus\" = 'pending', \"analysisError\" = 'lease revoked' "
            "WHERE id = %s",
            ("canonical-lease",),
        )
        database.commit()
        cursor.close()

        if settlement == "completed":
            persisted = canonical_analysis._persist_completed(
                database,
                job,
                {},
                "essentia-test",
            )
        elif settlement == "failed":
            persisted = canonical_analysis._persist_failed(
                database,
                job,
                "stale failure",
                "essentia-test",
            )
        else:
            persisted = canonical_analysis._persist_retryable(
                database,
                job,
                "stale retry",
            )

        assert persisted is False
        cursor = database.get_cursor()
        cursor.execute(
            'SELECT status FROM "AnalysisAssetLease" WHERE id = %s',
            ("lease-1",),
        )
        assert cursor.fetchone() == {"status": "expired"}
        cursor.execute(
            'SELECT "analysisStatus", "analysisError" FROM "CanonicalRecording" WHERE id = %s',
            ("canonical-lease",),
        )
        assert cursor.fetchone() == {
            "analysisStatus": "pending",
            "analysisError": "lease revoked",
        }
        database.commit()
        cursor.close()
    finally:
        database.close()
        _drop_test_schema(schema_name)


def test_fingerprint_upsert_and_lookup_claim_round_trip(loaded_analyzer: ModuleType) -> None:
    """Prove fingerprint and claim SQL behavior against real PostgreSQL."""
    assert TEST_DATABASE_URL is not None
    schema_name = f"fingerprint_claim_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    database = loaded_analyzer.DatabaseConnection(TEST_DATABASE_URL)
    database.connect()

    class Client:
        def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
            assert (fingerprint, duration) == ("chromaprint-value", 247)
            return {
                "recordingMbid": "recording-mbid",
                "releaseGroupMbid": "release-group-mbid",
                "score": 0.91,
            }

    try:
        cursor = database.get_cursor()
        cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema_name)))
        persist_fingerprint(
            cursor,
            "claim-track-a",
            {"fingerprint": "chromaprint-value", "duration": 247},
        )
        database.commit()
        cursor.close()

        worker = AcoustIDBackfill(database, "configured", client=Client())
        assert worker.run_once() is True

        cursor = database.get_cursor()
        cursor.execute(
            'SELECT "lookupStatus", "recordingMbid", "releaseGroupMbid", score '
            'FROM "TrackFingerprint" WHERE "trackId" = %s',
            ("claim-track-a",),
        )
        row = cursor.fetchone()
        database.commit()
        cursor.close()
        assert row == {
            "lookupStatus": "completed",
            "recordingMbid": "recording-mbid",
            "releaseGroupMbid": "release-group-mbid",
            "score": 0.91,
        }
    finally:
        database.close()
        _drop_test_schema(schema_name)


def test_canonical_fingerprint_lookup_promotes_online_identity(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prove canonical claim, MBID persistence and deployment locking in PostgreSQL."""
    assert TEST_DATABASE_URL is not None
    schema_name = f"canonical_identity_{uuid.uuid4().hex}"
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."CanonicalRecording" (
                        id TEXT PRIMARY KEY,
                        fingerprint TEXT,
                        duration INTEGER NOT NULL,
                        "recordingMbid" TEXT UNIQUE,
                        "identitySource" TEXT NOT NULL DEFAULT 'chromaprint',
                        "identityConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
                        "identityLookupStatus" TEXT NOT NULL DEFAULT 'pending',
                        "identityLookupRetryCount" INTEGER NOT NULL DEFAULT 0,
                        "identityLookupError" TEXT,
                        "identityLookupUpdatedAt" TIMESTAMPTZ,
                        "analyzedAt" TIMESTAMPTZ DEFAULT NOW(),
                        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE {}."TrackMapping" (
                        id TEXT PRIMARY KEY,
                        "canonicalRecordingId" TEXT,
                        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    INSERT INTO {}."CanonicalRecording" (id, fingerprint, duration)
                    VALUES ('canonical-online', 'online-fingerprint', 247)
                    """
                ).format(
                    sql.Identifier(schema_name),
                    sql.Identifier(schema_name),
                    sql.Identifier(schema_name),
                )
            )
    finally:
        connection.close()

    class Client:
        def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
            assert (fingerprint, duration) == ("online-fingerprint", 247)
            return {
                "recordingMbid": "online-recording-mbid",
                "releaseGroupMbid": None,
                "score": 0.98,
            }

    database = _configure_database(loaded_analyzer, schema_name)
    monkeypatch.setattr(
        canonical_acoustid_backfill,
        "LOOKUP_OWNER_KEY",
        f"soundspan:test:canonical-acoustid:{uuid.uuid4().hex}",
    )
    try:
        worker = CanonicalAcoustIDBackfill(database, "configured", client=Client())
        assert worker.run_once() is True
        cursor = database.get_cursor()
        cursor.execute(
            'SELECT "recordingMbid", "identitySource", "identityLookupStatus" '
            'FROM "CanonicalRecording" WHERE id = %s',
            ("canonical-online",),
        )
        row = cursor.fetchone()
        database.commit()
        cursor.close()
        assert row == {
            "recordingMbid": "online-recording-mbid",
            "identitySource": "acoustid",
            "identityLookupStatus": "completed",
        }
    finally:
        database.close()
        _drop_test_schema(schema_name)


def test_canonical_identity_merge_preserves_analysis_and_embeddings(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Merge duplicate identity without orphaning analyzed online features."""
    assert TEST_DATABASE_URL is not None
    schema_name = f"canonical_merge_{uuid.uuid4().hex}"
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."CanonicalRecording" (
                        id TEXT PRIMARY KEY,
                        fingerprint TEXT,
                        duration INTEGER NOT NULL,
                        "recordingMbid" TEXT UNIQUE,
                        "identitySource" TEXT NOT NULL DEFAULT 'metadata',
                        "identityConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                        "identityLookupStatus" TEXT NOT NULL DEFAULT 'pending',
                        "identityLookupRetryCount" INTEGER NOT NULL DEFAULT 0,
                        "identityLookupError" TEXT,
                        "identityLookupUpdatedAt" TIMESTAMPTZ,
                        bpm DOUBLE PRECISION,
                        key TEXT,
                        energy DOUBLE PRECISION,
                        loudness DOUBLE PRECISION,
                        valence DOUBLE PRECISION,
                        danceability DOUBLE PRECISION,
                        arousal DOUBLE PRECISION,
                        instrumentalness DOUBLE PRECISION,
                        acousticness DOUBLE PRECISION,
                        speechiness DOUBLE PRECISION,
                        "moodTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
                        "essentiaGenres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
                        "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
                        "analysisVersion" TEXT,
                        "analyzedAt" TIMESTAMPTZ,
                        "analysisError" TEXT,
                        "embeddingStatus" TEXT NOT NULL DEFAULT 'pending',
                        "embeddingVersion" TEXT,
                        "embeddingAnalyzedAt" TIMESTAMPTZ,
                        "embeddingError" TEXT,
                        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE {}."TrackMapping" (
                        id TEXT PRIMARY KEY,
                        "canonicalRecordingId" TEXT,
                        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE {}.canonical_recording_embeddings (
                        canonical_recording_id TEXT NOT NULL,
                        space_id TEXT NOT NULL,
                        embedding TEXT NOT NULL,
                        analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (canonical_recording_id, space_id)
                    );
                    INSERT INTO {}."CanonicalRecording" (
                        id,
                        fingerprint,
                        duration,
                        "analysisStatus",
                        "embeddingStatus"
                    ) VALUES ('canonical-target', NULL, 247, 'pending', 'pending');
                    UPDATE {}."CanonicalRecording"
                    SET "recordingMbid" = 'shared-recording-mbid'
                    WHERE id = 'canonical-target';
                    INSERT INTO {}."CanonicalRecording" (
                        id,
                        fingerprint,
                        duration,
                        bpm,
                        energy,
                        "moodTags",
                        "essentiaGenres",
                        "analysisStatus",
                        "analysisVersion",
                        "analyzedAt",
                        "embeddingStatus",
                        "embeddingVersion",
                        "embeddingAnalyzedAt"
                    ) VALUES (
                        'canonical-source',
                        'source-fingerprint',
                        247,
                        128.0,
                        0.82,
                        ARRAY['energetic'],
                        ARRAY['electronic'],
                        'completed',
                        'essentia-v1',
                        NOW(),
                        'completed',
                        'dclap-v1',
                        NOW()
                    );
                    INSERT INTO {}.canonical_recording_embeddings (
                        canonical_recording_id,
                        space_id,
                        embedding
                    ) VALUES ('canonical-source', 'dclap-v1', '[0.1,0.2]');
                    INSERT INTO {}."TrackMapping" (id, "canonicalRecordingId")
                    VALUES ('mapping-source', 'canonical-source')
                    """
                ).format(*[sql.Identifier(schema_name) for _ in range(8)])
            )
    finally:
        connection.close()

    class Client:
        def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
            assert (fingerprint, duration) == ("source-fingerprint", 247)
            return {
                "recordingMbid": "shared-recording-mbid",
                "releaseGroupMbid": None,
                "score": 0.99,
            }

    database = _configure_database(loaded_analyzer, schema_name)
    monkeypatch.setattr(
        canonical_acoustid_backfill,
        "LOOKUP_OWNER_KEY",
        f"soundspan:test:canonical-merge:{uuid.uuid4().hex}",
    )
    try:
        worker = CanonicalAcoustIDBackfill(database, "configured", client=Client())
        assert worker.run_once() is True

        cursor = database.get_cursor()
        cursor.execute(
            'SELECT fingerprint, bpm, energy, "moodTags", "essentiaGenres", '
            '"analysisStatus", "analysisVersion", "embeddingStatus", "embeddingVersion" '
            'FROM "CanonicalRecording" WHERE id = %s',
            ("canonical-target",),
        )
        target = cursor.fetchone()
        cursor.execute(
            'SELECT "identitySource", "identityLookupStatus" '
            'FROM "CanonicalRecording" WHERE id = %s',
            ("canonical-source",),
        )
        source = cursor.fetchone()
        cursor.execute(
            "SELECT canonical_recording_id, space_id, embedding "
            "FROM canonical_recording_embeddings WHERE canonical_recording_id = %s",
            ("canonical-target",),
        )
        embedding = cursor.fetchone()
        cursor.execute(
            'SELECT "canonicalRecordingId" FROM "TrackMapping" WHERE id = %s',
            ("mapping-source",),
        )
        mapping = cursor.fetchone()
        database.commit()
        cursor.close()

        assert target == {
            "fingerprint": "source-fingerprint",
            "bpm": 128.0,
            "energy": 0.82,
            "moodTags": ["energetic"],
            "essentiaGenres": ["electronic"],
            "analysisStatus": "completed",
            "analysisVersion": "essentia-v1",
            "embeddingStatus": "completed",
            "embeddingVersion": "dclap-v1",
        }
        assert source == {
            "identitySource": "acoustid-merged",
            "identityLookupStatus": "completed",
        }
        assert embedding == {
            "canonical_recording_id": "canonical-target",
            "space_id": "dclap-v1",
            "embedding": "[0.1,0.2]",
        }
        assert mapping == {"canonicalRecordingId": "canonical-target"}
    finally:
        database.close()
        _drop_test_schema(schema_name)


@pytest.mark.parametrize("lookup_fails", [False, True])
def test_lookup_compare_and_set_discards_refingerprinted_claim(
    loaded_analyzer: ModuleType,
    lookup_fails: bool,
) -> None:
    """Preserve a new pending fingerprint across stale lookup success and failure writes."""
    schema_name = f"fingerprint_race_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    database = _configure_database(loaded_analyzer, schema_name)

    class RefingerprintingClient:
        called = False

        def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
            assert (fingerprint, duration) == ("old-fingerprint", 247)
            cursor = database.get_cursor()
            persist_fingerprint(
                cursor,
                "claim-track-a",
                {"fingerprint": "new-fingerprint", "duration": 248},
            )
            database.commit()
            cursor.close()
            self.called = True
            if lookup_fails:
                raise acoustid_backfill.AcoustIDLookupError("timeout")
            return {
                "recordingMbid": "stale-recording",
                "releaseGroupMbid": "stale-release-group",
                "score": 0.99,
            }

    client = RefingerprintingClient()
    try:
        cursor = database.get_cursor()
        persist_fingerprint(
            cursor,
            "claim-track-a",
            {"fingerprint": "old-fingerprint", "duration": 247},
        )
        database.commit()
        cursor.close()

        worker = AcoustIDBackfill(database, "configured", client=client)
        assert worker.run_once(lambda: client.called) is True

        cursor = database.get_cursor()
        cursor.execute(
            'SELECT fingerprint, duration, "lookupStatus", "lookupRetryCount", '
            '"recordingMbid", "releaseGroupMbid", score '
            'FROM "TrackFingerprint" WHERE "trackId" = %s',
            ("claim-track-a",),
        )
        row = cursor.fetchone()
        database.commit()
        cursor.close()
        assert row == {
            "fingerprint": "new-fingerprint",
            "duration": 248,
            "lookupStatus": "pending",
            "lookupRetryCount": 0,
            "recordingMbid": None,
            "releaseGroupMbid": None,
            "score": None,
        }
    finally:
        database.close()
        _drop_test_schema(schema_name)


def test_lookup_owner_lock_excludes_second_replica_for_whole_pass(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exclude another database session while the leader drains multiple batches."""
    schema_name = f"lookup_owner_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    first_database = _configure_database(loaded_analyzer, schema_name)
    second_database = _configure_database(loaded_analyzer, schema_name)
    owner_key = f"soundspan:test:acoustid:{uuid.uuid4().hex}"
    monkeypatch.setattr(acoustid_backfill, "LOOKUP_OWNER_KEY", owner_key)

    class SecondClient:
        calls = 0

        def lookup(self, _fingerprint: str, _duration: int) -> None:
            self.calls += 1

    second_client = SecondClient()
    second_worker = AcoustIDBackfill(second_database, "configured", client=second_client)

    class LeaderClient:
        def __init__(self) -> None:
            self.calls: list[tuple[str, int]] = []
            self.handoffs: list[bool] = []

        def lookup(self, fingerprint: str, duration: int) -> None:
            self.calls.append((fingerprint, duration))
            self.handoffs.append(second_worker.run_once())

    leader_client = LeaderClient()
    try:
        cursor = first_database.get_cursor()
        persist_fingerprint(cursor, "claim-track-a", {"fingerprint": "fp-a", "duration": 247})
        persist_fingerprint(cursor, "claim-track-b", {"fingerprint": "fp-b", "duration": 248})
        first_database.commit()
        cursor.close()

        leader = AcoustIDBackfill(
            first_database,
            "configured",
            client=leader_client,
            batch_size=1,
        )
        assert leader.run_once() is True
        assert leader_client.calls == [("fp-a", 247), ("fp-b", 248)]
        assert leader_client.handoffs == [False, False]
        assert second_client.calls == 0
    finally:
        first_database.close()
        second_database.close()
        _drop_test_schema(schema_name)
