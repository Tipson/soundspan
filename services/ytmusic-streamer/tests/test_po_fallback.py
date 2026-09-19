"""One optional token probe, preserving cancellation and extraction limits."""

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from yt_dlp.utils import DownloadError

CHALLENGE = "Sign in to confirm you're not a bot"


@pytest.fixture()
def fallback(monkeypatch: pytest.MonkeyPatch) -> Any:
    import ytmusic_po_fallback as module

    monkeypatch.setattr(module, "provider_available", lambda: True)
    return module.PoFallback()


def fail() -> Any:
    raise DownloadError(CHALLENGE)


def test_successful_primary_never_requests_token(fallback: Any) -> None:
    assert fallback.run(lambda: "audio", lambda: pytest.fail("unneeded PO")) == "audio"


@pytest.mark.parametrize(
    "message", ["Private video", "Sign in to confirm your age", "403 Forbidden"]
)
def test_only_bot_challenge_is_eligible(fallback: Any, message: str) -> None:
    def primary() -> None:
        raise DownloadError(message)

    with pytest.raises(DownloadError, match=message):
        fallback.run(primary, lambda: pytest.fail("not a bot challenge"))


def test_missing_plugin_preserves_original_error(
    fallback: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import ytmusic_po_fallback as module

    monkeypatch.setattr(module, "provider_available", lambda: False)
    with pytest.raises(DownloadError, match="not a bot"):
        fallback.run(fail, lambda: pytest.fail("plugin unavailable"))


def test_successful_probe_returns_audio_and_releases_slot(fallback: Any) -> None:
    assert fallback.run(fail, lambda: "first") == "first"
    assert fallback.run(fail, lambda: "second") == "second"


def test_failure_arms_cooldown_without_retrying(
    fallback: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import ytmusic_po_fallback as module

    clock = [100.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    calls = []

    def probe() -> None:
        calls.append(1)
        raise DownloadError("token endpoint failed")

    with pytest.raises(DownloadError, match="not a bot"):
        fallback.run(fail, probe)
    with pytest.raises(module.FallbackDeferred) as error:
        fallback.run(fail, probe)
    assert error.value.retry_after == 90
    assert calls == [1]
    clock[0] += 91
    assert fallback.run(fail, lambda: "recovered") == "recovered"


def test_concurrent_challenges_share_one_probe(fallback: Any) -> None:
    from ytmusic_po_fallback import FallbackDeferred

    entered, release = threading.Event(), threading.Event()

    def probe() -> str:
        entered.set()
        assert release.wait(2)
        return "audio"

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(fallback.run, fail, probe)
        assert entered.wait(1)
        try:
            with pytest.raises(FallbackDeferred):
                fallback.run(fail, lambda: pytest.fail("concurrent probe"))
        finally:
            release.set()
        assert first.result(timeout=1) == "audio"


def test_cancelled_request_cannot_start_probe(fallback: Any) -> None:
    def cancelled() -> None:
        raise InterruptedError("abandoned")

    with pytest.raises(InterruptedError):
        fallback.run(fail, lambda: pytest.fail("cancelled probe"), check=cancelled)


@pytest.mark.anyio
async def test_timed_out_metadata_does_not_launch_late_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    import ytmusic_po_fallback as module
    import ytmusic_stream as stream
    from fastapi import HTTPException

    monkeypatch.setattr(module, "provider_available", lambda: True)
    monkeypatch.setattr(stream, "EXTRACT_TIMEOUT", 0.03)
    release, finished = threading.Event(), threading.Event()
    probes = []

    def primary() -> None:
        release.wait(2)
        raise DownloadError(CHALLENGE)

    class Downloader:
        def __init__(self, *_args: Any) -> None:
            probes.append(1)
            pytest.fail("request has timed out")

    import yt_dlp

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Downloader)

    def work() -> Any:
        try:
            return stream._extract_with_po_fallback(primary, "url", {}, "video", download=False)
        finally:
            finished.set()

    try:
        with pytest.raises(HTTPException) as error:
            await stream._extract_stream_info_bounded(work)
        assert error.value.status_code == 504
    finally:
        release.set()
    assert await asyncio.to_thread(finished.wait, 1)
    assert probes == []


def test_options_preserve_audio_limits_without_mutating_primary() -> None:
    from ytmusic_po_fallback import token_options

    def hook(_event: Any) -> None:
        pass

    options = {
        "format": "audio-under-byte-limit",
        "progress_hooks": [hook],
        "socket_timeout": 20,
        "outtmpl": "owned.%(ext)s",
        "extractor_args": {"youtube": {"player_client": ["visionos"], "skip": ["webpage", "hls"]}},
    }
    result = token_options(options)
    assert result["format"] == options["format"]
    assert result["progress_hooks"][0] is hook
    assert result["outtmpl"] == options["outtmpl"]
    assert result["extractor_args"]["youtube"] == {"player_client": ["mweb"]}
    assert result["retries"] == result["extractor_retries"] == result["fragment_retries"] == 0
    assert options["extractor_args"]["youtube"]["player_client"] == ["visionos"]


@pytest.mark.parametrize("spool", [False, True])
def test_stream_and_spool_recover_only_once(monkeypatch: pytest.MonkeyPatch, spool: bool) -> None:
    import yt_dlp
    import ytmusic_po_fallback as module
    import ytmusic_stream as stream

    monkeypatch.setattr(module, "provider_available", lambda: True)
    monkeypatch.setattr(stream, "_po_fallback", module.PoFallback())
    monkeypatch.setattr(stream._extract_pacer, "wait", lambda: None)
    monkeypatch.setattr(stream, "_ensure_player_cache", lambda: None)
    calls = []

    class Downloader:
        def __init__(self, options: Any) -> None:
            self.options = options

        def __enter__(self) -> Any:
            return self

        def __exit__(self, *_args: Any) -> None:
            pass

        def extract_info(self, _url: str, download: bool) -> Any:
            calls.append(self.options["extractor_args"]["youtube"]["player_client"])
            assert download == spool
            if len(calls) == 1:
                assert self.options["extractor_args"]["youtube"]["fetch_pot"] == ["never"]
                raise DownloadError(CHALLENGE)
            return {"url": "https://cdn.example/audio", "acodec": "opus", "vcodec": "none"}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Downloader)
    opts = {"extractor_args": {"youtube": {"player_client": ["visionos"]}}}
    if spool:
        result = stream._extract_spool_with_retry("video", opts, None)
    else:
        result = stream._extract_stream_info(
            "yt:video", "https://www.youtube.com/watch?v=video", opts, "video", "test"
        )
    assert result["acodec"] == "opus"
    assert calls == [["visionos"], ["mweb"]]
