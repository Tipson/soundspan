"""Anonymous extraction reuse preserves fallback, expiry, and audio quality."""

import pytest
import yt_dlp


def test_bootstrap_is_bounded_and_rejection_does_not_immediately_reload():
    from ytmusic_anonymous_context import VisitorContext

    now = [0.0]
    context = VisitorContext(clock=lambda: now[0])
    calls = []

    def load():
        calls.append(True)
        return "anonymous"

    context.bootstrap(load)
    assert context.get() == "anonymous"
    context.reject("anonymous")
    context.bootstrap(load)
    assert len(calls) == 1
    now[0] = 61
    context.bootstrap(load)
    assert context.get() == "anonymous" and len(calls) == 2


def test_bootstrap_failure_releases_lock_without_immediate_retry():
    from ytmusic_anonymous_context import VisitorContext

    now = [0.0]
    context = VisitorContext(clock=lambda: now[0])

    def fail():
        raise TimeoutError("controlled")

    with pytest.raises(TimeoutError):
        context.bootstrap(fail)
    context.bootstrap(lambda: pytest.fail("must back off"))
    now[0] = 61
    context.bootstrap(lambda: "recovered")
    assert context.get() == "recovered"


@pytest.mark.parametrize("fails", [False, True])
def test_public_bootstrap_always_closes_its_scoped_client(monkeypatch, fails):
    import ytmusic_anonymous_context as module
    import ytmusic_client as clients

    closed = []

    class Public:
        @property
        def base_headers(self):
            if fails:
                raise TimeoutError("controlled")
            return {"X-Goog-Visitor-Id": "public"}

    public = Public()
    monkeypatch.setattr(
        clients,
        "_create_public_ytmusic",
        lambda strategy, timeout: (
            public if strategy == "native" and timeout == 1.5 else pytest.fail("wrong budget")
        ),
    )
    monkeypatch.setattr(clients, "_close_owned_ytmusic_session", lambda value: closed.append(value))
    if fails:
        with pytest.raises(TimeoutError):
            module._load_public_context()
    else:
        assert module._load_public_context() == "public"
    assert closed == [public]


def test_capture_is_instance_local_and_only_success_is_retained(monkeypatch):
    import ytmusic_anonymous_context as module

    context = module.VisitorContext()
    monkeypatch.setattr(module, "_context", context)
    options = {"quiet": True, "format": "ba/bestaudio/b[height<=360]/b"}

    def normal(ydl, _url, _options):
        extractor = ydl.get_info_extractor("Youtube")
        assert extractor._extract_visitor_data({"VISITOR_DATA": "anonymous"}) == "anonymous"
        return {"url": "https://cdn.test/audio"}

    with yt_dlp.YoutubeDL(options) as ydl:
        module.extract_music(ydl, "unused", options, normal, lambda: None)
    assert context.get() == "anonymous"
    with yt_dlp.YoutubeDL(options) as separate:
        assert not isinstance(separate.get_info_extractor("Youtube"), module._CapturingYoutubeIE)


@pytest.mark.parametrize("boundary", ["account", "version"])
def test_account_and_unknown_version_use_only_ordinary_path(monkeypatch, boundary):
    import ytmusic_anonymous_context as module

    context = module.VisitorContext()
    context.put("anonymous")
    monkeypatch.setattr(module, "_context", context)
    if boundary == "version":
        monkeypatch.setattr(module, "__version__", "unknown")
    options = {"quiet": True, "format": "ba[abr<=256]/ba/b[height<=360]/b"}
    with yt_dlp.YoutubeDL(options) as ydl:
        if boundary == "account":
            options["username"] = "test-account"
        assert (
            module.extract_music(
                ydl, "unused", options, lambda *_args: "ordinary", lambda: pytest.fail("no retry")
            )
            == "ordinary"
        )
        assert not isinstance(ydl.get_info_extractor("Youtube"), module._CapturingYoutubeIE)
    assert context.get() == "anonymous"


def test_context_expiry_and_old_failure_do_not_erase_new_context():
    from ytmusic_anonymous_context import VisitorContext

    now = [0.0]
    context = VisitorContext(clock=lambda: now[0])
    context.put("old")
    assert context.get() == "old"
    context.put("new")
    context.reject("old")
    assert context.get() == "new"
    now[0] = 601
    assert context.get() is None
    context.put("next")
    context.reject("next")
    context.put("replacement")
    assert context.get() is None
    now[0] += 61
    assert context.get() == "replacement"


@pytest.mark.parametrize(
    "mode",
    [
        "good",
        "challenge",
        "format",
        "combined",
        "timeout",
        "lossless",
        "bootstrap",
        "bootstrap-fail",
    ],
)
def test_fast_context_lookup_keeps_original_fallback(monkeypatch, mode):
    import ytmusic_anonymous_context as module

    context = module.VisitorContext()
    if not mode.startswith("bootstrap"):
        context.put("anonymous-only")

    def bootstrap():
        if mode == "bootstrap-fail":
            raise TimeoutError("controlled bootstrap timeout")
        return "anonymous-only"

    monkeypatch.setattr(module, "_load_public_context", bootstrap)
    monkeypatch.setattr(module, "_context", context)
    options = {"format": "ba[abr<=256]/ba/b[height<=360]/b"}
    if mode == "lossless":
        options["format"] = "ba/bestaudio/b[height<=360]/b"
    calls = []
    paced = []
    original = {
        "format_id": "251",
        "acodec": "opus",
        "vcodec": "none",
        "protocol": "https",
        "url": "https://cdn.test/audio",
    }

    class FakeDL:
        def __init__(self, opts):
            self.params = opts
            self.cookiejar = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def add_info_extractor(self, extractor):
            self.extractor = extractor

        def extract_info(self, url, download=False):
            calls.append(self.params)
            assert not download
            if mode in ("challenge", "format", "timeout"):
                message = {
                    "challenge": "Sign in to confirm you're not a bot",
                    "format": "Requested format is not available",
                    "timeout": "Connection timed out",
                }[mode]
                raise yt_dlp.utils.DownloadError(message)
            return {**original, "vcodec": "h264"} if mode == "combined" else original

    def normal(ydl, url, opts):
        calls.append("normal")
        ydl.extractor.visitor = "fresh-anonymous"
        return original

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeDL)
    if mode == "timeout":
        with pytest.raises(yt_dlp.utils.DownloadError):
            module.extract_music(
                FakeDL(options),
                "https://music.youtube.com/watch?v=abcdefghijk",
                options,
                normal,
                lambda: paced.append(True),
            )
        assert len(calls) == 1
        return
    assert (
        module.extract_music(
            FakeDL(options),
            "https://music.youtube.com/watch?v=abcdefghijk",
            options,
            normal,
            lambda: paced.append(True),
        )
        == original
    )
    if mode in ("lossless", "bootstrap-fail"):
        assert calls == ["normal"]
    elif mode in ("good", "bootstrap"):
        assert len(calls) == 1 and not paced
        assert calls[0]["extractor_args"]["youtube"]["visitor_data"] == ["anonymous-only"]
        assert context.get() == "anonymous-only"
    else:
        assert len(calls) == 2 and calls[-1] == "normal"
        assert paced == [True]
        assert context.get() == (None if mode == "challenge" else "fresh-anonymous")
    assert "extractor_args" not in options
