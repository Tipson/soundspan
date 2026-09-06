"""Anonymous extraction reuse preserves fallback, expiry, and audio quality."""

import pytest
import yt_dlp


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


@pytest.mark.parametrize("mode", ["good", "challenge", "format", "combined", "timeout", "lossless"])
def test_fast_context_lookup_keeps_original_fallback(monkeypatch, mode):
    import ytmusic_anonymous_context as module

    context = module.VisitorContext()
    context.put("anonymous-only")
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
    if mode == "lossless":
        assert calls == ["normal"]
    elif mode == "good":
        assert len(calls) == 1 and not paced
        assert calls[0]["extractor_args"]["youtube"]["visitor_data"] == ["anonymous-only"]
        assert context.get() == "anonymous-only"
    else:
        assert len(calls) == 2 and calls[-1] == "normal"
        assert paced == [True]
        assert context.get() is None
    assert "extractor_args" not in options
