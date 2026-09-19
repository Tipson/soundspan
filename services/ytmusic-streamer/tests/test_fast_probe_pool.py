"""Anonymous CPU isolation retains audio and does not multiply recovery work."""

from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool

import pytest
import yt_dlp


def test_real_spawn_roundtrip_does_not_need_external_network():
    import ytmusic_fast_probe as probe

    try:
        probe.warm_fast_probes(workers=2)
        with pytest.raises(yt_dlp.utils.DownloadError, match="No suitable extractor"):
            probe.extract_fast(
                "not-a-supported-url", {"allowed_extractors": ["youtube"], "quiet": True}, workers=2
            )
    finally:
        pool = probe._pool
        probe.shutdown_fast_probes()
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)


@pytest.mark.parametrize("failure", [False, True])
def test_fast_probe_returns_minimal_audio_or_original_provider_error(monkeypatch, failure):
    import ytmusic_fast_probe as probe

    closed = []

    class Downloader:
        def __init__(self, _options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            closed.append(True)

        def add_info_extractor(self, _ie):
            pass

        def extract_info(self, _url, download=False):
            assert not download
            if failure:
                raise yt_dlp.utils.DownloadError("Sign in to confirm you're not a bot")
            return {
                "format_id": "251",
                "acodec": "opus",
                "vcodec": "none",
                "url": "https://cdn.test/a",
                "protocol": "https",
                "duration": 220,
                "captions": {"unused": []},
            }

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Downloader)
    if failure:
        with pytest.raises(yt_dlp.utils.DownloadError, match="not a bot"):
            probe.extract_fast("test", {}, workers=1)
    else:
        info = probe.extract_fast("test", {}, workers=1)
        assert info["acodec"] == "opus" and info["duration"] == 220 and "captions" not in info
    assert closed == [True]


def test_isolated_probe_uses_one_bounded_shared_pool_and_propagates_challenge(monkeypatch):
    import ytmusic_fast_probe as probe

    calls = []

    class Pool:
        def __init__(self, **kwargs):
            assert kwargs["max_workers"] == 8
            calls.append("created")

        def submit(self, operation, url, opts):
            assert operation is probe._probe_once
            calls.append(url)
            future = Future()
            future.set_result({"download_error": "Sign in to confirm you're not a bot"})
            return future

        def shutdown(self, **kwargs):
            assert kwargs == {"wait": False, "cancel_futures": True}
            calls.append("closed")

    monkeypatch.setattr(probe, "ProcessPoolExecutor", Pool)
    try:
        for _ in range(2):
            with pytest.raises(yt_dlp.utils.DownloadError, match="not a bot"):
                probe.extract_fast("one-attempt", {}, workers=1000)
    finally:
        probe.shutdown_fast_probes()
    assert calls == ["created", "one-attempt", "one-attempt", "closed"]


def test_startup_warms_bounded_workers_without_resolving_tracks(monkeypatch):
    import ytmusic_fast_probe as probe

    calls = []
    primed = []

    monkeypatch.setattr(probe, "_initialize_probe_worker", lambda: primed.append(True))

    class Pool:
        def __init__(self, **kwargs):
            assert primed, "Parent plugins must load before concurrent request constructors"
            assert kwargs["max_workers"] == 8
            assert kwargs["initializer"] is probe._initialize_probe_worker

        def submit(self, operation):
            assert operation is probe._probe_ready
            calls.append("ready")
            future = Future()
            future.set_result(True)
            return future

        def shutdown(self, **_kwargs):
            pass

    monkeypatch.setattr(probe, "ProcessPoolExecutor", Pool)
    probe.warm_fast_probes(workers=1)
    assert not calls and probe._pool is None
    try:
        probe.warm_fast_probes(workers=1000)
        assert len(calls) == 8
    finally:
        probe.shutdown_fast_probes()
    with pytest.raises(RuntimeError, match="shutting down"):
        probe.extract_fast("unused", {}, workers=2)


def test_crashed_worker_fails_current_request_and_next_request_gets_fresh_pool(monkeypatch):
    import ytmusic_fast_probe as probe

    pools = []
    calls = []

    class Pool:
        def __init__(self, **_kwargs):
            pools.append(self)

        def submit(self, _operation, url, _options):
            calls.append(url)
            result = Future()
            if len(pools) == 1:
                result.set_exception(BrokenProcessPool("controlled process exit"))
            else:
                result.set_result({"info": {"format_id": "251"}})
            return result

        def shutdown(self, **_kwargs):
            pass

    monkeypatch.setattr(probe, "ProcessPoolExecutor", Pool)
    try:
        with pytest.raises(BrokenProcessPool):
            probe.extract_fast("failed-once", {}, workers=2)
        assert probe.extract_fast("next-request", {}, workers=2) == {"format_id": "251"}
        assert calls == ["failed-once", "next-request"]
        assert len(pools) == 2
    finally:
        probe.shutdown_fast_probes()
