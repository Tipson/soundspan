"""Resolve analyzed online recordings to durable MusicBrainz identity."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Protocol

from acoustid_backfill import AcoustIDBackfill
from acoustid_lookup import AcoustIDCandidate, AcoustIDClient, AcoustIDLookupError

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("CanonicalAcoustIDBackfill")

DEFAULT_LOOKUP_BATCH_SIZE = 10
MAX_LOOKUP_BATCHES_PER_PASS = 1000
MAX_LOOKUP_RETRIES = 3
STALE_LOOKUP_MINUTES = 15
LOOKUP_OWNER_KEY = "soundspan:canonical-acoustid-lookup"


def _never_stop() -> bool:
    """Provide the default continuation signal for synchronous callers."""
    return False


ACQUIRE_LOOKUP_OWNER_SQL = """
    SELECT
        pg_try_advisory_lock(hashtextextended(%s, 0)) AS acquired,
        pg_backend_pid() AS backend_pid
"""
CURRENT_BACKEND_PID_SQL = "SELECT pg_backend_pid() AS backend_pid"
RELEASE_LOOKUP_OWNER_SQL = """
    SELECT pg_advisory_unlock(hashtextextended(%s, 0)) AS released
"""
CLAIM_LOOKUPS_SQL = """
    SELECT id, fingerprint, duration
    FROM "CanonicalRecording"
    WHERE fingerprint IS NOT NULL
      AND "recordingMbid" IS NULL
      AND (
          "identityLookupStatus" = 'pending'
          OR (
              "identityLookupStatus" = 'processing'
              AND "identityLookupUpdatedAt" < NOW() - (%s * INTERVAL '1 minute')
          )
      )
      AND "identityLookupRetryCount" < %s
    ORDER BY "analyzedAt" ASC NULLS LAST, "updatedAt" ASC
    LIMIT %s
    FOR UPDATE SKIP LOCKED
"""
MARK_CLAIMED_SQL = """
    UPDATE "CanonicalRecording"
    SET "identityLookupStatus" = 'processing',
        "identityLookupUpdatedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = ANY(%s)
      AND "identityLookupStatus" IN ('pending', 'processing')
    RETURNING id
"""
FIND_EXISTING_MBID_SQL = """
    SELECT id
    FROM "CanonicalRecording"
    WHERE "recordingMbid" = %s
      AND id <> %s
    LIMIT 1
"""
LOCK_IDENTITY_SQL = """
    SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))
"""
MERGE_CANONICAL_FEATURES_SQL = """
    UPDATE "CanonicalRecording" AS target
    SET fingerprint = COALESCE(target.fingerprint, source.fingerprint),
        bpm = COALESCE(target.bpm, source.bpm),
        key = COALESCE(target.key, source.key),
        energy = COALESCE(target.energy, source.energy),
        loudness = COALESCE(target.loudness, source.loudness),
        valence = COALESCE(target.valence, source.valence),
        danceability = COALESCE(target.danceability, source.danceability),
        arousal = COALESCE(target.arousal, source.arousal),
        instrumentalness = COALESCE(target.instrumentalness, source.instrumentalness),
        acousticness = COALESCE(target.acousticness, source.acousticness),
        speechiness = COALESCE(target.speechiness, source.speechiness),
        "moodTags" = CASE
            WHEN cardinality(target."moodTags") = 0 THEN source."moodTags"
            ELSE target."moodTags"
        END,
        "essentiaGenres" = CASE
            WHEN cardinality(target."essentiaGenres") = 0 THEN source."essentiaGenres"
            ELSE target."essentiaGenres"
        END,
        "analysisStatus" = CASE
            WHEN target."analysisStatus" <> 'completed'
             AND source."analysisStatus" = 'completed'
                THEN 'completed'
            ELSE target."analysisStatus"
        END,
        "analysisVersion" = CASE
            WHEN target."analysisStatus" <> 'completed'
             AND source."analysisStatus" = 'completed'
                THEN source."analysisVersion"
            ELSE target."analysisVersion"
        END,
        "analyzedAt" = CASE
            WHEN target."analysisStatus" <> 'completed'
             AND source."analysisStatus" = 'completed'
                THEN source."analyzedAt"
            ELSE target."analyzedAt"
        END,
        "analysisError" = CASE
            WHEN source."analysisStatus" = 'completed' THEN NULL
            ELSE target."analysisError"
        END,
        "embeddingStatus" = CASE
            WHEN target."embeddingStatus" <> 'completed'
             AND source."embeddingStatus" = 'completed'
                THEN 'completed'
            ELSE target."embeddingStatus"
        END,
        "embeddingVersion" = CASE
            WHEN target."embeddingStatus" <> 'completed'
             AND source."embeddingStatus" = 'completed'
                THEN source."embeddingVersion"
            ELSE target."embeddingVersion"
        END,
        "embeddingAnalyzedAt" = CASE
            WHEN target."embeddingStatus" <> 'completed'
             AND source."embeddingStatus" = 'completed'
                THEN source."embeddingAnalyzedAt"
            ELSE target."embeddingAnalyzedAt"
        END,
        "embeddingError" = CASE
            WHEN source."embeddingStatus" = 'completed' THEN NULL
            ELSE target."embeddingError"
        END,
        "updatedAt" = NOW()
    FROM "CanonicalRecording" AS source
    WHERE source.id = %s
      AND target.id = %s
"""
COPY_CANONICAL_EMBEDDINGS_SQL = """
    INSERT INTO canonical_recording_embeddings (
        canonical_recording_id,
        space_id,
        embedding,
        analyzed_at
    )
    SELECT %s, space_id, embedding, analyzed_at
    FROM canonical_recording_embeddings
    WHERE canonical_recording_id = %s
    ON CONFLICT (canonical_recording_id, space_id) DO NOTHING
"""
REPOINT_MAPPINGS_SQL = """
    UPDATE "TrackMapping"
    SET "canonicalRecordingId" = %s,
        "updatedAt" = NOW()
    WHERE "canonicalRecordingId" = %s
"""
SAVE_LOOKUP_SQL = """
    UPDATE "CanonicalRecording"
    SET "recordingMbid" = %s,
        "identitySource" = 'acoustid',
        "identityConfidence" = GREATEST("identityConfidence", %s),
        "identityLookupStatus" = 'completed',
        "identityLookupError" = NULL,
        "identityLookupUpdatedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = %s
      AND fingerprint = %s
      AND "identityLookupStatus" = 'processing'
    RETURNING id
"""
SAVE_MERGED_SQL = """
    UPDATE "CanonicalRecording"
    SET "identitySource" = 'acoustid-merged',
        "identityConfidence" = GREATEST("identityConfidence", %s),
        "identityLookupStatus" = 'completed',
        "identityLookupError" = NULL,
        "identityLookupUpdatedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = %s
      AND fingerprint = %s
      AND "identityLookupStatus" = 'processing'
    RETURNING id
"""
SAVE_NO_MATCH_SQL = """
    UPDATE "CanonicalRecording"
    SET "identityLookupStatus" = 'completed',
        "identityLookupError" = NULL,
        "identityLookupUpdatedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = %s
      AND fingerprint = %s
      AND "identityLookupStatus" = 'processing'
    RETURNING id
"""
SAVE_LOOKUP_FAILURE_SQL = """
    UPDATE "CanonicalRecording"
    SET "identityLookupStatus" = CASE
            WHEN "identityLookupRetryCount" + 1 >= 3 THEN 'failed'
            ELSE 'pending'
        END,
        "identityLookupRetryCount" = "identityLookupRetryCount" + 1,
        "identityLookupError" = %s,
        "identityLookupUpdatedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = %s
      AND fingerprint = %s
      AND "identityLookupStatus" = 'processing'
    RETURNING id
"""


class _Cursor(Protocol):
    """Describe cursor operations used by canonical identity claims."""

    def execute(self, query: object, params: object = None) -> None: ...

    def fetchall(self) -> list[Mapping[str, Any]]: ...

    def fetchone(self) -> Mapping[str, Any] | None: ...

    def close(self) -> None: ...


class Database(Protocol):
    """Describe transaction operations used by canonical identity lookup."""

    def get_cursor(self) -> _Cursor: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


class LookupClient(Protocol):
    """Describe the shared bounded AcoustID client."""

    def lookup(self, fingerprint: str, duration: int) -> AcoustIDCandidate | None: ...


def _acquire_lookup_owner(database: Database) -> int | None:
    cursor = database.get_cursor()
    try:
        cursor.execute(ACQUIRE_LOOKUP_OWNER_SQL, (LOOKUP_OWNER_KEY,))
        row = cursor.fetchone()
        if row is None or row.get("acquired") is not True:
            database.commit()
            return None
        backend_pid = row.get("backend_pid")
        if not isinstance(backend_pid, int):
            raise RuntimeError("Canonical AcoustID owner query returned no backend PID")
        return backend_pid
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _current_backend_pid(database: Database) -> int:
    cursor = database.get_cursor()
    try:
        cursor.execute(CURRENT_BACKEND_PID_SQL)
        row = cursor.fetchone()
        backend_pid = row.get("backend_pid") if row is not None else None
        if not isinstance(backend_pid, int):
            raise RuntimeError("Canonical AcoustID session query returned no backend PID")
        return backend_pid
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _release_lookup_owner(database: Database) -> None:
    cursor = database.get_cursor()
    try:
        cursor.execute(RELEASE_LOOKUP_OWNER_SQL, (LOOKUP_OWNER_KEY,))
        database.commit()
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _claim_batch(database: Database, batch_size: int) -> list[Mapping[str, Any]]:
    cursor = database.get_cursor()
    try:
        cursor.execute(
            CLAIM_LOOKUPS_SQL,
            (STALE_LOOKUP_MINUTES, MAX_LOOKUP_RETRIES, batch_size),
        )
        rows = cursor.fetchall()
        if not rows:
            database.commit()
            return []
        ids = [row["id"] for row in rows]
        cursor.execute(MARK_CLAIMED_SQL, (ids,))
        claimed_ids = {row["id"] for row in cursor.fetchall()}
        database.commit()
        return [row for row in rows if row["id"] in claimed_ids]
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _save_completed(
    database: Database,
    canonical_id: str,
    fingerprint: str,
    candidate: AcoustIDCandidate | None,
) -> bool:
    cursor = database.get_cursor()
    try:
        if candidate is None:
            cursor.execute(SAVE_NO_MATCH_SQL, (canonical_id, fingerprint))
        else:
            recording_mbid = candidate["recordingMbid"]
            confidence = float(candidate["score"])
            # Serialize MBID promotion with the TypeScript online identity path.
            # The lock lasts only for this transaction and prevents duplicate
            # canonical rows from racing through the unique MBID constraint.
            cursor.execute(LOCK_IDENTITY_SQL, (recording_mbid,))
            cursor.execute(FIND_EXISTING_MBID_SQL, (recording_mbid, canonical_id))
            existing = cursor.fetchone()
            target_id = existing.get("id") if existing is not None else None
            if isinstance(target_id, str) and target_id:
                cursor.execute(
                    MERGE_CANONICAL_FEATURES_SQL,
                    (canonical_id, target_id),
                )
                cursor.execute(
                    COPY_CANONICAL_EMBEDDINGS_SQL,
                    (target_id, canonical_id),
                )
                cursor.execute(REPOINT_MAPPINGS_SQL, (target_id, canonical_id))
                cursor.execute(
                    SAVE_MERGED_SQL,
                    (confidence, canonical_id, fingerprint),
                )
            else:
                cursor.execute(
                    SAVE_LOOKUP_SQL,
                    (recording_mbid, confidence, canonical_id, fingerprint),
                )
        saved = cursor.fetchone() is not None
        database.commit()
        return saved
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _save_failure(
    database: Database,
    canonical_id: str,
    fingerprint: str,
    error: Exception,
) -> bool:
    cursor = database.get_cursor()
    try:
        cursor.execute(
            SAVE_LOOKUP_FAILURE_SQL,
            (type(error).__name__, canonical_id, fingerprint),
        )
        saved = cursor.fetchone() is not None
        database.commit()
        return saved
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


class CanonicalAcoustIDBackfill:
    """Claim and resolve fingerprints produced from temporary online audio."""

    def __init__(
        self,
        database: Database,
        api_key: str,
        *,
        client: LookupClient | None = None,
        batch_size: int = DEFAULT_LOOKUP_BATCH_SIZE,
    ) -> None:
        self._database = database
        self._enabled = bool(api_key)
        self._client = client or (AcoustIDClient(api_key) if api_key else None)
        self._batch_size = max(1, min(100, batch_size))

    def run_once(self, stop_requested: Callable[[], bool] = _never_stop) -> bool:
        """Drain one bounded canonical lookup pass under a deployment lock."""
        if not self._enabled:
            return False
        if self._client is None:
            raise RuntimeError("enabled canonical AcoustID backfill requires a client")
        owner_pid = _acquire_lookup_owner(self._database)
        if owner_pid is None:
            return False
        ownership_lost = False
        try:
            found_work, ownership_lost = self._run_owned_pass(owner_pid, stop_requested)
            return found_work
        finally:
            if not ownership_lost:
                _release_lookup_owner(self._database)

    def _run_owned_pass(
        self,
        owner_pid: int,
        stop_requested: Callable[[], bool],
    ) -> tuple[bool, bool]:
        found_work = False
        for _ in range(MAX_LOOKUP_BATCHES_PER_PASS):
            if stop_requested():
                return found_work, False
            if _current_backend_pid(self._database) != owner_pid:
                logger.warning("Canonical AcoustID owner session changed; aborting pass")
                return found_work, True
            rows = _claim_batch(self._database, self._batch_size)
            if not rows:
                return found_work, False
            found_work = True
            completed, failed = self._process_rows(rows, stop_requested)
            logger.info(
                "Canonical AcoustID batch complete: %s claimed, %s completed, %s failed",
                len(rows),
                completed,
                failed,
            )
        logger.warning(
            "Canonical AcoustID pass reached its %s-batch limit",
            MAX_LOOKUP_BATCHES_PER_PASS,
        )
        return found_work, False

    def _process_rows(
        self,
        rows: list[Mapping[str, Any]],
        stop_requested: Callable[[], bool],
    ) -> tuple[int, int]:
        if self._client is None:
            raise RuntimeError("enabled canonical AcoustID backfill requires a client")
        completed = 0
        failed = 0
        for row in rows:
            if stop_requested():
                break
            canonical_id = str(row["id"])
            fingerprint = str(row["fingerprint"])
            try:
                candidate = self._client.lookup(fingerprint, int(row["duration"]))
                if _save_completed(self._database, canonical_id, fingerprint, candidate):
                    completed += 1
            except AcoustIDLookupError as error:
                if _save_failure(self._database, canonical_id, fingerprint, error):
                    failed += 1
        return completed, failed


class CombinedAcoustIDBackfill:
    """Share one rate limiter across local and online fingerprint identity."""

    def __init__(self, database: Database, api_key: str) -> None:
        client = AcoustIDClient(api_key) if api_key else None
        self._track = AcoustIDBackfill(database, api_key, client=client)
        self._canonical = CanonicalAcoustIDBackfill(database, api_key, client=client)

    def run_once(self, stop_requested: Callable[[], bool] = _never_stop) -> bool:
        """Process local and online fingerprints on one bounded client."""
        track_work = self._track.run_once(stop_requested)
        if stop_requested():
            return track_work
        return self._canonical.run_once(stop_requested) or track_work
