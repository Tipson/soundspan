"""Bounded solver fallback must retain actual worker ownership and deadlines."""

import importlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import ModuleType, SimpleNamespace
from typing import Any, Literal

import pytest
from yt_dlp.utils import DownloadError


@pytest.fixture()
def fallback(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    """Isolate the process-wide solver budget without mocking worker execution."""
    from ytmusic_extraction_budget import ExtractionBudget

    module = importlib.import_module("ytmusic_js_fallback")
    monkeypatch.setattr(module, "JS_CLIENT_FALLBACK_ENABLED", True)
    monkeypatch.setattr(module, "_JS_FALLBACK_BUDGET", ExtractionBudget(1))
    return module


def _primary_failure() -> Any:
    raise DownloadError("Requested format is not available")


def test_flag_defaults_off_and_rejects_unknown_values() -> None:
    """Only explicit opt-in values may enable a JavaScript player."""
    module = importlib.import_module("ytmusic_js_fallback")
    assert module.parse_bool_flag(None) is False
    assert module.parse_bool_flag("invalid") is False
    assert module.parse_bool_flag("0") is False
    assert module.parse_bool_flag(" true ") is True


def test_disabled_fallback_preserves_original_error(
    fallback: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A normal install must not start solver work after a provider failure."""
    monkeypatch.setattr(fallback, "JS_CLIENT_FALLBACK_ENABLED", False)
    called = []
    with pytest.raises(DownloadError):
        fallback.run_with_js_fallback(
            _primary_failure,
            lambda: called.append(True),
            label="track",
            deadline=time.monotonic() + 1,
        )
    assert called == []


def test_primary_success_does_not_start_fallback(fallback: ModuleType) -> None:
    """Opt-in must not add solver work to successful ordinary extraction."""
    calls = []
    result = fallback.run_with_js_fallback(
        lambda: "ordinary",
        lambda: calls.append(True),
        label="track",
        deadline=time.monotonic() + 1,
    )
    assert result == "ordinary"
    assert calls == []


@pytest.mark.parametrize(
    "failure_kind", ["age", "limit", "transport", "transport-flat", "rate-limit", "cancel"]
)
def test_policy_and_abandonment_failures_do_not_retry(
    fallback: ModuleType, failure_kind: str
) -> None:
    """Wrapped policy failures must not become another network/solver attempt."""
    from ytmusic_extraction_budget import ExtractionAbandoned

    errors = {
        "age": DownloadError("Sign in to confirm your age"),
        "limit": fallback.SpoolLimitExceeded("downloaded bytes exceeded"),
        "transport": TimeoutError("upstream socket timed out"),
        "transport-flat": DownloadError("Connection timed out"),
        "rate-limit": DownloadError("HTTP Error 429: Too Many Requests"),
        "cancel": ExtractionAbandoned("request cancelled"),
    }
    wrapped = DownloadError("outer extraction failure")
    wrapped.__cause__ = errors[failure_kind]
    calls = []

    def fail() -> Any:
        raise wrapped

    with pytest.raises(DownloadError) as received:
        fallback.run_with_js_fallback(
            fail, lambda: calls.append(True), label="track", deadline=time.monotonic() + 1
        )
    assert received.value is wrapped
    assert calls == []


def test_one_fallback_failure_releases_slot_without_another_retry(fallback: ModuleType) -> None:
    """A failed solver is propagated once and leaves the next request admissible."""
    failure = DownloadError("solver failed")
    calls = []

    def fail() -> Any:
        calls.append("fallback")
        raise failure

    with pytest.raises(DownloadError) as received:
        fallback.run_with_js_fallback(
            _primary_failure, fail, label="first", deadline=time.monotonic() + 1
        )
    assert received.value is failure
    assert (
        fallback.run_with_js_fallback(
            _primary_failure, lambda: "next", label="next", deadline=time.monotonic() + 1
        )
        == "next"
    )
    assert calls == ["fallback"]


@pytest.mark.parametrize("link", ["cause", "__cause__", "__context__", "exc_info"])
def test_typed_request_error_chain_never_enters_solver(fallback: ModuleType, link: str) -> None:
    """yt-dlp's own RequestError is not an OSError and may use its cause attribute."""
    from yt_dlp.networking.exceptions import RequestError

    transport = RequestError("terminal delivery failure")
    wrapper = RuntimeError("upstream wrapper")
    setattr(wrapper, link, (None, transport, None) if link == "exc_info" else transport)
    original = DownloadError("outer extraction failure")
    original.__cause__ = wrapper
    calls = []

    def fail() -> Any:
        raise original

    with pytest.raises(DownloadError) as received:
        fallback.run_with_js_fallback(
            fail, lambda: calls.append(True), label="typed", deadline=time.monotonic() + 1
        )
    assert received.value is original
    assert calls == []


def test_expired_request_does_not_start_extraction(fallback: ModuleType) -> None:
    """The fallback path cannot reset a caller's already exhausted deadline."""
    from ytmusic_extraction_budget import ExtractionAbandoned

    calls = []
    with pytest.raises(ExtractionAbandoned):
        fallback.run_with_js_fallback(
            lambda: calls.append("primary"),
            lambda: calls.append("fallback"),
            label="expired",
            deadline=time.monotonic() - 1,
        )
    assert calls == []


def test_cancelled_active_worker_retains_solver_slot_until_it_exits(fallback: ModuleType) -> None:
    """Cancelling an owner cannot overlap a replacement with its still-running solver."""
    from ytmusic_extraction_budget import ExtractionAbandoned

    entered = threading.Event()
    release = threading.Event()
    cancelled = threading.Event()
    replacement_started = threading.Event()

    def blocked() -> str:
        entered.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test solver was not released")
        return "abandoned"

    def replacement() -> str:
        replacement_started.set()
        return "replacement"

    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(
            fallback.run_with_js_fallback,
            _primary_failure,
            blocked,
            label="first",
            deadline=time.monotonic() + 2,
            cancel_event=cancelled,
        )
        try:
            assert entered.wait(timeout=1)
            cancelled.set()
            second = workers.submit(
                fallback.run_with_js_fallback,
                _primary_failure,
                replacement,
                label="second",
                deadline=time.monotonic() + 2,
                priority=lambda: 2,
            )
            budget = fallback._JS_FALLBACK_BUDGET
            with budget._condition:
                assert budget._condition.wait_for(
                    lambda: budget._priority_waiters[2] == 1, timeout=1
                )
            assert not replacement_started.is_set()
            release.set()
            with pytest.raises(ExtractionAbandoned):
                first.result(timeout=1)
            assert second.result(timeout=1) == "replacement"
        finally:
            release.set()


def test_solver_queue_preserves_playback_preload_background_order(fallback: ModuleType) -> None:
    """Queued solver attempts reuse the existing priority policy within their one slot."""
    entered = threading.Event()
    release = threading.Event()
    order = []

    def hold() -> str:
        entered.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test solver was not released")
        return "first"

    with ThreadPoolExecutor(max_workers=4) as workers:
        first = workers.submit(
            fallback.run_with_js_fallback,
            _primary_failure,
            hold,
            label="first",
            deadline=time.monotonic() + 3,
        )
        try:
            assert entered.wait(timeout=1)
            waiting = [
                workers.submit(
                    fallback.run_with_js_fallback,
                    _primary_failure,
                    lambda level=level: order.append(level),
                    label=str(level),
                    deadline=time.monotonic() + 3,
                    priority=lambda level=level: level,
                )
                for level in (0, 1, 2)
            ]
            budget = fallback._JS_FALLBACK_BUDGET
            with budget._condition:
                assert budget._condition.wait_for(
                    lambda: budget._priority_waiters == [1, 1, 1], timeout=1
                )
            release.set()
            assert first.result(timeout=1) == "first"
            for request in waiting:
                request.result(timeout=1)
        finally:
            release.set()
    assert order == [2, 1, 0]


@pytest.mark.parametrize("spool", [False, True])
def test_stream_paths_use_exactly_one_opt_in_client_recovery(
    fallback: ModuleType, monkeypatch: pytest.MonkeyPatch, spool: bool
) -> None:
    """The real stream boundary changes only client/JS policy for its single recovery."""
    import yt_dlp
    import ytmusic_stream as stream

    captured = []
    extraction_calls = []

    class Extractor:
        def __init__(self, options: dict[str, Any]) -> None:
            self.options = options
            captured.append(options)

        def __enter__(self) -> Any:
            return self

        def __exit__(self, *_args: Any) -> Literal[False]:
            return False

        def extract_info(self, _url: str, *, download: bool) -> dict[str, Any]:
            extraction_calls.append(download)
            if not self.options.get("js_runtimes"):
                raise DownloadError("ordinary client cannot resolve audio")
            return {"url": "https://audio.test/recovered", "ext": "webm", "vcodec": "none"}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Extractor)
    monkeypatch.setattr(stream, "_wait_for_provider", lambda _video: None)
    stream._stream_cache.clear()
    if spool:

        def hook(_status: Any) -> None:
            pass

        options = stream._build_ytmusic_spool_options(
            "dQw4w9WgXcQ", "HIGH", match_filter=lambda *_args: None, progress_hook=hook
        )
        result = stream._extract_spool_with_retry("dQw4w9WgXcQ", options, threading.Event())
        assert captured[-1]["progress_hooks"] == [hook]
        assert captured[-1]["outtmpl"] == options["outtmpl"]
    else:
        result = stream._get_stream_url_sync("__public__", "dQw4w9WgXcQ", "HIGH")
    assert result["url"] == "https://audio.test/recovered"
    assert extraction_calls == [spool, spool]
    assert captured[0]["js_runtimes"] == {}
    assert captured[-1]["js_runtimes"] == {"deno": {}}
    assert "-tv_samsung" not in captured[-1]["extractor_args"]["youtube"]["player_client"]


def test_metadata_recovery_keeps_original_request_deadline(
    fallback: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An expired metadata owner must never start another ordinary or JS lookup."""
    import yt_dlp
    import ytmusic_stream as stream
    from ytmusic_extraction_budget import ExtractionAbandoned

    calls = []

    class Extractor:
        def __init__(self, _options: Any) -> None:
            pass

        def __enter__(self) -> Any:
            return self

        def __exit__(self, *_args: Any) -> Literal[False]:
            return False

        def extract_info(self, *_args: Any, **_kwargs: Any) -> Any:
            calls.append(True)
            raise DownloadError("ordinary client cannot resolve audio")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Extractor)
    monkeypatch.setattr(stream, "_wait_for_provider", lambda _video: None)
    monkeypatch.setattr(
        stream._metadata_worker_context, "deadline", time.monotonic() - 1, raising=False
    )
    stream._stream_cache.clear()
    with pytest.raises(ExtractionAbandoned):
        stream._get_stream_url_sync("__public__", "dQw4w9WgXcQ", "HIGH")
    assert calls == []


@pytest.mark.anyio
async def test_spool_worker_reuses_original_request_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Queued resolution and recovery share one owner deadline instead of a fresh download budget."""
    import ytmusic_stream as stream

    observed = []
    started = time.monotonic()
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_TIMEOUT", 0.5)

    def download(_video: str, _quality: str) -> tuple[str, str]:
        observed.append(stream._owned_extraction_deadline(download=True))
        return "completed.webm", "audio/webm"

    monkeypatch.setattr(stream, "_download_ytmusic_spool_sync", download)
    assert await stream._download_ytmusic_spool_bounded("dQw4w9WgXcQ", "HIGH") == (
        "completed.webm",
        "audio/webm",
    )
    assert started < observed[0] <= started + 0.6


@pytest.mark.anyio
async def test_exhausted_spool_deadline_is_not_reported_as_client_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A server-owned deadline must preserve timeout semantics for an active caller."""
    import ytmusic_stream as stream
    from fastapi import HTTPException

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_TIMEOUT", -1)
    with pytest.raises(HTTPException) as received:
        await stream._download_ytmusic_spool_bounded("dQw4w9WgXcQ", "HIGH")
    assert received.value.status_code == 504


def test_busy_solver_returns_original_error_within_its_bounded_wait(
    fallback: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The solver queue may not wait for the entire request budget when its own bound expires."""
    entered = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(fallback, "JS_FALLBACK_SLOT_WAIT_SECONDS", 0.01)

    def hold() -> str:
        entered.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test solver was not released")
        return "first"

    original = DownloadError("second primary failed")

    def fail_second() -> Any:
        raise original

    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(
            fallback.run_with_js_fallback,
            _primary_failure,
            hold,
            label="first",
            deadline=time.monotonic() + 3,
        )
        try:
            assert entered.wait(timeout=1)
            second = workers.submit(
                fallback.run_with_js_fallback,
                fail_second,
                lambda: "unexpected",
                label="second",
                deadline=time.monotonic() + 3,
            )
            with pytest.raises(DownloadError) as received:
                second.result(timeout=0.5)
            assert received.value is original
        finally:
            release.set()
        assert first.result(timeout=1) == "first"


def test_yt_dlp_exc_info_preserves_spool_limit_policy(fallback: ModuleType) -> None:
    """The upstream DownloadError wrapper must not hide a byte/time policy rejection."""
    import sys

    try:
        raise fallback.SpoolLimitExceeded("byte limit")
    except fallback.SpoolLimitExceeded:
        wrapped = DownloadError("wrapped extraction failure", exc_info=sys.exc_info())
    assert fallback.is_fallback_eligible(wrapped) is False


@pytest.mark.parametrize(
    "reason",
    [
        "Sign in to confirm your age",
        "This video is age-restricted",
        "This video may be inappropriate for some users",
        "age_verification_required",
        "age_check_required",
    ],
)
def test_upstream_age_gate_reasons_are_terminal_without_solver_recovery(
    fallback: ModuleType, reason: str
) -> None:
    """Actual upstream age-gate reasons must retain the original policy failure."""
    from yt_dlp.extractor.youtube import YoutubeIE

    assert YoutubeIE._is_agegated({"playabilityStatus": {"reason": reason}})
    failure = DownloadError(reason)
    calls = []

    def primary() -> Any:
        raise failure

    with pytest.raises(DownloadError) as received:
        fallback.run_with_js_fallback(
            primary,
            lambda: calls.append("solver-started"),
            label="age-policy",
            deadline=time.monotonic() + 1,
        )
    assert received.value is failure
    assert calls == []


@pytest.mark.parametrize("recovery", [False, True])
def test_completed_transfer_validation_does_not_renew_acquisition_deadline(
    fallback: ModuleType, monkeypatch: pytest.MonkeyPatch, recovery: bool
) -> None:
    """A transfer result uses its phase validator while every new attempt keeps its old deadline."""
    from ytmusic_extraction_budget import ExtractionAbandoned

    started = time.monotonic()
    now = [started]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: now[0]))
    validated = []

    def finish_transfer() -> str:
        now[0] = started + 150
        return "completed transfer"

    def validate_transfer() -> None:
        assert now[0] < started + 300
        validated.append(True)

    assert (
        fallback.run_with_js_fallback(
            _primary_failure if recovery else finish_transfer,
            finish_transfer,
            label="transfer",
            deadline=started + 110,
            check_result=validate_transfer,
        )
        == "completed transfer"
    )
    assert validated == [True]
    new_attempts = []
    with pytest.raises(ExtractionAbandoned):
        fallback.run_with_js_fallback(
            lambda: new_attempts.append(True),
            lambda: new_attempts.append(True),
            label="new acquisition",
            deadline=started + 110,
            check_result=validate_transfer,
        )
    assert new_attempts == []
