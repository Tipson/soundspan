"""A busy on-disk cache must not block the event loop's reader leases."""

import asyncio
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.anyio
async def test_reader_pins_do_not_wait_for_a_directory_sweep(tmp_path):
    import ytmusic_stream as stream

    path = tmp_path / "abcdefghijk-HIGH.webm"
    held = threading.Event()
    release = threading.Event()

    def sweep():
        with stream._spool_prune_lock:
            held.set()
            release.wait(0.5)

    worker = threading.Thread(target=sweep)
    worker.start()
    assert await asyncio.to_thread(held.wait, 2)
    session = stream._SpoolSession(
        "abcdefghijk:HIGH", asyncio.get_running_loop(), threading.Event(), allow_growing=True
    )
    try:
        started = time.monotonic()
        session.publish_readable(path, "audio/webm", 100)
        assert path in stream._spool_pinned_paths
        session.release_pins()
        elapsed = time.monotonic() - started
        assert path not in stream._spool_pinned_paths
        assert elapsed < 0.15, f"Reader blocked on directory maintenance for {elapsed:.3f}s"
    finally:
        release.set()
        await asyncio.to_thread(worker.join, 2)


def test_eviction_rechecks_a_pin_acquired_after_the_scan(tmp_path, monkeypatch):
    import ytmusic_stream as stream
    from fastapi import HTTPException

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_MAX_BYTES", 10)
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 6)
    path = tmp_path / "abcdefghijk-HIGH.webm"
    path.write_bytes(b"audio")
    original = stream._collect_spool_entries

    def scan_then_pin():
        snapshot = original()
        stream._pin_spool_path(path)
        return snapshot

    monkeypatch.setattr(stream, "_collect_spool_entries", scan_then_pin)
    try:
        with pytest.raises(HTTPException) as error:
            stream._reserve_spool_bytes()
        assert error.value.status_code == 503
        assert path.read_bytes() == b"audio"
        assert stream._spool_reserved_bytes == 0
    finally:
        stream._unpin_spool_path(path)


def test_directory_accounting_reuses_file_metadata(tmp_path, monkeypatch):
    import ytmusic_stream as stream

    path = tmp_path / "abcdefghijk-HIGH.webm"
    path.write_bytes(b"audio")
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    original_stat = Path.stat
    reads = {}

    def limited_stat(candidate, *args, **kwargs):
        if candidate.parent == tmp_path:
            reads[candidate] = reads.get(candidate, 0) + 1
            assert reads[candidate] <= 1, "The same inode was queried twice during one sweep"
        return original_stat(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", limited_stat)
    total, entries = stream._collect_spool_entries()
    assert total == 5
    assert [(size, candidate) for _, size, candidate in entries] == [(5, path)]


def test_completed_download_uses_one_budget_sweep_and_cached_read_uses_none(tmp_path, monkeypatch):
    import ytmusic_stream as stream

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    session = SimpleNamespace(cancel_event=threading.Event())
    completed = tmp_path / "abcdefghijk-HIGH.webm"
    sweeps = 0
    original = stream._collect_spool_entries

    def count_sweep():
        nonlocal sweeps
        sweeps += 1
        return original()

    def transfer(*args):
        assert stream._spool_reserved_bytes == stream._spool_track_byte_limit()
        completed.write_bytes(b"audio")
        return str(completed), "audio/webm", {}

    monkeypatch.setattr(stream, "_collect_spool_entries", count_sweep)
    monkeypatch.setattr(stream, "_download_progressive_spool_sync", transfer)
    monkeypatch.setattr(stream, "_cache_spool_info", lambda *args: None)
    result = stream._run_spool_download_sync("abcdefghijk", "HIGH", session)
    assert result == (str(completed), "audio/webm")
    assert stream._spool_reserved_bytes == 0
    assert sweeps == 1, "Redundant full-cache sweeps serialize independent cold starts"
    assert stream._run_spool_download_sync("abcdefghijk", "HIGH", session) == result
    assert sweeps == 1, "A ready-file lookup must not scan all cached inode sizes"
